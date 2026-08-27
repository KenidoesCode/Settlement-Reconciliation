import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("pglite://.data/reconciliation"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SEED: z.coerce.number().int().default(20260828),

  /**
   * The adjudicator for ambiguous candidates.
   *
   * `deterministic` is the shipped default and the one every number in the
   * README was produced by. `openai` / `anthropic` route ambiguous pairs to a
   * model. The distinction is surfaced in every evaluation result rather than
   * left implicit, because a match rate produced by a model and one produced by
   * a scorer are different claims.
   */
  ADJUDICATOR: z.enum(["deterministic", "openai", "anthropic"]).default("deterministic"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default(""),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(6000),

  DEMO_SCENARIO: z
    .enum(["clean-batch", "fee-mismatch", "many-to-one-exception", "missing-counterpart", "baseline-vs-ai"])
    .default("clean-batch"),

  /** Ingestion limits. A reconciliation tool takes files from strangers. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(2_000_000),
  MAX_ROWS_PER_FILE: z.coerce.number().int().default(20_000),
});

export type Env = z.infer<typeof Schema> & {
  dbDriver: "postgres" | "pglite";
  pglitePath: string;
  pgliteInMemory: boolean;
  adjudicatorAvailable: boolean;
};

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = Schema.parse(process.env);
  const isPglite = parsed.DATABASE_URL.startsWith("pglite://");
  const target = isPglite ? parsed.DATABASE_URL.slice("pglite://".length) : "";

  cached = {
    ...parsed,
    dbDriver: isPglite ? "pglite" : "postgres",
    pglitePath: target || ".data/reconciliation",
    pgliteInMemory: target === ":memory:" || target === "",
    // A model adjudicator with no key is not configured, whatever the variable
    // says. Reporting it as available would put a model in the architecture
    // diagram that never ran.
    adjudicatorAvailable: parsed.ADJUDICATOR === "deterministic" || parsed.LLM_API_KEY.trim().length > 0,
  };
  return cached;
}

export function resetEnv(): void {
  cached = null;
}

export function environmentStatus() {
  const env = getEnv();
  return {
    nodeEnv: env.NODE_ENV,
    database: { driver: env.dbDriver, target: env.dbDriver === "pglite" ? env.pglitePath : "postgres" },
    adjudicator: {
      configured: env.ADJUDICATOR,
      /** What will actually run. Falls back rather than failing the batch. */
      effective: env.adjudicatorAvailable ? env.ADJUDICATOR : "deterministic",
      apiKeyPresent: env.LLM_API_KEY.trim().length > 0,
      model: env.LLM_MODEL || null,
    },
    seed: env.SEED,
    limits: { maxUploadBytes: env.MAX_UPLOAD_BYTES, maxRowsPerFile: env.MAX_ROWS_PER_FILE },
  };
}
