import { closeDb, getDb } from "../src/db/client";
import { ensureBootstrapped } from "../src/db/bootstrap";
import { reconcile } from "../src/match/reconcile";

async function main(): Promise<void> {
  await ensureBootstrapped();
  const db = await getDb();
  const strategy = process.argv.includes("--baseline")
    ? "baseline-exact"
    : process.argv.includes("--no-adjudicator")
      ? "fuzzy"
      : "fuzzy+adjudicator";
  const result = await reconcile(db, { strategy, label: strategy });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
