import path from "node:path";
import { mkdir } from "node:fs/promises";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

import * as schema from "./schema";
import { getEnv } from "../shared/env";
import { logger } from "../shared/logger";

/**
 * Two drivers, one dialect.
 *
 * `postgres://...`  -> node-postgres against a real PostgreSQL server.
 * `pglite://<path>` -> PGlite, which is PostgreSQL itself compiled to WASM and
 *                      run in-process with a file-backed data directory.
 *
 * PGlite is the default so the harness runs end-to-end with no external
 * infrastructure. It is real PostgreSQL - the same SQL, the same migrations,
 * the same jsonb/bigserial/index semantics - not a shim or an emulation, which
 * is why the migration files are shared verbatim between both drivers.
 *
 * An audit ledger whose own test suite runs against a mocked repository would
 * be asserting integrity it never demonstrated, so every test in this project
 * opens a real in-process PostgreSQL instance instead. The append-only
 * constraints in the migrations are enforced by PostgreSQL, not by application
 * code, and a mock could not enforce them at all.
 */
export type Database = NodePgDatabase<typeof schema>;

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "db/migrations");

interface Handle {
  db: Database;
  close: () => Promise<void>;
  driver: "postgres" | "pglite";
  migrated: boolean;
}

let handle: Handle | null = null;
let connecting: Promise<Handle> | null = null;

async function openPglite(dataDir: string | undefined): Promise<Handle> {
  if (dataDir) {
    // PGlite creates its own data directory but not the parents above it.
    await mkdir(path.dirname(dataDir), { recursive: true });
  }
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  return {
    db,
    driver: "pglite",
    migrated: false,
    close: async () => {
      await client.close();
    },
  };
}

async function openPostgres(connectionString: string): Promise<Handle> {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzleNodePg(pool, { schema });
  return {
    db,
    driver: "postgres",
    migrated: false,
    close: async () => {
      await pool.end();
    },
  };
}

async function open(): Promise<Handle> {
  const env = getEnv();
  if (env.dbDriver === "pglite") {
    // `pglite://:memory:` opens an ephemeral database inside the process.
    //
    // This exists for serverless hosts, where the filesystem is read-only apart
    // from an ephemeral /tmp and nothing written survives an invocation anyway.
    // Writing to disk there would fail on the first request or silently lose
    // every row, and a deployment that looks alive while losing its data is
    // worse than one that states the limitation.
    if (env.pgliteInMemory) {
      logger.debug("db_open", { driver: "pglite", dataDir: ":memory:" });
      return openPglite(undefined);
    }
    const dir = path.resolve(process.cwd(), env.pglitePath);
    logger.debug("db_open", { driver: "pglite", dataDir: dir });
    return openPglite(dir);
  }
  logger.debug("db_open", { driver: "postgres" });
  return openPostgres(env.DATABASE_URL);
}

/** Applies every generated migration. Safe to call repeatedly. */
const migrating = new WeakMap<Handle, Promise<void>>();

/**
 * Applies every generated migration, at most once per handle.
 *
 * The in-flight promise is memoised rather than guarded by a boolean set on
 * completion. A boolean set at the end is not concurrency-safe: a page issuing
 * several queries at once produces simultaneous calls that all observe
 * `migrated === false`, all start migrating, and all but the first fail with
 * `relation "..." already exists`. It is invisible locally, where the database
 * is usually already migrated on disk, and surfaces as a 500 on the first
 * request to a cold serverless instance.
 */
export async function runMigrations(target?: Handle): Promise<void> {
  const h = target ?? (await getHandle());
  if (h.migrated) return;

  const inFlight = migrating.get(h);
  if (inFlight) return inFlight;

  const run = (async () => {
    if (h.driver === "pglite") {
      await migratePglite(h.db as unknown as PgliteDatabase<typeof schema>, {
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    } else {
      await migrateNodePg(h.db, { migrationsFolder: MIGRATIONS_FOLDER });
    }
    h.migrated = true;
  })().catch((error: unknown) => {
    // A failed migration must not be cached, or the process would serve a
    // half-built schema for the rest of its life.
    migrating.delete(h);
    throw error;
  });

  migrating.set(h, run);
  return run;
}

async function getHandle(): Promise<Handle> {
  if (handle) return handle;
  if (!connecting) {
    connecting = open().then((h) => {
      handle = h;
      connecting = null;
      return h;
    });
  }
  return connecting;
}

/**
 * The shared database handle. Migrations are applied on first use so that a
 * freshly cloned checkout works without a manual migrate step - `db:migrate`
 * remains available for explicit control and for CI.
 */
export async function getDb(): Promise<Database> {
  const h = await getHandle();
  await runMigrations(h);
  return h.db;
}

/** Handle without the implicit migration - used by the migrate script itself. */
export async function getRawDb(): Promise<Database> {
  const h = await getHandle();
  return h.db;
}

export async function closeDb(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
  connecting = null;
}

export async function currentDriver(): Promise<"postgres" | "pglite"> {
  return (await getHandle()).driver;
}

/**
 * Isolated, migrated, in-memory PostgreSQL for tests. Each call yields a fresh
 * database with no shared state, which is what lets the integration and
 * evaluation suites run real SQL without a server and without cross-test
 * contamination.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const h = await openPglite(undefined);
  await runMigrations(h);
  return { db: h.db, close: h.close };
}

export { schema };
