import { closeDb, currentDriver, getRawDb, runMigrations } from "../src/db/client";
import { getEnv } from "../src/shared/env";
import { logger } from "../src/shared/logger";

async function main(): Promise<void> {
  const env = getEnv();
  const driver = await currentDriver();
  await getRawDb();
  const started = Date.now();
  await runMigrations();
  logger.info("migrations_applied", { driver, durationMs: Date.now() - started });
  process.stdout.write(
    `Migrations applied (driver: ${driver}, demo scenario: ${env.DEMO_SCENARIO}).\n`,
  );
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    process.stderr.write(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
