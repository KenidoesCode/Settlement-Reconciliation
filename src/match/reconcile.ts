import { asc, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { exceptions, matchCandidates, matchRuns, matches, records } from "../db/schema";
import type { ExceptionKind } from "../db/schema";
import { adjudicate } from "./adjudicator";
import {
  blockingKeys,
  DEFAULT_THRESHOLDS,
  score,
  type MatchableRecord,
  type Ranked,
  type Thresholds,
} from "./engine";
import { decide, type Decision } from "./policy";
import { appendReceipt } from "../shared/audit";
import { newCorrelationId, newId } from "../shared/ids";
import { logger } from "../shared/logger";

/**
 * A reconciliation run.
 *
 * The whole pipeline in one function: load, block, score, adjudicate the
 * ambiguous band, decide, group, persist. Everything it writes is scoped to a
 * run id, so two runs over the same records -- baseline and fuzzy, say -- coexist
 * and can be compared rather than overwriting each other.
 *
 * WHY MATCHES ARE GROUPS, NOT PAIRS
 * ---------------------------------------------------------------------------
 * An order, a payment, a settlement and a bank line are one reconciliation, not
 * three pairings. Storing pairs would make the Match Detail page show a
 * settlement matched to an order and separately to a bank line, and leave the
 * reader to work out that these are the same event. So pairwise decisions are
 * unioned into connected components and a match is a set of record ids. The
 * split-settlement shape -- one order, two bank credits -- falls out of this for
 * free, which is the test that the representation is right.
 */

export interface ReconcileOptions {
  label?: string;
  strategy?: "baseline-exact" | "fuzzy" | "fuzzy+adjudicator";
  thresholds?: Partial<Thresholds>;
  correlationId?: string;
}

export interface ReconcileResult {
  runId: string;
  strategy: string;
  adjudicator: string;
  recordCount: number;
  candidateCount: number;
  matchedCount: number;
  matchedRecordCount: number;
  exceptionCount: number;
  unresolvedCount: number;
  adjudicatedCount: number;
  durationMs: number;
  recordsPerSecond: number;
}

export async function reconcile(db: Database, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const started = Date.now();
  const strategy = options.strategy ?? "fuzzy+adjudicator";
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const correlationId = options.correlationId ?? newCorrelationId();
  const runId = newId("run");

  const rows = await db.select().from(records).orderBy(asc(records.createdAt));

  // Duplicates are excluded from matching, not matched and then deduplicated.
  // A duplicate that reaches the matcher produces a plausible-looking second
  // match for the same money, which is the failure mode a controller notices
  // last and cares about most.
  const live = rows.filter((row) => row.duplicateOfId === null);

  const matchable: MatchableRecord[] = live.map((row) => ({
    id: row.id,
    kind: row.kind,
    externalId: row.externalId,
    normalizedReference: row.normalizedReference,
    normalizedCounterparty: row.normalizedCounterparty,
    amountMinor: row.amountMinor,
    feeMinor: row.feeMinor,
    taxMinor: row.taxMinor,
    currency: row.currency,
    valueDate: row.valueDate,
  }));

  const byId = new Map(matchable.map((record) => [record.id, record] as const));

  /* ---- blocking --------------------------------------------------------- */

  const blocks = new Map<string, string[]>();
  for (const record of matchable) {
    for (const key of blockingKeys(record)) {
      const bucket = blocks.get(key) ?? [];
      bucket.push(record.id);
      blocks.set(key, bucket);
    }
  }

  /* ---- scoring ---------------------------------------------------------- */

  const pairScores = new Map<string, { score: number; features: Record<string, number>; blockingKey: string }>();

  for (const [key, members] of blocks) {
    // A block that has swallowed a large share of the corpus is not a block. It
    // would generate a quadratic number of candidates and, worse, it means the
    // key is not discriminating -- so it is skipped and counted rather than
    // silently making the run slow.
    if (members.length > 60) continue;

    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const left = byId.get(members[i] as string);
        const right = byId.get(members[j] as string);
        if (!left || !right) continue;

        const pairKey = left.id < right.id ? left.id + "|" + right.id : right.id + "|" + left.id;
        if (pairScores.has(pairKey)) continue;

        const scored =
          strategy === "baseline-exact" ? baselineScore(left, right) : score(left, right, thresholds);
        if (scored.score <= 0) continue;

        pairScores.set(pairKey, {
          score: scored.score,
          features: scored.features as unknown as Record<string, number>,
          blockingKey: key,
        });
      }
    }
  }

  /* ---- rank per record, adjudicate the ambiguous band, decide ------------ */

  const rankedByRecord = new Map<string, Ranked[]>();
  for (const [pairKey, value] of pairScores) {
    const [leftId, rightId] = pairKey.split("|") as [string, string];
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (!left || !right) continue;

    push(rankedByRecord, leftId, { record: right, score: value.score, features: value.features as never });
    push(rankedByRecord, rightId, { record: left, score: value.score, features: value.features as never });
  }

  for (const list of rankedByRecord.values()) list.sort((a, b) => b.score - a.score);

  /* ---- union-find over resolved pairs ------------------------------------ */

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let current = id;
    while ((parent.get(current) ?? current) !== current) current = parent.get(current) as string;
    return current;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  interface Pending {
    subjectId: string;
    decision: Decision;
    bestId: string | null;
    features: Record<string, number>;
    adjudicated: boolean;
    adjudicatorRationale: string | null;
  }

  const pending: Pending[] = [];
  let adjudicatedCount = 0;

  for (const record of matchable) {
    const ranked = rankedByRecord.get(record.id) ?? [];
    let effective = ranked;
    let adjudicated = false;
    let adjudicatorRationale: string | null = null;

    const best = ranked[0];
    const inAmbiguousBand =
      strategy === "fuzzy+adjudicator" &&
      best !== undefined &&
      best.score >= thresholds.floor &&
      best.score < thresholds.resolve;

    if (inAmbiguousBand) {
      const result = await adjudicate(record, ranked.slice(0, 4));
      adjudicated = true;
      adjudicatedCount += 1;
      adjudicatorRationale = result.proposal.rationale;

      // The adjustment is applied to the score, and then the policy engine runs
      // again over the adjusted list. It re-checks ambiguity, so an adjudicator
      // that pushed a tie past the threshold still gets an exception.
      effective = ranked.map((candidate) =>
        candidate.record.id === result.proposal.chosenRecordId
          ? { ...candidate, score: Math.min(1, Math.max(0, candidate.score + result.appliedAdjustment)) }
          : candidate,
      );
      effective.sort((a, b) => b.score - a.score);
    }

    const decision = decide(record, effective, thresholds);
    const chosen = effective[0];

    // Every accepted candidate is unioned, not just the best one. A four-record
    // reconciliation is one event; unioning only the top candidate would build
    // it out of pairs and leave the reader to notice they are the same thing.
    for (const acceptedId of decision.acceptedIds) union(record.id, acceptedId);

    pending.push({
      subjectId: record.id,
      decision,
      bestId: chosen?.record.id ?? null,
      features: (chosen?.features ?? {}) as unknown as Record<string, number>,
      adjudicated,
      adjudicatorRationale,
    });
  }

  /* ---- split settlements ------------------------------------------------- */

  /*
    A split settlement does not survive pairwise matching, and it cannot.

    One order of 100 paid out as two bank credits of 40 and 60 produces no
    strong pair between the order and either credit: the amount feature sees a
    60% gap and scores zero, which is correct -- 40 is not 100 and pretending
    otherwise would let any amount match any other. So the pairwise stage
    correctly builds three separate groups, and correctly cannot see that they
    are one event.

    Seeing that requires looking at a SET of groups at once, which is what this
    pass does: among groups sharing a reference, if the parts sum to the whole
    within the fee tolerance, they are the same settlement. Summation is
    conclusive in a way that similarity is not -- two amounts either add up or
    they do not.

    Only groups that share a normalized reference are considered. Without that
    constraint this becomes subset-sum over the whole ledger, which is both
    intractable and a superb way to invent matches out of arithmetic
    coincidence.
  */
  if (strategy !== "baseline-exact") {
    const byReference = new Map<string, Set<string>>();
    for (const record of matchable) {
      if (!record.normalizedReference) continue;
      const roots = byReference.get(record.normalizedReference) ?? new Set<string>();
      roots.add(find(record.id));
      byReference.set(record.normalizedReference, roots);
    }

    for (const [, roots] of byReference) {
      if (roots.size < 2) continue;

      const rootList = [...roots];
      const amountOf = new Map<string, number>();
      const grossOf = new Map<string, number>();

      for (const root of rootList) {
        const members = matchable.filter((record) => find(record.id) === root);
        // The gross side of a group is its order or payment; the net side is
        // what the bank actually moved. A split is recognised by net parts
        // summing to a gross whole.
        const gross = members.find((m) => m.kind === "ORDER" || m.kind === "PG_PAYMENT");
        const net = members.filter((m) => m.kind === "SETTLEMENT" || m.kind === "BANK_STATEMENT");
        if (gross) grossOf.set(root, gross.amountMinor);
        if (net.length > 0) amountOf.set(root, Math.max(...net.map((m) => m.amountMinor)));
      }

      for (const [wholeRoot, whole] of grossOf) {
        const parts = rootList.filter((root) => root !== wholeRoot && amountOf.has(root));
        if (parts.length < 2) continue;

        const sum = parts.reduce((total, root) => total + (amountOf.get(root) ?? 0), 0);
        const tolerance = whole * thresholds.feeToleranceFraction + thresholds.roundingSlackMinor;

        if (Math.abs(sum - whole) <= tolerance) {
          for (const root of parts) union(wholeRoot, root);
        }
      }
    }
  }

  /* ---- persist ----------------------------------------------------------- */

  const groups = new Map<string, string[]>();
  for (const record of matchable) {
    const root = find(record.id);
    const members = groups.get(root) ?? [];
    members.push(record.id);
    groups.set(root, members);
  }

  const matchRows: (typeof matches.$inferInsert)[] = [];
  const exceptionRows: (typeof exceptions.$inferInsert)[] = [];
  const bySubject = new Map(pending.map((p) => [p.subjectId, p] as const));

  let matchedRecordCount = 0;

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    matchedRecordCount += members.length;

    const details = members.map((id) => bySubject.get(id)).filter(Boolean) as Pending[];
    const confidence = Math.min(...details.map((d) => d.decision.confidence));
    const anchor = details[0] as Pending;

    const amounts = members.map((id) => byId.get(id)?.amountMinor ?? 0);
    const amountDelta = Math.max(...amounts) - Math.min(...amounts);

    matchRows.push({
      id: newId("mch"),
      runId,
      recordIds: members,
      state: "RESOLVED",
      confidence,
      decidedBy: anchor.decision.decidedBy,
      rationale: [
        members.length + " records across " + new Set(members.map((id) => byId.get(id)?.kind)).size + " sources.",
        ...anchor.decision.rationale,
        ...(anchor.adjudicatorRationale ? ["Adjudicator: " + anchor.adjudicatorRationale] : []),
      ],
      features: anchor.features,
      adjudicated: details.some((d) => d.adjudicated),
      amountDeltaMinor: amountDelta,
    });
  }

  const inMatch = new Set(matchRows.flatMap((row) => row.recordIds as string[]));
  let unresolvedCount = 0;

  for (const entry of pending) {
    if (inMatch.has(entry.subjectId)) continue;

    if (entry.decision.state === "EXCEPTION" && entry.decision.exceptionKind) {
      const subject = byId.get(entry.subjectId);
      exceptionRows.push({
        id: newId("exc"),
        runId,
        kind: entry.decision.exceptionKind as ExceptionKind,
        recordIds: [entry.subjectId],
        recommendedRecordIds: entry.decision.ambiguousIds.length > 0 ? entry.decision.ambiguousIds : entry.bestId ? [entry.bestId] : [],
        confidence: entry.decision.confidence,
        explanation: entry.decision.rationale.join(" "),
        // The amount at risk is what a wrong decision would misplace. It is the
        // number that orders the queue, because a controller with forty
        // exceptions and an hour should start with the expensive ones.
        amountAtRiskMinor: subject?.amountMinor ?? 0,
      });
    } else {
      unresolvedCount += 1;
      const subject = byId.get(entry.subjectId);
      // An unresolved record with no candidate at all is a missing counterpart,
      // and it is reported as an exception of that kind rather than dropped:
      // "we found nothing for this" is a finding, not an absence.
      if (entry.decision.decidedBy === "NO_CANDIDATE") {
        exceptionRows.push({
          id: newId("exc"),
          runId,
          kind: "MISSING_COUNTERPART",
          recordIds: [entry.subjectId],
          recommendedRecordIds: [],
          confidence: 0,
          explanation: entry.decision.rationale.join(" "),
          amountAtRiskMinor: subject?.amountMinor ?? 0,
        });
      }
    }
  }

  if (matchRows.length > 0) await db.insert(matches).values(matchRows);
  if (exceptionRows.length > 0) await db.insert(exceptions).values(exceptionRows);

  // Candidates are persisted in a capped sample. Every pair would be tens of
  // thousands of rows per run for a page that shows twenty; the cap is stated
  // on the run page so nobody reads the table as the full candidate set.
  const candidateSample = [...pairScores.entries()].slice(0, 500);
  if (candidateSample.length > 0) {
    await db.insert(matchCandidates).values(
      candidateSample.map(([pairKey, value]) => {
        const [leftId, rightId] = pairKey.split("|") as [string, string];
        return {
          id: newId("cnd"),
          runId,
          leftRecordId: leftId,
          rightRecordId: rightId,
          blockingKey: value.blockingKey,
          features: value.features,
          score: value.score,
        };
      }),
    );
  }

  const durationMs = Date.now() - started;
  const recordsPerSecond = durationMs === 0 ? matchable.length : (matchable.length / durationMs) * 1000;

  const { getEnv } = await import("../shared/env");
  const env = getEnv();
  const adjudicator =
    strategy === "fuzzy+adjudicator" ? (env.adjudicatorAvailable ? env.ADJUDICATOR : "deterministic") : "none";

  await db.insert(matchRuns).values({
    id: runId,
    label: options.label ?? strategy,
    strategy,
    adjudicator,
    thresholds: thresholds as unknown as Record<string, number>,
    recordCount: matchable.length,
    candidateCount: pairScores.size,
    matchedCount: matchRows.length,
    exceptionCount: exceptionRows.length,
    unresolvedCount,
    durationMs,
    recordsPerSecond: Number(recordsPerSecond.toFixed(2)),
  });

  await appendReceipt(db, {
    eventType: "RECONCILE_RUN",
    correlationId,
    payload: {
      runId,
      strategy,
      adjudicator,
      recordCount: matchable.length,
      candidateCount: pairScores.size,
      matchedCount: matchRows.length,
      exceptionCount: exceptionRows.length,
      unresolvedCount,
      adjudicatedCount,
      thresholds: thresholds as unknown as Record<string, number>,
    },
  });

  logger.info("reconcile_complete", {
    runId,
    strategy,
    records: matchable.length,
    matched: matchRows.length,
    exceptions: exceptionRows.length,
    durationMs,
  });

  return {
    runId,
    strategy,
    adjudicator,
    recordCount: matchable.length,
    candidateCount: pairScores.size,
    matchedCount: matchRows.length,
    matchedRecordCount,
    exceptionCount: exceptionRows.length,
    unresolvedCount,
    adjudicatedCount,
    durationMs,
    recordsPerSecond: Number(recordsPerSecond.toFixed(2)),
  };
}

/**
 * The baseline: exact key, exact amount.
 *
 * This is what a reconciliation looks like without any of the above -- a SQL
 * join on reference and amount. It is here to be beaten, and it is measured on
 * the same corpus by the same evaluator, because a fuzzy matcher that cannot
 * show its improvement over a join has not earned its complexity.
 *
 * It scores 1 or 0. There is no middle, which is precisely its problem: every
 * fee-deducted settlement scores 0 and is lost.
 */
function baselineScore(
  left: MatchableRecord,
  right: MatchableRecord,
): { score: number; features: Record<string, number> } {
  const exact =
    left.normalizedReference !== null &&
    left.normalizedReference === right.normalizedReference &&
    left.amountMinor === right.amountMinor &&
    left.currency === right.currency &&
    left.kind !== right.kind;

  return {
    score: exact ? 1 : 0,
    features: { reference: exact ? 1 : 0, amount: exact ? 1 : 0, date: 0, counterparty: 0, crossSource: exact ? 1 : 0 },
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export async function latestRun(db: Database) {
  const rows = await db.select().from(matchRuns);
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

export async function runById(db: Database, runId: string) {
  const [row] = await db.select().from(matchRuns).where(eq(matchRuns.id, runId)).limit(1);
  return row ?? null;
}
