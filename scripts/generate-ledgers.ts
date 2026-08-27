import { closeDb, getDb } from "../src/db/client";
import { runMigrations } from "../src/db/client";
import { ingestGeneratedCorpus } from "../src/ingest/ingest";

async function main(): Promise<void> {
  await runMigrations();
  const db = await getDb();
  const seedArg = process.argv.find((arg) => arg.startsWith("--seed="));
  const seed = seedArg ? Number.parseInt(seedArg.split("=")[1] ?? "", 10) : undefined;
  const result = await ingestGeneratedCorpus(db, Number.isFinite(seed) ? seed : undefined);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("SYNTHETIC DATA. No real ledger, no live credential, no Razorpay call.\n");
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
