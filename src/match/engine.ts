import { counterpartySimilarity, referenceSimilarity } from "../ingest/normalize";
import { daysBetween } from "../shared/money";

/**
 * ===========================================================================
 * THE MATCHING ENGINE
 * ===========================================================================
 *
 * Three stages, and the boundaries between them are the design:
 *
 *   BLOCKING     cheap, recall-only. Produces candidate pairs. Never decides.
 *   SCORING      deterministic features, one number per feature, no weights
 *                learned from anything. Never decides either.
 *   POLICY       the only place a decision is made. Reads the scores and the
 *                shape of the candidate set and returns RESOLVED, EXCEPTION or
 *                UNRESOLVED.
 *
 * The separation matters because the failure this system exists to avoid is a
 * confident wrong match. If scoring could resolve, then a high score on a pair
 * that has three equally good alternatives would resolve -- and that is exactly
 * the many-to-one case where being confident is the error. The policy sees the
 * whole candidate set for a record and can refuse on those grounds, which a
 * per-pair score can never do.
 */

/* -------------------------------------------------------------------------- */
/* Thresholds -- every one of them tuned, and labelled as such                */
/* -------------------------------------------------------------------------- */

export interface Thresholds {
  /** Above this, and unambiguous, a pair resolves. */
  resolve: number;
  /** Below this a pair is not worth a person's time; the record is unresolved. */
  floor: number;
  /** A second candidate within this much of the best makes the choice ambiguous. */
  ambiguityMargin: number;
  /** Days of value-date separation still considered the same event. */
  dateWindowDays: number;
  /** Fraction of gross that fee plus tax may plausibly account for. */
  feeToleranceFraction: number;
  /** Absolute minor-unit slack for rounding, on top of the fee tolerance. */
  roundingSlackMinor: number;
}

/**
 * Defaults.
 *
 * ALL SIX ARE TUNED, NOT DERIVED. They were set by running the corpus and
 * looking at where precision and recall crossed, which means they are fitted to
 * this corpus and would need re-fitting for any real ledger. The specific
 * reasoning:
 *
 *   resolve 0.82        below this the corpus starts producing false matches on
 *                       the reference-typo shape, which is the expensive error.
 *   floor 0.45          below this the candidate is noise; sending it to a human
 *                       wastes the queue, which is the other way this product
 *                       fails.
 *   ambiguityMargin .08 the many-to-one shape produces near-ties. Anything
 *                       tighter lets a coin-flip resolve.
 *   dateWindowDays 12   the corpus lags settlement by up to 11 days. A real
 *                       deployment would set this from its own T+n contract.
 *   feeTolerance 0.035  Razorpay-like fee plus 18% GST tops out near 2.95%;
 *                       3.5% leaves room without swallowing a real shortfall.
 *   roundingSlack 200   two rupees. Enough for paise rounding on a split, small
 *                       enough that a wrong amount stays wrong.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  resolve: 0.82,
  floor: 0.45,
  ambiguityMargin: 0.08,
  dateWindowDays: 12,
  feeToleranceFraction: 0.035,
  roundingSlackMinor: 200,
};

/* -------------------------------------------------------------------------- */
/* The record shape the engine works on                                       */
/* -------------------------------------------------------------------------- */

export interface MatchableRecord {
  id: string;
  kind: string;
  externalId: string;
  normalizedReference: string | null;
  normalizedCounterparty: string | null;
  amountMinor: number;
  feeMinor: number;
  taxMinor: number;
  currency: string;
  valueDate: Date;
}

/* -------------------------------------------------------------------------- */
/* Stage 1: blocking                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Blocking keys.
 *
 * A record gets several keys and is compared only against records sharing one.
 * This is recall-only by design: a missed block is a missed match forever, so
 * the keys are deliberately loose and overlapping, and precision is left
 * entirely to scoring.
 *
 * Without blocking this is O(n^2) -- 500 records is 125,000 pairs, and each pair
 * costs a Levenshtein. With it the corpus produces a few thousand candidates.
 * The cost is stated on the run page as a candidate count, so a blocking scheme
 * that has quietly stopped generating candidates is visible rather than
 * appearing as a matcher that has become fast.
 */
export function blockingKeys(record: MatchableRecord): string[] {
  const keys: string[] = [];

  if (record.normalizedReference) {
    keys.push("ref:" + record.normalizedReference);
    // A prefix key catches truncation, which exact-reference blocking misses
    // entirely -- and truncation is the single most common bank corruption.
    if (record.normalizedReference.length >= 6) {
      keys.push("refp:" + record.normalizedReference.slice(0, 6));
    }
  }

  // Amount buckets at 1% width. A settlement net of fees lands in a nearby
  // bucket, not the same one, so two adjacent buckets are emitted.
  const bucket = Math.round(Math.log(Math.max(1, record.amountMinor)) * 100);
  keys.push("amt:" + bucket);
  keys.push("amt:" + (bucket - 1));

  if (record.normalizedCounterparty) {
    const day = Math.floor(record.valueDate.getTime() / 86_400_000);
    // Counterparty plus a three-day window. This is the key that catches a
    // reference mangled beyond recognition.
    keys.push("cpd:" + record.normalizedCounterparty + ":" + Math.floor(day / 3));
  }

  return keys;
}

/* -------------------------------------------------------------------------- */
/* Stage 2: scoring                                                           */
/* -------------------------------------------------------------------------- */

export interface Features {
  reference: number;
  amount: number;
  date: number;
  counterparty: number;
  crossSource: number;
}

/**
 * Feature weights.
 *
 * Hand-set, not learned. Reference dominates because a matching reference is
 * near-conclusive; amount is next because it is the field a controller checks;
 * date and counterparty are corroborating rather than deciding. There is no
 * training set here and inventing one from the same generator that produced the
 * corpus would be fitting the model to its own author.
 */
const WEIGHTS: Features = {
  reference: 0.44,
  amount: 0.31,
  date: 0.11,
  counterparty: 0.14,
  crossSource: 0,
};

export function score(
  left: MatchableRecord,
  right: MatchableRecord,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): { score: number; features: Features } {
  const reference = referenceSimilarity(left.normalizedReference, right.normalizedReference);
  const counterparty = counterpartySimilarity(left.normalizedCounterparty, right.normalizedCounterparty);

  /*
    Amount agreement is not |a - b| < epsilon.

    A settlement is the order amount minus a fee minus GST on that fee, so the
    two numbers are SUPPOSED to differ, and by a predictable fraction. The
    feature scores full marks when the gap is explainable as a fee, decays
    linearly to zero at three times the fee tolerance, and is zero beyond that.
    An exact-amount join scores nothing on any fee-deducted pair, which is the
    baseline this engine is measured against.
  */
  const gross = Math.max(left.amountMinor, right.amountMinor);
  const gap = Math.abs(left.amountMinor - right.amountMinor);
  const declaredFee = Math.max(left.feeMinor + left.taxMinor, right.feeMinor + right.taxMinor);
  const explainable =
    Math.max(declaredFee, gross * thresholds.feeToleranceFraction) + thresholds.roundingSlackMinor;

  const amount =
    gap === 0 ? 1 : gap <= explainable ? 0.92 : gap <= explainable * 3 ? 0.92 * (1 - (gap - explainable) / (explainable * 2)) : 0;

  const days = daysBetween(left.valueDate, right.valueDate);
  const date = days <= thresholds.dateWindowDays ? 1 - (days / thresholds.dateWindowDays) * 0.6 : 0;

  const features: Features = { reference, amount, date, counterparty, crossSource: 1 };

  /*
    A pair from the SAME source is not a reconciliation.

    Reconciliation means finding the counterpart of a record in a different
    system. Two rows in the same bank statement are either two genuinely
    different credits or one credit delivered twice, and the second case is
    ingestion's job. Scoring them at all produced the worst behaviour in an
    earlier version: three orders for the same amount on the same day matched
    EACH OTHER at 0.92 on reference similarity alone, and the resulting group
    tied together money that never had anything to do with itself.

    A hard zero, not a small weight. This is a statement about what the pair
    could possibly mean, not about how much evidence there is.
  */
  if (left.kind === right.kind) return { score: 0, features: { ...features, crossSource: 0 } };

  // Currency is a hard gate, not a feature. Two amounts in different currencies
  // are not similar-with-low-confidence; they are incomparable, and giving them
  // a partial score would let a large enough reference similarity carry them.
  if (left.currency !== right.currency) return { score: 0, features };

  const total =
    features.reference * WEIGHTS.reference +
    features.amount * WEIGHTS.amount +
    features.date * WEIGHTS.date +
    features.counterparty * WEIGHTS.counterparty +
    features.crossSource * WEIGHTS.crossSource;

  return { score: Number(total.toFixed(4)), features };
}

/* -------------------------------------------------------------------------- */
/* Stage 3 lives in policy.ts                                                 */
/* -------------------------------------------------------------------------- */

export interface Ranked {
  record: MatchableRecord;
  score: number;
  features: Features;
}

export function explainFeatures(features: Features): string {
  const parts: string[] = [];
  parts.push(
    features.reference === 1
      ? "reference identical"
      : features.reference > 0.7
        ? "reference similar (" + features.reference.toFixed(2) + ")"
        : features.reference > 0
          ? "reference weak (" + features.reference.toFixed(2) + ")"
          : "no usable reference",
  );
  parts.push(
    features.amount === 1
      ? "amount exact"
      : features.amount > 0.85
        ? "amount differs by an explainable fee"
        : features.amount > 0
          ? "amount differs beyond the fee tolerance (" + features.amount.toFixed(2) + ")"
          : "amount unexplainable",
  );
  parts.push(
    features.date > 0.8
      ? "same-day or next-day"
      : features.date > 0
        ? "within the lag window"
        : "outside the date window",
  );
  parts.push(
    features.counterparty === 1
      ? "same counterparty"
      : features.counterparty > 0.5
        ? "counterparty similar"
        : "counterparty differs",
  );
  return parts.join("; ") + ".";
}
