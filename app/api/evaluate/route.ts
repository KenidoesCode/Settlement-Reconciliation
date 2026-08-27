import { z } from "zod";
import { desc, eq } from "drizzle-orm";

import { bodyRoute } from "@/api/handler";
import { matchRuns } from "@/db/schema";
import { compareWithBaseline, evaluateRun } from "@/eval/evaluate";
import { reconcile } from "@/match/reconcile";
import { AppError } from "@/shared/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Schema = z.object({
  runId: z.string().optional(),
  /** Reconcile a fresh baseline and compare against it. */
  withBaseline: z.boolean().default(true),
});

export const POST = bodyRoute(Schema, async ({ db }, body) => {
  const runId =
    body.runId ??
    (await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt)).limit(1))[0]?.id;
  if (!runId) throw new AppError("RUN_NOT_FOUND", "No reconciliation run to evaluate.");

  if (!body.withBaseline) return { evaluation: await evaluateRun(db, runId) };

  const existing = await db.select().from(matchRuns).where(eq(matchRuns.strategy, "baseline-exact"));
  const baselineId =
    existing.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id ??
    (await reconcile(db, { strategy: "baseline-exact", label: "Baseline: exact join" })).runId;

  return { comparison: await compareWithBaseline(db, runId, baselineId) };
});
