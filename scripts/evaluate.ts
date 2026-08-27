import { desc, eq } from "drizzle-orm";

import { closeDb, getDb } from "../src/db/client";
import { ensureBootstrapped } from "../src/db/bootstrap";
import { matchRuns } from "../src/db/schema";
import { compareWithBaseline } from "../src/eval/evaluate";
import { reconcile } from "../src/match/reconcile";

async function main(): Promise<void> {
  await ensureBootstrapped();
  const db = await getDb();

  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const system = runs.find((run) => run.strategy !== "baseline-exact");
  if (!system) throw new Error("No reconciliation run to evaluate.");

  const existing = await db.select().from(matchRuns).where(eq(matchRuns.strategy, "baseline-exact"));
  const baselineId =
    existing.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id ??
    (await reconcile(db, { strategy: "baseline-exact", label: "Baseline: exact join" })).runId;

  const comparison = await compareWithBaseline(db, system.id, baselineId);
  process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");

  if (comparison.regressions.length > 0) {
    process.stdout.write("\nWHERE THE BASELINE WINS:\n");
    for (const regression of comparison.regressions) process.stdout.write("  - " + regression + "\n");
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
