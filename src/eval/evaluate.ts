import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { evaluationCases, evaluationRuns, exceptions, matchRuns, matches, records } from "../db/schema";
import { SHAPE_MIX, DATASET_VERSION, type ShapeKind } from "../ingest/generate";
import { AppError } from "../shared/errors";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";

/**
 * ===========================================================================
 * THE EVALUATION
 * ===========================================================================
 *
 * Ground truth is `truthGroupId`, written by the generator and read by nothing
 * except this file. The matcher has never seen it.
 *
 * WHAT IS COUNTED, AND WHY THESE DEFINITIONS AND NOT EASIER ONES
 * ---------------------------------------------------------------------------
 * The unit is a PAIR OF RECORDS, not a match group and not a record. Pairs are
 * the unit because a group of four correct records and a group of four with one
 * intruder are both "one match", and calling them both a success would hide the
 * intruder. Over pairs, the intruder shows up as three false pairs.
 *
 *   TRUE MATCH    a pair the system put together that shares a truth group.
 *   FALSE MATCH   a pair the system put together that does NOT. This is the
 *                 expensive error: money posted against the wrong invoice.
 *   MISSED        a pair sharing a truth group that the system did not put
 *                 together and did not raise as an exception either. Silently
 *                 lost.
 *   CORRECT EXCEPTION   a pair sharing a truth group that the system declined
 *                 to resolve and sent to a person. NOT counted as a miss. A
 *                 system that says "I cannot tell, look at this" has done its
 *                 job, and scoring it as a failure would push a designer toward
 *                 resolving everything.
 *
 * PRECISION uses true and false matches. RECALL uses true matches over all
 * truth pairs, so declining to match costs recall -- as it should -- while not
 * being counted as a false match, which it is not.
 *
 * The exception rate is reported beside both, because the way to make precision
 * 1.000 is to resolve almost nothing, and a reader has to be able to see that
 * happening.
 */

export interface ShapeResult {
  shape: ShapeKind;
  truthPairs: number;
  truePairs: number;
  falsePairs: number;
  exceptionPairs: number;
  missedPairs: number;
  recall: number;
}

export interface EvaluationMetrics {
  runId: string;
  strategy: string;
  adjudicator: string;
  datasetVersion: string;

  recordCount: number;
  matchedRecordCount: number;
  /** Share of records the system placed in a resolved match. */
  matchRate: number;

  truthPairs: number;
  proposedPairs: number;
  truePairs: number;
  falsePairs: number;
  missedPairs: number;
  exceptionPairs: number;

  precision: number;
  recall: number;
  f1: number;
  falseMatchRate: number;

  exceptionCount: number;
  unresolvedCount: number;
  /** Money sitting in the exception queue, unactioned. */
  amountInExceptionsMinor: number;

  throughputRecordsPerSecond: number;
  durationMs: number;

  /** Mean confidence of true vs false matches. If these are close, confidence is not informative. */
  meanConfidenceTrue: number;
  meanConfidenceFalse: number;
  calibrationBuckets: { bucket: string; pairs: number; truePairs: number; observedPrecision: number }[];

  perShape: ShapeResult[];
}

export interface ComparisonResult {
  evaluationRunId: string;
  system: EvaluationMetrics;
  baseline: EvaluationMetrics | null;
  /** Where the system loses to the baseline. Reported, not buried. */
  regressions: string[];
}

function pairKey(a: string, b: string): string {
  return a < b ? a + "|" + b : b + "|" + a;
}

export async function evaluateRun(db: Database, runId: string): Promise<EvaluationMetrics> {
  const [run] = await db.select().from(matchRuns).where(eq(matchRuns.id, runId)).limit(1);
  if (!run) throw new AppError("RUN_NOT_FOUND", "No reconciliation run " + runId + ".");

  const allRecords = await db.select().from(records);
  const live = allRecords.filter((row) => row.duplicateOfId === null);

  const withTruth = live.filter((row) => row.truthGroupId !== null);
  if (withTruth.length === 0) {
    throw new AppError(
      "EVALUATION_NO_GROUND_TRUTH",
      "No record carries a truth group. Precision and recall cannot be computed against uploaded data, and reporting them anyway would be inventing them.",
    );
  }

  const truthOf = new Map(live.map((row) => [row.id, row.truthGroupId] as const));
  const shapeOfGroup = new Map<string, ShapeKind>();
  for (const row of withTruth) {
    if (!row.truthGroupId) continue;
    // The generator encodes the shape into the group id, so the shape survives
    // into the database without a second table that could disagree with it.
    const shape = (row.truthGroupId.replace(/^grp_/, "").replace(/-\d+$/, "") as ShapeKind) ?? "clean";
    shapeOfGroup.set(row.truthGroupId, shape);
  }

  /* ---- truth pairs -------------------------------------------------------- */

  const groups = new Map<string, string[]>();
  for (const row of withTruth) {
    const members = groups.get(row.truthGroupId as string) ?? [];
    members.push(row.id);
    groups.set(row.truthGroupId as string, members);
  }

  const truthPairs = new Set<string>();
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        truthPairs.add(pairKey(members[i] as string, members[j] as string));
      }
    }
  }

  /* ---- proposed pairs ----------------------------------------------------- */

  const matchRows = await db.select().from(matches).where(eq(matches.runId, runId));
  const proposedPairs = new Map<string, number>();
  for (const match of matchRows) {
    const ids = match.recordIds;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        proposedPairs.set(pairKey(ids[i] as string, ids[j] as string), match.confidence);
      }
    }
  }

  /* ---- exception pairs ---------------------------------------------------- */

  const exceptionRows = await db.select().from(exceptions).where(eq(exceptions.runId, runId));
  const exceptionPairs = new Set<string>();
  for (const exception of exceptionRows) {
    for (const left of exception.recordIds) {
      for (const right of exception.recommendedRecordIds) {
        exceptionPairs.add(pairKey(left, right));
      }
    }
  }

  /* ---- classify ----------------------------------------------------------- */

  const cases: (typeof evaluationCases.$inferInsert)[] = [];
  const evaluationRunId = newId("evr");

  let truePairs = 0;
  let falsePairs = 0;
  const trueConfidences: number[] = [];
  const falseConfidences: number[] = [];
  const bucketCounts = new Map<string, { pairs: number; truePairs: number }>();

  for (const [key, confidence] of proposedPairs) {
    const [left, right] = key.split("|") as [string, string];
    const leftTruth = truthOf.get(left);
    const rightTruth = truthOf.get(right);
    const correct = leftTruth !== null && leftTruth !== undefined && leftTruth === rightTruth;

    if (correct) {
      truePairs += 1;
      trueConfidences.push(confidence);
    } else {
      falsePairs += 1;
      falseConfidences.push(confidence);
      cases.push({
        id: newId("evc"),
        evaluationRunId,
        truthGroupId: leftTruth ?? "(none)",
        outcome: "FALSE_MATCH",
        confidence,
        detail:
          "Paired " + left + " with " + right + " at confidence " + confidence.toFixed(3) + ", but they belong to different truth groups.",
      });
    }

    const bucket = confidenceBucket(confidence);
    const entry = bucketCounts.get(bucket) ?? { pairs: 0, truePairs: 0 };
    entry.pairs += 1;
    if (correct) entry.truePairs += 1;
    bucketCounts.set(bucket, entry);
  }

  let missedPairs = 0;
  let correctExceptionPairs = 0;
  for (const key of truthPairs) {
    if (proposedPairs.has(key)) continue;
    if (exceptionPairs.has(key)) {
      correctExceptionPairs += 1;
      continue;
    }
    missedPairs += 1;
  }

  /* ---- per shape ---------------------------------------------------------- */

  const perShape: ShapeResult[] = (Object.keys(SHAPE_MIX) as ShapeKind[]).map((shape) => {
    const shapeGroups = [...groups.entries()].filter(([groupId]) => shapeOfGroup.get(groupId) === shape);
    const shapeTruth = new Set<string>();
    for (const [, members] of shapeGroups) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          shapeTruth.add(pairKey(members[i] as string, members[j] as string));
        }
      }
    }

    let shapeTrue = 0;
    let shapeException = 0;
    let shapeMissed = 0;
    for (const key of shapeTruth) {
      if (proposedPairs.has(key)) shapeTrue += 1;
      else if (exceptionPairs.has(key)) shapeException += 1;
      else shapeMissed += 1;
    }

    const shapeRecordIds = new Set(shapeGroups.flatMap(([, members]) => members));
    let shapeFalse = 0;
    for (const [key] of proposedPairs) {
      const [left, right] = key.split("|") as [string, string];
      if (!shapeRecordIds.has(left) && !shapeRecordIds.has(right)) continue;
      const leftTruth = truthOf.get(left);
      if (leftTruth !== truthOf.get(right)) shapeFalse += 1;
    }

    return {
      shape,
      truthPairs: shapeTruth.size,
      truePairs: shapeTrue,
      falsePairs: shapeFalse,
      exceptionPairs: shapeException,
      missedPairs: shapeMissed,
      recall: shapeTruth.size === 0 ? 0 : shapeTrue / shapeTruth.size,
    };
  });

  /* ---- assemble ----------------------------------------------------------- */

  const matchedRecordIds = new Set(matchRows.flatMap((row) => row.recordIds));
  const precision = truePairs + falsePairs === 0 ? 0 : truePairs / (truePairs + falsePairs);
  const recall = truthPairs.size === 0 ? 0 : truePairs / truthPairs.size;

  const metrics: EvaluationMetrics = {
    runId,
    strategy: run.strategy,
    adjudicator: run.adjudicator,
    datasetVersion: DATASET_VERSION,

    recordCount: live.length,
    matchedRecordCount: matchedRecordIds.size,
    matchRate: live.length === 0 ? 0 : matchedRecordIds.size / live.length,

    truthPairs: truthPairs.size,
    proposedPairs: proposedPairs.size,
    truePairs,
    falsePairs,
    missedPairs,
    exceptionPairs: correctExceptionPairs,

    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number((precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)).toFixed(4)),
    falseMatchRate: Number(
      (truePairs + falsePairs === 0 ? 0 : falsePairs / (truePairs + falsePairs)).toFixed(4),
    ),

    exceptionCount: exceptionRows.length,
    unresolvedCount: run.unresolvedCount,
    amountInExceptionsMinor: exceptionRows.reduce((sum, row) => sum + row.amountAtRiskMinor, 0),

    throughputRecordsPerSecond: run.recordsPerSecond,
    durationMs: run.durationMs,

    meanConfidenceTrue: Number(mean(trueConfidences).toFixed(4)),
    meanConfidenceFalse: Number(mean(falseConfidences).toFixed(4)),
    calibrationBuckets: [...bucketCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bucket, value]) => ({
        bucket,
        pairs: value.pairs,
        truePairs: value.truePairs,
        observedPrecision: Number((value.pairs === 0 ? 0 : value.truePairs / value.pairs).toFixed(4)),
      })),

    perShape,
  };

  await db.insert(evaluationRuns).values({
    id: evaluationRunId,
    matchRunId: runId,
    datasetVersion: DATASET_VERSION,
    metrics: metrics as unknown as Record<string, unknown>,
  });

  if (cases.length > 0) {
    for (let i = 0; i < cases.length; i += 200) {
      await db.insert(evaluationCases).values(cases.slice(i, i + 200));
    }
  }

  logger.info("evaluation_complete", {
    runId,
    precision: metrics.precision,
    recall: metrics.recall,
    falseMatchRate: metrics.falseMatchRate,
  });

  return metrics;
}

function confidenceBucket(confidence: number): string {
  const lower = Math.floor(confidence * 10) / 10;
  return lower.toFixed(1) + "–" + (lower + 0.1).toFixed(1);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compares the system against the baseline and NAMES THE REGRESSIONS.
 *
 * A comparison that only lists where the system wins is marketing. The
 * regressions array is populated by the same code that computes the wins, so a
 * result where the baseline is better cannot be reported without the loss
 * appearing beside it.
 */
export async function compareWithBaseline(
  db: Database,
  systemRunId: string,
  baselineRunId: string,
): Promise<ComparisonResult> {
  const system = await evaluateRun(db, systemRunId);
  const baseline = await evaluateRun(db, baselineRunId);

  const regressions: string[] = [];
  if (baseline.precision > system.precision) {
    regressions.push(
      "The exact-join baseline is MORE precise: " +
        baseline.precision.toFixed(3) +
        " against " +
        system.precision.toFixed(3) +
        ". Fuzzy matching bought recall at a cost in precision, and on this corpus that trade is visible.",
    );
  }
  if (baseline.falseMatchRate < system.falseMatchRate) {
    regressions.push(
      "The baseline produces FEWER false matches: " +
        baseline.falseMatchRate.toFixed(4) +
        " against " +
        system.falseMatchRate.toFixed(4) +
        ". An exact join is wrong less often because it declines far more often.",
    );
  }
  if (baseline.throughputRecordsPerSecond > system.throughputRecordsPerSecond * 1.5) {
    regressions.push(
      "The baseline is " +
        (baseline.throughputRecordsPerSecond / Math.max(1, system.throughputRecordsPerSecond)).toFixed(1) +
        "x faster (" +
        baseline.throughputRecordsPerSecond.toFixed(0) +
        " against " +
        system.throughputRecordsPerSecond.toFixed(0) +
        " records/sec).",
    );
  }
  for (const shape of system.perShape) {
    const baselineShape = baseline.perShape.find((s) => s.shape === shape.shape);
    if (baselineShape && baselineShape.recall > shape.recall + 0.01) {
      regressions.push(
        "On the " +
          shape.shape +
          " shape the baseline recalls more: " +
          baselineShape.recall.toFixed(3) +
          " against " +
          shape.recall.toFixed(3) +
          ".",
      );
    }
  }

  const evaluationRunId = newId("evr");
  await db.insert(evaluationRuns).values({
    id: evaluationRunId,
    matchRunId: systemRunId,
    baselineRunId,
    datasetVersion: DATASET_VERSION,
    metrics: { system, baseline, regressions } as unknown as Record<string, unknown>,
  });

  return { evaluationRunId, system, baseline, regressions };
}

export async function latestComparison(db: Database) {
  const rows = await db.select().from(evaluationRuns);
  const withBaseline = rows.filter((row) => row.baselineRunId !== null);
  return withBaseline.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}
