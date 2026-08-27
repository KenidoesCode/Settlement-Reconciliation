import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/reconciliation",
  },
  verbose: true,
  strict: true,
} satisfies Config;
