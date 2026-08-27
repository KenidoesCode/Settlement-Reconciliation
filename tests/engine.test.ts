import { describe, expect, it } from "vitest";

import { normalizeCounterparty, normalizeReference, referenceSimilarity } from "../src/ingest/normalize";
import { blockingKeys, DEFAULT_THRESHOLDS, score, type MatchableRecord } from "../src/match/engine";
import { decide } from "../src/match/policy";
import { parseCsv } from "../src/ingest/ingest";
import { generateCorpus, SHAPE_MIX } from "../src/ingest/generate";

function record(overrides: Partial<MatchableRecord> = {}): MatchableRecord {
  return {
    id: "rec_a",
    kind: "ORDER",
    externalId: "order_1",
    normalizedReference: "RZP100001",
    normalizedCounterparty: "BLUE TOKAI COFFEE",
    amountMinor: 100_000,
    feeMinor: 0,
    taxMinor: 0,
    currency: "INR",
    valueDate: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("normalization", () => {
  it("strips the transport metadata a bank wraps around a reference", () => {
    // The confusable fold also maps Z to 2, so RZP normalizes to R2P. That is
    // applied identically on both sides of every comparison, so it costs
    // readability and nothing else -- and the raw reference is kept on the
    // record so the original is never lost.
    expect(normalizeReference("NEFT/RZP100001/HDFC0001")).toBe("R2P100001");
    expect(normalizeReference("  rzp-100001 ")).toBe("R2P100001");
    expect(normalizeReference("NEFT/RZP100001/HDFC0001")).toBe(normalizeReference("rzp 100001"));
  });

  it("folds the glyphs OCR and hand-keying actually confuse", () => {
    expect(normalizeReference("RZP1O0OO1")).toBe(normalizeReference("RZP100001"));
  });

  it("drops company suffixes from a counterparty", () => {
    expect(normalizeCounterparty("Chaayos Beverages Pvt Ltd")).toBe("CHAAYOS");
  });

  it("returns null rather than an empty string", () => {
    expect(normalizeReference("///")).toBeNull();
    expect(normalizeReference(null)).toBeNull();
  });
});

describe("reference similarity", () => {
  it("scores an identical reference at 1", () => {
    expect(referenceSimilarity("RZP100001", "RZP100001")).toBe(1);
  });

  it("scores a truncation high, because that is what a bank field width does", () => {
    expect(referenceSimilarity("RZP100001", "RZP10000")).toBeGreaterThan(0.8);
  });

  it("scores an adjacent SERIAL number low, because it is a different number", () => {
    // The regression this rule exists for: edit distance rated these at 0.78 and
    // two unrelated transactions merged into one match group.
    expect(referenceSimilarity("R2P100030", "R2P100089")).toBeLessThan(0.35);
  });

  it("refuses to compare very short references", () => {
    expect(referenceSimilarity("AB1", "AB2")).toBe(0);
  });
});

describe("scoring", () => {
  it("refuses to score two records from the same source", () => {
    const result = score(record(), record({ id: "rec_b", kind: "ORDER" }));
    expect(result.score).toBe(0);
  });

  it("scores an identical cross-source pair near 1", () => {
    const result = score(record(), record({ id: "rec_b", kind: "BANK_STATEMENT" }));
    expect(result.score).toBeGreaterThan(0.95);
  });

  it("treats a fee-sized amount gap as explainable", () => {
    const gross = record();
    const net = record({ id: "rec_b", kind: "SETTLEMENT", amountMinor: 97_200 });
    expect(score(gross, net).features.amount).toBeGreaterThan(0.85);
  });

  it("scores a gap far beyond any fee at zero", () => {
    const gross = record();
    const wrong = record({ id: "rec_b", kind: "SETTLEMENT", amountMinor: 40_000 });
    expect(score(gross, wrong).features.amount).toBe(0);
  });

  it("treats currency as a gate, not a feature", () => {
    const result = score(record(), record({ id: "rec_b", kind: "BANK_STATEMENT", currency: "USD" }));
    expect(result.score).toBe(0);
  });

  it("scores a date outside the window at zero without failing the pair", () => {
    const late = record({
      id: "rec_b",
      kind: "BANK_STATEMENT",
      valueDate: new Date("2026-09-01T00:00:00Z"),
    });
    expect(score(record(), late).features.date).toBe(0);
  });
});

describe("blocking", () => {
  it("emits a prefix key so truncation is still blocked together", () => {
    const keys = blockingKeys(record());
    expect(keys).toContain("ref:RZP100001");
    expect(keys.some((key) => key.startsWith("refp:"))).toBe(true);
  });

  it("emits two adjacent amount buckets, because a net amount lands nearby", () => {
    const buckets = blockingKeys(record()).filter((key) => key.startsWith("amt:"));
    expect(buckets).toHaveLength(2);
  });
});

describe("the policy engine", () => {
  const subject = record();

  it("accepts complementary candidates from different sources", () => {
    // The regression this test exists for: an earlier version read three
    // near-perfect candidates as ambiguity and scored 0.000 recall on the
    // easiest shape in the corpus.
    const decision = decide(subject, [
      { record: record({ id: "b", kind: "PG_PAYMENT" }), score: 0.99, features: { reference: 1, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
      { record: record({ id: "c", kind: "SETTLEMENT" }), score: 0.98, features: { reference: 1, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
      { record: record({ id: "d", kind: "BANK_STATEMENT" }), score: 0.97, features: { reference: 1, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
    ]);

    expect(decision.state).toBe("RESOLVED");
    expect(decision.acceptedIds).toHaveLength(3);
  });

  it("refuses when two same-source candidates each account for the whole amount", () => {
    const decision = decide(subject, [
      { record: record({ id: "b", kind: "BANK_STATEMENT", amountMinor: 100_000 }), score: 0.9, features: { reference: 0.5, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
      { record: record({ id: "c", kind: "BANK_STATEMENT", amountMinor: 100_000 }), score: 0.89, features: { reference: 0.5, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
    ]);

    expect(decision.state).toBe("EXCEPTION");
    expect(decision.exceptionKind).toBe("AMBIGUOUS_MANY_TO_ONE");
    expect(decision.ambiguousIds).toHaveLength(2);
    expect(decision.acceptedIds).toHaveLength(0);
  });

  it("accepts same-source candidates whose amounts SUM to the subject", () => {
    const decision = decide(subject, [
      { record: record({ id: "b", kind: "BANK_STATEMENT", amountMinor: 60_000 }), score: 0.9, features: { reference: 1, amount: 0.5, date: 1, counterparty: 1, crossSource: 1 } },
      { record: record({ id: "c", kind: "BANK_STATEMENT", amountMinor: 40_000 }), score: 0.89, features: { reference: 1, amount: 0.5, date: 1, counterparty: 1, crossSource: 1 } },
    ]);

    expect(decision.state).toBe("RESOLVED");
    expect(decision.acceptedIds).toHaveLength(2);
  });

  it("reports a missing counterpart rather than a failed match", () => {
    const decision = decide(subject, []);
    expect(decision.state).toBe("UNRESOLVED");
    expect(decision.exceptionKind).toBe("MISSING_COUNTERPART");
  });

  it("leaves a below-floor candidate out of the queue", () => {
    const decision = decide(subject, [
      { record: record({ id: "b", kind: "BANK_STATEMENT" }), score: 0.2, features: { reference: 0, amount: 0.4, date: 0.4, counterparty: 0, crossSource: 1 } },
    ]);
    expect(decision.state).toBe("UNRESOLVED");
    expect(decision.decidedBy).toBe("BELOW_FLOOR");
  });

  it("shows every tied candidate in the band between the floor and the threshold", () => {
    const decision = decide(subject, [
      { record: record({ id: "b", kind: "BANK_STATEMENT" }), score: 0.6, features: { reference: 0.2, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
      { record: record({ id: "c", kind: "BANK_STATEMENT" }), score: 0.58, features: { reference: 0.2, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
    ]);
    expect(decision.state).toBe("EXCEPTION");
    expect(decision.ambiguousIds.length).toBeGreaterThan(1);
  });

  it("raising the resolve threshold moves matches into the queue", () => {
    const candidates = [
      { record: record({ id: "b", kind: "BANK_STATEMENT" }), score: 0.85, features: { reference: 1, amount: 1, date: 1, counterparty: 1, crossSource: 1 } },
    ];
    expect(decide(subject, candidates, DEFAULT_THRESHOLDS).state).toBe("RESOLVED");
    expect(decide(subject, candidates, { ...DEFAULT_THRESHOLDS, resolve: 0.95 }).state).toBe("EXCEPTION");
  });
});

describe("csv ingestion", () => {
  const header = "external_id,reference,amount_minor,currency,value_date,counterparty";

  it("rejects a file with missing required columns", () => {
    expect(() => parseCsv("external_id,amount_minor\nBK1,100", "BANK_STATEMENT")).toThrow(/Missing required/);
  });

  it("rejects a row rather than coercing an unparseable amount", () => {
    const { rows, skipped } = parseCsv(header + "\nBK1,RZP1,not-a-number,INR,2026-07-01,X", "BANK_STATEMENT");
    expect(rows).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/exact integer/);
  });

  it("rejects a malformed date", () => {
    const { skipped } = parseCsv(header + "\nBK1,RZP1,1000,INR,nonsense,X", "BANK_STATEMENT");
    expect(skipped[0]?.reason).toMatch(/not a date/);
  });

  it("rejects a currency that is not a three-letter code", () => {
    const { skipped } = parseCsv(header + "\nBK1,RZP1,1000,RUPEES,2026-07-01,X", "BANK_STATEMENT");
    expect(skipped[0]?.reason).toMatch(/three-letter/);
  });

  it("accepts a well-formed row and normalizes nothing prematurely", () => {
    const { rows } = parseCsv(header + "\nBK1,NEFT/RZP1/HDFC,120000,inr,2026-07-01,Blue Tokai", "BANK_STATEMENT");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.currency).toBe("INR");
    // The raw reference survives; normalization happens at ingest, not in the parser.
    expect(rows[0]?.reference).toBe("NEFT/RZP1/HDFC");
  });

  it("gives an uploaded row no ground truth", () => {
    const { rows } = parseCsv(header + "\nBK1,RZP1,1000,INR,2026-07-01,X", "BANK_STATEMENT");
    expect(rows[0]?.truthGroupId).toBeNull();
  });
});

describe("the corpus", () => {
  it("is reproducible from a seed", () => {
    const a = generateCorpus(42);
    const b = generateCorpus(42);
    expect(a.records.length).toBe(b.records.length);
    expect(a.records.map((r) => r.externalId)).toEqual(b.records.map((r) => r.externalId));
  });

  it("differs between seeds", () => {
    expect(generateCorpus(1).records[0]?.externalId).not.toBe(generateCorpus(2).records[0]?.externalId);
  });

  it("contains every defect shape by construction, not by chance", () => {
    const corpus = generateCorpus(7);
    const shapes = new Set([...corpus.shapeOf.values()]);
    for (const shape of Object.keys(SHAPE_MIX)) expect(shapes).toContain(shape);
  });

  it("gives every record a truth group", () => {
    const corpus = generateCorpus(7);
    expect(corpus.records.every((record) => record.truthGroupId !== null)).toBe(true);
  });
});
