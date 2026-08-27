import { Rng } from "../shared/rng";
import { deterministicId } from "../shared/ids";
import type { SourceKind } from "../db/schema";

/**
 * The synthetic multi-source corpus.
 *
 * ===========================================================================
 * THE GROUND TRUTH IS THE POINT
 * ===========================================================================
 * Every record carries a `truthGroupId`. Rows that belong together share one.
 * The matcher never sees it -- the normalizer strips it before scoring and the
 * candidate generator has no access to it -- and the evaluation is the only
 * code that reads it. Without that, "match rate" would mean "the share of rows
 * the matcher was willing to pair up", which is a measure of the matcher's
 * confidence rather than of its correctness.
 *
 * DEFECTS ARE CONSTRUCTED, NOT SPRINKLED
 * ===========================================================================
 * Each scenario type is emitted a fixed number of times rather than sampled at
 * a probability, because a corpus that "usually" contains a many-to-one case is
 * a corpus whose hardest evaluation number moves for reasons unrelated to the
 * matcher. The counts are in SHAPE_MIX and the evaluation reports per-shape
 * results so a good aggregate cannot hide a shape the matcher never handles.
 */

export const DATASET_VERSION = "1.0.0";

export interface GeneratedRecord {
  sourceKind: SourceKind;
  externalId: string;
  reference: string | null;
  amountMinor: number;
  currency: string;
  feeMinor: number;
  taxMinor: number;
  counterparty: string | null;
  occurredAt: Date;
  valueDate: Date;
  truthGroupId: string | null;
  raw: Record<string, unknown>;
}

export type ShapeKind =
  | "clean"
  | "fee-deducted"
  | "split-settlement"
  | "timing-lag"
  | "reference-typo"
  | "missing-counterpart"
  | "duplicate"
  | "many-to-one";

/**
 * How many of each shape. Fixed counts, not probabilities.
 *
 * Tuned so every shape has enough instances for a per-shape rate to mean
 * something (a shape with three instances produces rates of 0, 0.33, 0.67 or 1
 * and nothing in between) while keeping the corpus small enough to reconcile
 * inside a serverless cold start.
 */
export const SHAPE_MIX: Record<ShapeKind, number> = {
  clean: 60,
  "fee-deducted": 34,
  "split-settlement": 14,
  "timing-lag": 22,
  "reference-typo": 20,
  "missing-counterpart": 16,
  duplicate: 8,
  "many-to-one": 10,
};

const MERCHANTS = [
  "Blue Tokai Coffee Roasters",
  "Chaayos Beverages Pvt Ltd",
  "Urban Company Services",
  "BigBasket Retail",
  "Zomato Media Pvt Ltd",
  "Reliance Digital Retail",
  "Nykaa E-Retail",
  "Lenskart Solutions",
];

const BANKS = ["HDFC", "ICICI", "AXIS", "KOTAK"];

function razorpayId(prefix: "pay" | "order" | "setl", rng: Rng): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 14; i += 1) out += alphabet[rng.int(0, alphabet.length - 1)];
  return prefix + "_" + out;
}

/**
 * Mangles a reference the way a bank narration actually mangles one.
 *
 * Not random character noise: real corruption is truncation to a field width,
 * case folding, separator substitution and OCR-style confusions, and a matcher
 * tuned against random noise is tuned against the wrong thing.
 */
function mangle(reference: string, rng: Rng): string {
  const kind = rng.int(0, 4);
  if (kind === 0) return reference.slice(0, 12); // truncated to a field width
  if (kind === 1) return reference.toLowerCase().replace(/_/g, "-");
  if (kind === 2) return reference.replace(/O/g, "0").replace(/l/g, "1").replace(/S/g, "5");
  if (kind === 3) return "NEFT/" + reference + "/" + BANKS[rng.int(0, BANKS.length - 1)];
  const position = rng.int(4, Math.max(5, reference.length - 2));
  return reference.slice(0, position) + reference.slice(position + 1); // dropped character
}

/**
 * Razorpay's fee model, approximately: a percentage plus GST on the fee.
 *
 * Approximately, and the README says so. The point is that a settlement is
 * never the order amount, so a matcher joining on equal amounts finds nothing --
 * which is the whole reason this project is not a SQL join.
 */
function feeFor(amountMinor: number, rng: Rng): { feeMinor: number; taxMinor: number } {
  const rate = rng.pick([0.018, 0.02, 0.0236, 0.025]);
  const feeMinor = Math.round(amountMinor * rate);
  const taxMinor = Math.round(feeMinor * 0.18);
  return { feeMinor, taxMinor };
}

export interface GeneratedCorpus {
  records: GeneratedRecord[];
  shapeOf: Map<string, ShapeKind>;
  version: string;
  seed: number;
}

export function generateCorpus(seed: number): GeneratedCorpus {
  const rng = new Rng(seed);
  const records: GeneratedRecord[] = [];
  const shapeOf = new Map<string, ShapeKind>();

  const start = Date.UTC(2026, 6, 1);
  let sequence = 0;

  const nextDate = (): Date => {
    sequence += 1;
    return new Date(start + sequence * 3_600_000 * rng.int(2, 9));
  };

  const emit = (record: GeneratedRecord): void => {
    records.push(record);
  };

  const group = (shape: ShapeKind, index: number): string => {
    const id = deterministicId("grp", shape + "-" + index);
    shapeOf.set(id, shape);
    return id;
  };

  let index = 0;

  /* ---- clean: order, payment, settlement and bank line all agree --------- */
  for (let i = 0; i < SHAPE_MIX.clean; i += 1) {
    index += 1;
    const truthGroupId = group("clean", i);
    const amount = rng.int(30_000, 900_000);
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("PG_PAYMENT", razorpayId("pay", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), reference, amount, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId));
    emit(base("BANK_STATEMENT", "BK" + String(500000 + index), reference, amount, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
  }

  /* ---- fee-deducted: the settlement and bank line are net ---------------- */
  for (let i = 0; i < SHAPE_MIX["fee-deducted"]; i += 1) {
    index += 1;
    const truthGroupId = group("fee-deducted", i);
    const gross = rng.int(50_000, 1_500_000);
    const { feeMinor, taxMinor } = feeFor(gross, rng);
    const net = gross - feeMinor - taxMinor;
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, gross, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("PG_PAYMENT", razorpayId("pay", rng), reference, gross, merchant, occurredAt, occurredAt, truthGroupId));
    emit({
      ...base("SETTLEMENT", razorpayId("setl", rng), reference, net, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId),
      feeMinor,
      taxMinor,
    });
    emit(base("BANK_STATEMENT", "BK" + String(500000 + index), mangle(reference, rng), net, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
    emit(base("INVOICE", "INV" + String(700000 + index), reference, gross, merchant, occurredAt, occurredAt, truthGroupId));
  }

  /* ---- split settlement: one order, two bank credits --------------------- */
  for (let i = 0; i < SHAPE_MIX["split-settlement"]; i += 1) {
    index += 1;
    const truthGroupId = group("split-settlement", i);
    const gross = rng.int(200_000, 2_000_000);
    const firstPart = Math.round(gross * rng.pick([0.4, 0.5, 0.6]));
    const secondPart = gross - firstPart;
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, gross, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("PG_PAYMENT", razorpayId("pay", rng), reference, gross, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), reference, firstPart, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), reference, secondPart, merchant, occurredAt, addDays(occurredAt, 3), truthGroupId));
    emit(base("BANK_STATEMENT", "BK" + String(500000 + index), reference, firstPart, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
    emit(base("BANK_STATEMENT", "BK" + String(600000 + index), reference, secondPart, merchant, addDays(occurredAt, 3), addDays(occurredAt, 3), truthGroupId));
  }

  /* ---- timing lag: the bank credit arrives days later -------------------- */
  for (let i = 0; i < SHAPE_MIX["timing-lag"]; i += 1) {
    index += 1;
    const truthGroupId = group("timing-lag", i);
    const amount = rng.int(40_000, 800_000);
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const lag = rng.int(4, 11);
    const reference = "RZP" + String(100000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), reference, amount, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId));
    emit(base("BANK_STATEMENT", "BK" + String(500000 + index), reference, amount, merchant, addDays(occurredAt, lag), addDays(occurredAt, lag), truthGroupId));
  }

  /* ---- reference typo: only the amount and the counterparty agree -------- */
  for (let i = 0; i < SHAPE_MIX["reference-typo"]; i += 1) {
    index += 1;
    const truthGroupId = group("reference-typo", i);
    const amount = rng.int(25_000, 600_000);
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), mangle(reference, rng), amount, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId));
    emit(base("BANK_STATEMENT", "BK" + String(500000 + index), mangle(mangle(reference, rng), rng), amount, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
  }

  /* ---- missing counterpart: an order that never settles ------------------ */
  for (let i = 0; i < SHAPE_MIX["missing-counterpart"]; i += 1) {
    index += 1;
    const truthGroupId = group("missing-counterpart", i);
    const amount = rng.int(20_000, 500_000);
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);

    // Deliberately alone. The correct outcome is UNRESOLVED and flagged, and a
    // matcher that pairs this with anything has produced a false match.
    emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    if (i % 2 === 0) {
      emit(base("PG_PAYMENT", razorpayId("pay", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    }
  }

  /* ---- duplicate: the same bank line delivered twice --------------------- */
  for (let i = 0; i < SHAPE_MIX.duplicate; i += 1) {
    index += 1;
    const truthGroupId = group("duplicate", i);
    const amount = rng.int(30_000, 700_000);
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    const reference = "RZP" + String(100000 + index);
    const bankId = "BK" + String(500000 + index);

    emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
    emit(base("SETTLEMENT", razorpayId("setl", rng), reference, amount, merchant, occurredAt, addDays(occurredAt, 2), truthGroupId));
    emit(base("BANK_STATEMENT", bankId, reference, amount, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
    // Same external id, re-delivered. Ingestion must catch this, not the matcher.
    emit({
      ...base("BANK_STATEMENT", bankId, reference, amount, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId),
      raw: { redelivery: true },
    });
  }

  /* ---- many-to-one: several same-amount, same-day credits ---------------- */
  for (let i = 0; i < SHAPE_MIX["many-to-one"]; i += 1) {
    const merchant = rng.pick(MERCHANTS);
    const occurredAt = nextDate();
    // The trap: identical amounts, identical day, identical counterparty, and
    // references mangled past recognition. Nothing distinguishes which order
    // corresponds to which bank line. The correct outcome is an EXCEPTION, and
    // any confident pairing here is a false match.
    const amount = rng.int(80_000, 400_000);
    for (let member = 0; member < 3; member += 1) {
      index += 1;
      const truthGroupId = group("many-to-one", i * 10 + member);
      const reference = "RZP" + String(100000 + index);
      emit(base("ORDER", razorpayId("order", rng), reference, amount, merchant, occurredAt, occurredAt, truthGroupId));
      emit(base("BANK_STATEMENT", "BK" + String(500000 + index), "NEFT/" + merchant.slice(0, 6).toUpperCase(), amount, merchant, addDays(occurredAt, 2), addDays(occurredAt, 2), truthGroupId));
    }
  }

  return { records, shapeOf, version: DATASET_VERSION, seed };
}

function base(
  sourceKind: SourceKind,
  externalId: string,
  reference: string | null,
  amountMinor: number,
  counterparty: string,
  occurredAt: Date,
  valueDate: Date,
  truthGroupId: string,
): GeneratedRecord {
  return {
    sourceKind,
    externalId,
    reference,
    amountMinor,
    currency: "INR",
    feeMinor: 0,
    taxMinor: 0,
    counterparty,
    occurredAt,
    valueDate,
    truthGroupId,
    raw: { source: sourceKind, externalId, reference, amountMinor, counterparty },
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
