import { desc, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { exceptions, matchRuns, matches, records } from "../db/schema";
import { reconcile } from "../match/reconcile";
import { compareWithBaseline, evaluateRun } from "../eval/evaluate";
import { parseCsv } from "../ingest/ingest";
import { AppError } from "../shared/errors";
import { inr } from "../shared/money";

/**
 * The five demonstrations.
 *
 * Every one runs against the live database and reports what happened. Nothing
 * is scripted: if the many-to-one demonstration ever reports a confident match,
 * it prints that, because a demo that cannot fail is not evidence of anything.
 */

export const DEMO_SCENARIOS = [
  "clean-batch",
  "fee-mismatch",
  "many-to-one-exception",
  "missing-counterpart",
  "baseline-vs-ai",
] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export interface DemoStep {
  step: string;
  outcome: string;
  detail: string;
  ok: boolean;
}

export interface DemoResult {
  scenario: DemoScenario;
  headline: string;
  steps: DemoStep[];
  links: { label: string; href: string }[];
  passed: boolean;
}

export async function runDemo(db: Database, scenario: DemoScenario): Promise<DemoResult> {
  switch (scenario) {
    case "clean-batch":
      return cleanBatch(db);
    case "fee-mismatch":
      return feeMismatch(db);
    case "many-to-one-exception":
      return manyToOne(db);
    case "missing-counterpart":
      return missingCounterpart(db);
    case "baseline-vs-ai":
      return baselineVsSystem(db);
    default:
      throw new AppError("VALIDATION_FAILED", "Unknown demonstration.");
  }
}

async function latestSystemRunId(db: Database): Promise<string> {
  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const system = runs.find((run) => run.strategy !== "baseline-exact");
  if (!system) throw new AppError("RUN_NOT_FOUND", "No reconciliation run yet.");
  return system.id;
}

async function cleanBatch(db: Database): Promise<DemoResult> {
  const runId = await latestSystemRunId(db);
  const metrics = await evaluateRun(db, runId);
  const clean = metrics.perShape.find((shape) => shape.shape === "clean");

  return {
    scenario: "clean-batch",
    headline: "Records that agree on everything, matched across four sources.",
    steps: [
      {
        step: "Clean truth pairs in the corpus",
        outcome: String(clean?.truthPairs ?? 0),
        detail: "An order, a payment, a settlement and a bank line, all carrying the same reference and amount.",
        ok: (clean?.truthPairs ?? 0) > 0,
      },
      {
        step: "Recovered",
        outcome: ((clean?.recall ?? 0) * 100).toFixed(1) + "%",
        detail:
          "The four records form one match group, not three pairings. An event is one reconciliation, and storing pairs would leave the reader to work out that they are the same thing.",
        ok: (clean?.recall ?? 0) >= 0.99,
      },
      {
        step: "False pairs on this shape",
        outcome: String(clean?.falsePairs ?? 0),
        detail: "A clean shape producing false pairs would mean the matcher is reaching across events.",
        ok: (clean?.falsePairs ?? 0) === 0,
      },
    ],
    links: [{ label: "Open the run", href: "/runs/" + runId }],
    passed: (clean?.recall ?? 0) >= 0.99 && (clean?.falsePairs ?? 0) === 0,
  };
}

async function feeMismatch(db: Database): Promise<DemoResult> {
  const runId = await latestSystemRunId(db);
  const metrics = await evaluateRun(db, runId);
  const fee = metrics.perShape.find((shape) => shape.shape === "fee-deducted");

  const baselineRuns = await db.select().from(matchRuns).where(eq(matchRuns.strategy, "baseline-exact"));
  const baselineId = baselineRuns.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id;
  const baselineFee = baselineId
    ? (await evaluateRun(db, baselineId)).perShape.find((shape) => shape.shape === "fee-deducted")
    : undefined;

  return {
    scenario: "fee-mismatch",
    headline: "A settlement is never the order amount. This is the shape an exact join cannot see.",
    steps: [
      {
        step: "Fee-deducted truth pairs",
        outcome: String(fee?.truthPairs ?? 0),
        detail: "Gross on the order and invoice; net of a gateway fee and 18% GST on the settlement and bank line.",
        ok: (fee?.truthPairs ?? 0) > 0,
      },
      {
        step: "Exact join recovers",
        outcome: ((baselineFee?.recall ?? 0) * 100).toFixed(1) + "%",
        detail:
          "The baseline requires identical amounts. Every gross-to-net pair fails it, which is why an exact join is not a reconciliation.",
        ok: true,
      },
      {
        step: "Fee-aware matching recovers",
        outcome: ((fee?.recall ?? 0) * 100).toFixed(1) + "%",
        detail:
          "The amount feature scores a gap that is explainable as a fee at 0.92 rather than 0. Beyond three times the tolerance it is zero, so a genuine shortfall is not swallowed.",
        ok: (fee?.recall ?? 0) > (baselineFee?.recall ?? 0),
      },
      {
        step: "False pairs introduced",
        outcome: String(fee?.falsePairs ?? 0),
        detail: "Buying recall with false matches would be the wrong trade in a finance product.",
        ok: (fee?.falsePairs ?? 0) === 0,
      },
    ],
    links: [{ label: "Open the run", href: "/runs/" + runId }],
    passed: (fee?.recall ?? 0) > (baselineFee?.recall ?? 0) && (fee?.falsePairs ?? 0) === 0,
  };
}

async function manyToOne(db: Database): Promise<DemoResult> {
  const runId = await latestSystemRunId(db);
  const metrics = await evaluateRun(db, runId);
  const shape = metrics.perShape.find((s) => s.shape === "many-to-one");

  const rows = await db.select().from(exceptions).where(eq(exceptions.runId, runId));
  const ambiguous = rows.filter((row) => row.recommendedRecordIds.length > 1);

  return {
    scenario: "many-to-one-exception",
    headline: "Three identical credits from one merchant on one day. The correct answer is to refuse.",
    steps: [
      {
        step: "Truth pairs in the trap",
        outcome: String(shape?.truthPairs ?? 0),
        detail: "Same amount, same day, same counterparty, references mangled past recognition.",
        ok: (shape?.truthPairs ?? 0) > 0,
      },
      {
        step: "Resolved confidently",
        outcome: String(shape?.truePairs ?? 0) + " correct, " + String(shape?.falsePairs ?? 0) + " wrong",
        detail:
          "Zero of each is the target. Guessing right here is luck, and a system that guesses right on this corpus will guess wrong on the next one.",
        ok: (shape?.falsePairs ?? 0) === 0,
      },
      {
        step: "Reached a person",
        outcome: String(shape?.exceptionPairs ?? 0) + " of " + String(shape?.truthPairs ?? 0) + " pairs",
        detail:
          "Every candidate within the ambiguity margin is attached to the exception, not just the best one. A queue that offers one option where three are indistinguishable invites the reviewer to approve the first plausible one.",
        ok: (shape?.exceptionPairs ?? 0) > 0,
      },
      {
        step: "Silently lost",
        outcome: String(shape?.missedPairs ?? 0) + " pairs",
        detail: "A pair that is neither matched nor queued is the failure nobody finds out about.",
        ok: (shape?.missedPairs ?? 0) === 0,
      },
      {
        step: "Multi-candidate exceptions in the queue",
        outcome: String(ambiguous.length),
        detail: "Each one shows the reviewer every indistinguishable option side by side.",
        ok: ambiguous.length > 0,
      },
    ],
    links: [{ label: "Open the exception queue", href: "/exceptions" }],
    passed: (shape?.falsePairs ?? 0) === 0 && (shape?.missedPairs ?? 0) === 0,
  };
}

async function missingCounterpart(db: Database): Promise<DemoResult> {
  const runId = await latestSystemRunId(db);
  const rows = await db.select().from(exceptions).where(eq(exceptions.runId, runId));
  const missing = rows.filter((row) => row.kind === "MISSING_COUNTERPART");
  const amount = missing.reduce((sum, row) => sum + row.amountAtRiskMinor, 0);

  return {
    scenario: "missing-counterpart",
    headline: "An order that never settled. Nothing to match, and that is the finding.",
    steps: [
      {
        step: "Missing counterparts flagged",
        outcome: String(missing.length),
        detail: "Orders with no settlement and no bank credit anywhere in the corpus.",
        ok: missing.length > 0,
      },
      {
        step: "Money involved",
        outcome: inr(amount),
        detail:
          "This is the number a controller acts on: revenue recognised in the books that never arrived in the bank.",
        ok: true,
      },
      {
        step: "Reported as absence, not as failure",
        outcome: "MISSING_COUNTERPART",
        detail:
          "There is nothing here the matcher could have got wrong. Filing it as a low-confidence match would put a decision where there is no evidence.",
        ok: true,
      },
    ],
    links: [{ label: "Open the exception queue", href: "/exceptions?kind=MISSING_COUNTERPART" }],
    passed: missing.length > 0,
  };
}

async function baselineVsSystem(db: Database): Promise<DemoResult> {
  const systemRunId = await latestSystemRunId(db);
  const existing = await db.select().from(matchRuns).where(eq(matchRuns.strategy, "baseline-exact"));
  const baselineId =
    existing.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id ??
    (await reconcile(db, { strategy: "baseline-exact", label: "Baseline: exact join" })).runId;

  const comparison = await compareWithBaseline(db, systemRunId, baselineId);
  const { system, regressions } = comparison;
  const baseline = comparison.baseline;
  if (!baseline) throw new AppError("RUN_NOT_FOUND", "The baseline run could not be evaluated.");

  return {
    scenario: "baseline-vs-ai",
    headline: "The comparison the README leads with, run live.",
    steps: [
      {
        step: "Recall",
        outcome: baseline.recall.toFixed(3) + " → " + system.recall.toFixed(3),
        detail: "The engine recovers pairs the exact join cannot see at all: fee-deducted, lagged, mistyped.",
        ok: system.recall > baseline.recall,
      },
      {
        step: "Precision",
        outcome: baseline.precision.toFixed(3) + " → " + system.precision.toFixed(3),
        detail:
          "An exact join is precise because it declines constantly. Holding precision while raising recall is the only version of this that is worth anything.",
        ok: system.precision >= baseline.precision - 0.02,
      },
      {
        step: "False matches",
        outcome: baseline.falsePairs + " → " + system.falsePairs,
        detail: "The expensive error. Money posted against the wrong invoice.",
        ok: system.falsePairs <= baseline.falsePairs,
      },
      {
        step: "Unresolved records",
        outcome: baseline.unresolvedCount + " → " + system.unresolvedCount,
        detail: "Records the system could say nothing at all about.",
        ok: system.unresolvedCount <= baseline.unresolvedCount,
      },
      {
        step: "Where the baseline still wins",
        outcome: regressions.length === 0 ? "nothing on this run" : regressions.length + " findings",
        detail:
          regressions.length === 0
            ? "On this corpus. Not a general claim: a ledger with clean references and no fees would let the baseline tie on everything and cost less."
            : regressions.join(" "),
        ok: true,
      },
    ],
    links: [{ label: "Full evaluation", href: "/evaluation" }],
    passed: system.recall > baseline.recall && system.falsePairs <= baseline.falsePairs,
  };
}

/** Exercises the malformed-input path so the demo can show it refusing. */
export function malformedIngestProbe(): { rejected: string[]; accepted: number } {
  const csv = [
    "external_id,reference,amount_minor,currency,value_date,counterparty",
    "BK900001,RZP999001,120000,INR,2026-07-01,Blue Tokai",
    "BK900002,RZP999002,not-a-number,INR,2026-07-01,Blue Tokai",
    "BK900003,RZP999003,120000,INR,definitely-not-a-date,Blue Tokai",
    ",RZP999004,120000,INR,2026-07-01,Blue Tokai",
    "BK900005,RZP999005,120000,RUPEES,2026-07-01,Blue Tokai",
  ].join("\n");

  const { rows, skipped } = parseCsv(csv, "BANK_STATEMENT");
  return { rejected: skipped.map((s) => "line " + s.line + ": " + s.reason), accepted: rows.length };
}

export async function recordCount(db: Database): Promise<number> {
  const rows = await db.select({ id: records.id }).from(records);
  return rows.length;
}

export async function matchCount(db: Database, runId: string): Promise<number> {
  const rows = await db.select({ id: matches.id }).from(matches).where(eq(matches.runId, runId));
  return rows.length;
}
