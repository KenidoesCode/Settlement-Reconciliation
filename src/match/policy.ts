import type { Features, MatchableRecord, Ranked, Thresholds } from "./engine";
import { DEFAULT_THRESHOLDS, explainFeatures } from "./engine";

/**
 * ===========================================================================
 * THE POLICY ENGINE
 * ===========================================================================
 * The only place a decision is made. Scoring produces numbers; this decides
 * what they mean.
 *
 * ---------------------------------------------------------------------------
 * THE MISTAKE THIS FILE WAS REWRITTEN TO FIX
 * ---------------------------------------------------------------------------
 * The first version treated "several candidates score about the same" as
 * ambiguity, full stop. It measured 0.000 recall on the CLEAN shape -- the
 * shape where an order, a payment, a settlement and a bank line all carry the
 * same reference and the same amount and there is nothing hard about them at
 * all.
 *
 * The reason is worth stating plainly, because the corrected rule follows
 * directly from it. In a four-record reconciliation, every record has three
 * near-perfect candidates. They are not alternatives. They are the other three
 * parts of the same event, and a rule that reads "three candidates tied at
 * 0.99" as a coin-flip has confused COMPLEMENTARY candidates with MUTUALLY
 * EXCLUSIVE ones.
 *
 * So ambiguity is now defined by mutual exclusivity, and mutual exclusivity has
 * a test:
 *
 *   Two candidates are mutually exclusive when they come from the SAME SOURCE
 *   and each one ALONE accounts for the subject's amount.
 *
 * An order and a bank line are complementary -- both belong. Two bank lines for
 * 40% and 60% of an order are complementary too: they are a split settlement,
 * and their amounts SUM to the subject rather than each matching it. Two bank
 * lines that are each for the full amount are mutually exclusive: at most one of
 * them is this order's money, and picking is guessing.
 *
 * That test separates the many-to-one trap from the clean case and the split
 * case, which the previous rule could not do at all.
 */

export type ExceptionReason =
  | "AMBIGUOUS_MANY_TO_ONE"
  | "AMOUNT_MISMATCH_BEYOND_FEE"
  | "MISSING_COUNTERPART"
  | "TIMING_BEYOND_WINDOW"
  | "REFERENCE_UNRECOGNIZED"
  | "LOW_CONFIDENCE";

export interface Decision {
  state: "RESOLVED" | "EXCEPTION" | "UNRESOLVED";
  /** Records to union with the subject. Every accepted candidate, not just the best. */
  acceptedIds: string[];
  /** Candidates that could not be told apart. Raised as an exception. */
  ambiguousIds: string[];
  exceptionKind: ExceptionReason | null;
  confidence: number;
  decidedBy: string;
  rationale: string[];
}

export function decide(
  subject: MatchableRecord,
  ranked: Ranked[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Decision {
  if (ranked.length === 0) {
    return {
      state: "UNRESOLVED",
      acceptedIds: [],
      ambiguousIds: [],
      exceptionKind: "MISSING_COUNTERPART",
      confidence: 0,
      decidedBy: "NO_CANDIDATE",
      rationale: [
        "No record in any other source shares a reference, an amount bucket, or a counterparty-and-date block with this one.",
        "Reported as a missing counterpart rather than a failed match: there is nothing here to have got wrong.",
      ],
    };
  }

  const strong = ranked.filter((candidate) => candidate.score >= thresholds.resolve);

  /* ---- mutual exclusivity, per source ------------------------------------ */

  const accepted: Ranked[] = [];
  const ambiguous: Ranked[] = [];
  const notes: string[] = [];

  const bySource = new Map<string, Ranked[]>();
  for (const candidate of strong) {
    const bucket = bySource.get(candidate.record.kind) ?? [];
    bucket.push(candidate);
    bySource.set(candidate.record.kind, bucket);
  }

  for (const [kind, candidates] of bySource) {
    if (candidates.length === 1) {
      accepted.push(candidates[0] as Ranked);
      continue;
    }

    const tied = candidates.filter(
      (candidate) => (candidates[0] as Ranked).score - candidate.score < thresholds.ambiguityMargin,
    );

    if (tied.length < 2) {
      // A clear winner within this source. The rest are worse alternatives and
      // are dropped rather than accepted -- one source contributes one row to a
      // reconciliation unless the amounts say otherwise.
      accepted.push(candidates[0] as Ranked);
      continue;
    }

    // Each candidate alone accounting for the subject's amount is what makes
    // them alternatives rather than parts.
    const explainable = explainableGap(subject, thresholds);
    const eachExplainsTheWhole = tied.every(
      (candidate) => Math.abs(candidate.record.amountMinor - subject.amountMinor) <= explainable,
    );

    const sum = tied.reduce((total, candidate) => total + candidate.record.amountMinor, 0);
    const sumsToSubject = Math.abs(sum - subject.amountMinor) <= explainable;

    if (sumsToSubject && !eachExplainsTheWhole) {
      // A split. The parts add up, so they are all part of the same event.
      accepted.push(...tied);
      notes.push(
        tied.length +
          " " +
          kind.toLowerCase().replace(/_/g, " ") +
          " records sum to the subject amount within the fee tolerance: this is a split, not a choice.",
      );
      continue;
    }

    if (eachExplainsTheWhole) {
      ambiguous.push(...tied);
      notes.push(
        tied.length +
          " " +
          kind.toLowerCase().replace(/_/g, " ") +
          " records each account for the full amount and score within " +
          thresholds.ambiguityMargin +
          " of each other (" +
          tied.map((t) => t.score.toFixed(3)).join(", ") +
          "). At most one is this record's money and nothing distinguishes them.",
      );
      continue;
    }

    // Neither interchangeable nor additive. The engine has no account of what
    // these are, and inventing one is how a wrong posting happens.
    ambiguous.push(...tied);
    notes.push(
      tied.length +
        " " +
        kind.toLowerCase().replace(/_/g, " ") +
        " records score alike but neither match the amount individually nor sum to it.",
    );
  }

  /* ---- assemble ----------------------------------------------------------- */

  const best = ranked[0] as Ranked;

  if (accepted.length > 0) {
    return {
      state: "RESOLVED",
      acceptedIds: accepted.map((candidate) => candidate.record.id),
      ambiguousIds: ambiguous.map((candidate) => candidate.record.id),
      exceptionKind: ambiguous.length > 0 ? "AMBIGUOUS_MANY_TO_ONE" : null,
      confidence: Number(Math.min(...accepted.map((candidate) => candidate.score)).toFixed(4)),
      decidedBy: "ABOVE_RESOLVE_THRESHOLD",
      rationale: [
        accepted.length +
          " candidate" +
          (accepted.length === 1 ? "" : "s") +
          " above the " +
          thresholds.resolve +
          " resolve threshold, from " +
          new Set(accepted.map((c) => c.record.kind)).size +
          " source" +
          (new Set(accepted.map((c) => c.record.kind)).size === 1 ? "" : "s") +
          ".",
        explainFeatures(best.features),
        ...notes,
        ...(ambiguous.length > 0
          ? ["The ambiguous candidates are NOT included in the match. They are raised separately for a person."]
          : []),
      ],
    };
  }

  if (ambiguous.length > 0) {
    return {
      state: "EXCEPTION",
      acceptedIds: [],
      ambiguousIds: ambiguous.map((candidate) => candidate.record.id),
      exceptionKind: "AMBIGUOUS_MANY_TO_ONE",
      confidence: Number(best.score.toFixed(4)),
      decidedBy: "MUTUALLY_EXCLUSIVE_CANDIDATES",
      rationale: [
        ...notes,
        "The best candidate scores " +
          best.score.toFixed(3) +
          ", above the resolve threshold. It is still not resolved: being confident about which of several indistinguishable records is the right one is precisely the error this check exists to prevent.",
        "A person is asked, and the recommendation is attached so the queue is not a blank form.",
      ],
    };
  }

  if (best.score < thresholds.floor) {
    return {
      state: "UNRESOLVED",
      acceptedIds: [],
      ambiguousIds: [],
      exceptionKind: null,
      confidence: Number(best.score.toFixed(4)),
      decidedBy: "BELOW_FLOOR",
      rationale: [
        "The best candidate scores " + best.score.toFixed(3) + ", below the " + thresholds.floor + " floor.",
        "Sending this to a person would spend review time on a pair the engine has no reason to believe in. Unresolved and flagged.",
      ],
    };
  }

  const kind: ExceptionReason =
    best.features.amount < 0.5
      ? "AMOUNT_MISMATCH_BEYOND_FEE"
      : best.features.date === 0
        ? "TIMING_BEYOND_WINDOW"
        : best.features.reference < 0.4
          ? "REFERENCE_UNRECOGNIZED"
          : "LOW_CONFIDENCE";

  /*
    All the near-tied candidates go into the recommendation, not just the best.

    Measured: the many-to-one shape mostly does NOT arrive here as an ambiguity
    exception. Its bank narrations carry no usable reference, so those pairs
    score around 0.55 and land in this band as REFERENCE_UNRECOGNIZED instead --
    and when the recommendation held only the single best candidate, the queue
    showed one bank line where three were indistinguishable. A reviewer would
    have approved the first plausible one.
  */
  const tiedHere = ranked.filter((candidate) => best.score - candidate.score < thresholds.ambiguityMargin);

  return {
    state: "EXCEPTION",
    acceptedIds: [],
    ambiguousIds: tiedHere.map((candidate) => candidate.record.id),
    exceptionKind: tiedHere.length > 1 ? "AMBIGUOUS_MANY_TO_ONE" : kind,
    confidence: Number(best.score.toFixed(4)),
    decidedBy: "BELOW_RESOLVE_THRESHOLD",
    rationale: [
      "Scores " +
        best.score.toFixed(3) +
        ", between the " +
        thresholds.floor +
        " floor and the " +
        thresholds.resolve +
        " resolve threshold.",
      explainFeatures(best.features),
      tiedHere.length > 1
        ? tiedHere.length +
          " candidates score within " +
          thresholds.ambiguityMargin +
          " of each other, so all of them are shown rather than only the best. A queue that offers one option where three are indistinguishable invites the reviewer to approve the first plausible one."
        : "Plausible, not certain. A person decides, and the recommendation is attached.",
    ],
  };
}

export function explainableGap(subject: MatchableRecord, thresholds: Thresholds): number {
  return (
    Math.max(subject.feeMinor + subject.taxMinor, subject.amountMinor * thresholds.feeToleranceFraction) +
    thresholds.roundingSlackMinor
  );
}

export type { Features };
