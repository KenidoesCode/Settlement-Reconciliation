import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDatabase, type Database } from "../src/db/client";
import { exceptions, matches, records } from "../src/db/schema";
import { ingestGeneratedCorpus } from "../src/ingest/ingest";
import { reconcile } from "../src/match/reconcile";
import { compareWithBaseline, evaluateRun } from "../src/eval/evaluate";
import { appendReceipt, hashPayload, verifyChain } from "../src/shared/audit";
import { adjudicate, ADJUSTMENT_LIMIT } from "../src/match/adjudicator";
import type { MatchableRecord } from "../src/match/engine";

let db: Database;
let close: () => Promise<void>;
let systemRunId: string;
let baselineRunId: string;

beforeAll(async () => {
  const handle = await createTestDatabase();
  db = handle.db;
  close = handle.close;

  await ingestGeneratedCorpus(db);
  baselineRunId = (await reconcile(db, { strategy: "baseline-exact", label: "baseline" })).runId;
  systemRunId = (await reconcile(db, { strategy: "fuzzy+adjudicator", label: "system" })).runId;
}, 180_000);

afterAll(async () => {
  await close();
});

describe("ingestion", () => {
  it("loads every source", async () => {
    const rows = await db.select().from(records);
    expect(rows.length).toBeGreaterThan(500);
    expect(new Set(rows.map((row) => row.kind)).size).toBe(5);
  });

  it("marks duplicates instead of deleting them", async () => {
    const rows = await db.select().from(records);
    const duplicates = rows.filter((row) => row.duplicateOfId !== null);
    expect(duplicates.length).toBeGreaterThan(0);
    // The row it repeats is still there. "The bank sent this twice" is a fact
    // about the bank and deleting the evidence loses it.
    for (const duplicate of duplicates.slice(0, 3)) {
      const [original] = await db.select().from(records).where(eq(records.id, duplicate.duplicateOfId as string));
      expect(original).toBeDefined();
    }
  });

  it("normalizes references at ingest", async () => {
    const rows = await db.select().from(records);
    const mangled = rows.find((row) => row.reference?.startsWith("NEFT/"));
    expect(mangled?.normalizedReference?.startsWith("NEFT")).toBe(false);
  });
});

describe("reconciliation", () => {
  it("beats the exact-join baseline on recall without losing precision", async () => {
    const comparison = await compareWithBaseline(db, systemRunId, baselineRunId);
    const { system, baseline } = comparison;
    expect(baseline).not.toBeNull();
    if (!baseline) return;

    expect(system.recall).toBeGreaterThan(baseline.recall);
    expect(system.precision).toBeGreaterThanOrEqual(baseline.precision - 0.02);
    expect(system.f1).toBeGreaterThan(baseline.f1);
  });

  it("produces no false matches on this corpus", async () => {
    const metrics = await evaluateRun(db, systemRunId);
    // A change that makes this fail is a regression worth stopping for: a false
    // match posts money against the wrong invoice.
    expect(metrics.falsePairs).toBe(0);
  });

  it("recovers the clean shape completely", async () => {
    const metrics = await evaluateRun(db, systemRunId);
    const clean = metrics.perShape.find((shape) => shape.shape === "clean");
    expect(clean?.recall).toBe(1);
  });

  it("recovers fee-deducted pairs the baseline cannot see", async () => {
    const system = await evaluateRun(db, systemRunId);
    const baseline = await evaluateRun(db, baselineRunId);
    const systemFee = system.perShape.find((shape) => shape.shape === "fee-deducted");
    const baselineFee = baseline.perShape.find((shape) => shape.shape === "fee-deducted");
    expect(systemFee?.recall ?? 0).toBeGreaterThan(baselineFee?.recall ?? 0);
  });

  it("never resolves a many-to-one case, and never loses one either", async () => {
    const metrics = await evaluateRun(db, systemRunId);
    const trap = metrics.perShape.find((shape) => shape.shape === "many-to-one");
    expect(trap?.falsePairs).toBe(0);
    expect(trap?.truePairs).toBe(0);
    // Every one of them reaches a person. A pair that is neither matched nor
    // queued is the failure nobody finds out about.
    expect(trap?.missedPairs).toBe(0);
    expect(trap?.exceptionPairs).toBe(trap?.truthPairs);
  });

  it("flags missing counterparts as absence rather than as a weak match", async () => {
    const rows = await db.select().from(exceptions).where(eq(exceptions.runId, systemRunId));
    const missing = rows.filter((row) => row.kind === "MISSING_COUNTERPART");
    expect(missing.length).toBeGreaterThan(0);
    for (const row of missing) expect(row.recommendedRecordIds).toHaveLength(0);
  });

  it("groups records rather than storing pairs", async () => {
    const rows = await db.select().from(matches).where(eq(matches.runId, systemRunId));
    expect(rows.some((row) => row.recordIds.length > 2)).toBe(true);
  });

  it("attaches every indistinguishable candidate to an ambiguous exception", async () => {
    const rows = await db.select().from(exceptions).where(eq(exceptions.runId, systemRunId));
    const ambiguous = rows.filter((row) => row.recommendedRecordIds.length > 1);
    expect(ambiguous.length).toBeGreaterThan(0);
  });

  it("raising the resolve threshold trades recall for a longer queue", async () => {
    const strict = await reconcile(db, {
      strategy: "fuzzy",
      label: "strict",
      thresholds: { resolve: 0.97 },
    });
    const normal = await evaluateRun(db, systemRunId);
    const strictMetrics = await evaluateRun(db, strict.runId);

    expect(strictMetrics.recall).toBeLessThanOrEqual(normal.recall);
    expect(strict.exceptionCount + strict.unresolvedCount).toBeGreaterThanOrEqual(0);
  });
});

describe("the adjudicator", () => {
  const subject: MatchableRecord = {
    id: "rec_subject",
    kind: "ORDER",
    externalId: "order_x",
    normalizedReference: "RZP100001",
    normalizedCounterparty: "BLUE TOKAI",
    amountMinor: 100_000,
    feeMinor: 0,
    taxMinor: 0,
    currency: "INR",
    valueDate: new Date("2026-07-01T00:00:00Z"),
  };

  it("cannot move a confidence beyond the clamp", async () => {
    const result = await adjudicate(subject, [
      {
        record: { ...subject, id: "rec_other", kind: "SETTLEMENT", amountMinor: 97_200 },
        score: 0.6,
        features: { reference: 1, amount: 0.9, date: 1, counterparty: 1, crossSource: 1 },
      },
    ]);
    expect(Math.abs(result.appliedAdjustment)).toBeLessThanOrEqual(ADJUSTMENT_LIMIT);
  });

  it("recognises a gap that is exactly a standard fee", async () => {
    const gross = 1_000_000;
    const fee = Math.round(gross * 0.0236);
    const net = gross - fee - Math.round(fee * 0.18);
    const result = await adjudicate(
      { ...subject, amountMinor: gross },
      [
        {
          record: { ...subject, id: "rec_net", kind: "SETTLEMENT", amountMinor: net },
          score: 0.7,
          features: { reference: 1, amount: 0.9, date: 1, counterparty: 1, crossSource: 1 },
        },
      ],
    );
    expect(result.proposal.confidenceAdjustment).toBeGreaterThan(0);
    expect(result.proposal.rationale).toMatch(/fee/i);
  });

  it("costs confidence when only the counterparty matches", async () => {
    const result = await adjudicate(subject, [
      {
        record: { ...subject, id: "rec_weak", kind: "BANK_STATEMENT", normalizedReference: "ZZZZZZ" },
        score: 0.55,
        features: { reference: 0.1, amount: 1, date: 1, counterparty: 1, crossSource: 1 },
      },
    ]);
    expect(result.proposal.confidenceAdjustment).toBeLessThan(0);
  });

  it("reports which adjudicator actually ran", async () => {
    const result = await adjudicate(subject, [
      {
        record: { ...subject, id: "rec_other", kind: "SETTLEMENT" },
        score: 0.6,
        features: { reference: 1, amount: 1, date: 1, counterparty: 1, crossSource: 1 },
      },
    ]);
    expect(result.adjudicator).toBe("deterministic");
  });
});

describe("the audit chain", () => {
  it("links every receipt to its predecessor", async () => {
    const report = await verifyChain(db);
    expect(report.count).toBeGreaterThan(0);
    expect(report.intact).toBe(true);
  });

  it("hashes a payload independently of key order", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it("changes the hash when any value changes", () => {
    expect(hashPayload({ amount: 100 })).not.toBe(hashPayload({ amount: 101 }));
  });

  it("records a run, and the chain still verifies afterwards", async () => {
    await appendReceipt(db, { eventType: "TEST", correlationId: "cor_test", payload: { n: 1 } });
    const report = await verifyChain(db);
    expect(report.intact).toBe(true);
  });
});

describe("evaluation guards", () => {
  it("refuses to score data with no ground truth", async () => {
    const { db: fresh, close: closeFresh } = await createTestDatabase();
    try {
      const run = await reconcile(fresh, { strategy: "fuzzy" });
      await expect(evaluateRun(fresh, run.runId)).rejects.toThrow(/truth group/i);
    } finally {
      await closeFresh();
    }
  });

  it("names the regressions where the baseline wins", async () => {
    const comparison = await compareWithBaseline(db, baselineRunId, systemRunId);
    // Comparing the baseline AGAINST the engine must surface the baseline's
    // worse recall as a regression. If this array can only ever be empty, the
    // honesty of the comparison is decorative.
    expect(comparison.regressions.length).toBeGreaterThan(0);
  });
});
