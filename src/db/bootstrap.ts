import { getDb, runMigrations } from "./client";
import { records } from "./schema";
import { ingestGeneratedCorpus } from "../ingest/ingest";
import { reconcile } from "../match/reconcile";
import { compareWithBaseline } from "../eval/evaluate";
import { getEnv } from "../shared/env";
import { logger } from "../shared/logger";
import { withDeterministicIds } from "../shared/ids";

/**
 * Bootstrap.
 *
 * A serverless instance starts with an empty in-memory database, so a
 * reconciliation dashboard populated only by a seed script would show an honest
 * and useless zero on every page. The corpus is generated, reconciled twice --
 * once with the exact-join baseline, once with the full engine -- and evaluated
 * during bootstrap, once per process.
 *
 * Both runs, not one. A dashboard that shows only the system's numbers cannot
 * answer "would a SQL join have done as well", which is the first question a
 * reviewer should ask and the one this project exists to answer.
 */

let bootstrapped: Promise<void> | null = null;

export async function ensureBootstrapped(): Promise<void> {
  if (bootstrapped) return bootstrapped;

  bootstrapped = (async () => {
    const env = getEnv();
    const started = Date.now();

    await runMigrations();
    const db = await getDb();

    const [existing] = await db.select({ id: records.id }).from(records).limit(1);
    if (existing) {
      logger.debug("bootstrap_skipped", { reason: "records already present" });
      return;
    }

    // Every id minted inside this block is a counter, not a clock. See the
    // comment in shared/ids.ts: separate serverless functions seed separate
    // in-memory databases, and without this they disagree about what each row
    // is called.
    const { ingested, comparison } = await withDeterministicIds(async () => {
      const ingestedCorpus = await ingestGeneratedCorpus(db);
      const baseline = await reconcile(db, { strategy: "baseline-exact", label: "Baseline: exact join" });
      const system = await reconcile(db, { strategy: "fuzzy+adjudicator", label: "Fuzzy + adjudicator" });
      return {
        ingested: ingestedCorpus,
        comparison: await compareWithBaseline(db, system.runId, baseline.runId),
      };
    });

    logger.info("bootstrap_complete", {
      durationMs: Date.now() - started,
      records: ingested.inserted,
      precision: comparison.system.precision,
      recall: comparison.system.recall,
      regressions: comparison.regressions.length,
      inMemory: env.pgliteInMemory,
    });
  })().catch((error: unknown) => {
    bootstrapped = null;
    throw error;
  });

  return bootstrapped;
}
