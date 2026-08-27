import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

export const SOURCE_KINDS = ["PG_PAYMENT", "ORDER", "SETTLEMENT", "BANK_STATEMENT", "INVOICE"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<SourceKind>().notNull(),
  label: text("label").notNull(),
  /** Where the rows came from. "generated" for the synthetic corpus. */
  origin: text("origin").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One normalized row from any source.
 *
 * ONE TABLE, NOT FIVE.
 * ---------------------------------------------------------------------------
 * Five source-shaped tables would mean five join paths, five normalizers and a
 * candidate generator with a branch per pair of sources -- ten branches for five
 * sources, and fifty-five if a sixth is added. The matcher does not care which
 * system a record came from; it cares about an amount, a date, a reference and a
 * counterparty. So the shape is one normalized record with the source kind as a
 * column, and the original row is kept verbatim in `raw` so nothing is lost and
 * the Match Detail page can show the record as it actually arrived.
 */
export const records = pgTable(
  "records",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").$type<SourceKind>().notNull(),

    /** The identifier this system uses for the row. Razorpay-shaped where applicable. */
    externalId: text("external_id").notNull(),
    /** The reference the counterparty is expected to quote. Often mangled. */
    reference: text("reference"),
    /** Reference after normalization: uppercased, punctuation stripped. */
    normalizedReference: text("normalized_reference"),

    /** Minor units, always. Signed: a payout to us is positive, a fee is negative. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /** Fees the source itself declares, where it declares them. */
    feeMinor: bigint("fee_minor", { mode: "number" }).notNull().default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),

    counterparty: text("counterparty"),
    normalizedCounterparty: text("normalized_counterparty"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The day the row lands in its own system, which is not the day it happened. */
    valueDate: timestamp("value_date", { withTimezone: true }).notNull(),

    /** Ground truth, HELD OUT of matching. See the evaluation module. */
    truthGroupId: text("truth_group_id"),

    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    /** Set when ingestion decided this row repeats one already present. */
    duplicateOfId: text("duplicate_of_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("records_source_external_key").on(t.sourceId, t.externalId),
    index("records_kind_idx").on(t.kind),
    index("records_normalized_reference_idx").on(t.normalizedReference),
    index("records_amount_idx").on(t.amountMinor),
    index("records_value_date_idx").on(t.valueDate),
  ],
);

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

export const matchRuns = pgTable("match_runs", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  strategy: text("strategy").$type<"baseline-exact" | "fuzzy" | "fuzzy+adjudicator">().notNull(),
  adjudicator: text("adjudicator").notNull(),
  /** Every threshold this run used, so a historical run stays interpretable. */
  thresholds: jsonb("thresholds").$type<Record<string, number>>().notNull(),
  recordCount: integer("record_count").notNull(),
  candidateCount: integer("candidate_count").notNull(),
  matchedCount: integer("matched_count").notNull(),
  exceptionCount: integer("exception_count").notNull(),
  unresolvedCount: integer("unresolved_count").notNull(),
  durationMs: integer("duration_ms").notNull(),
  recordsPerSecond: real("records_per_second").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matchCandidates = pgTable(
  "match_candidates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    leftRecordId: text("left_record_id").notNull(),
    rightRecordId: text("right_record_id").notNull(),
    blockingKey: text("blocking_key").notNull(),
    /** Per-feature scores, kept so a decision can be explained field by field. */
    features: jsonb("features").$type<Record<string, number>>().notNull(),
    score: real("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("match_candidates_run_idx").on(t.runId),
    index("match_candidates_left_idx").on(t.leftRecordId),
  ],
);

export const MATCH_STATES = ["RESOLVED", "EXCEPTION", "UNRESOLVED"] as const;
export type MatchState = (typeof MATCH_STATES)[number];

export const matches = pgTable(
  "matches",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** The set of record ids this match binds together. One-to-many is normal. */
    recordIds: jsonb("record_ids").$type<string[]>().notNull(),
    state: text("state").$type<MatchState>().notNull(),
    confidence: real("confidence").notNull(),
    /** Which rule decided it. Not a summary -- the actual deciding rule. */
    decidedBy: text("decided_by").notNull(),
    rationale: jsonb("rationale").$type<string[]>().notNull(),
    features: jsonb("features").$type<Record<string, number>>().notNull(),
    adjudicated: boolean("adjudicated").notNull().default(false),
    amountDeltaMinor: bigint("amount_delta_minor", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("matches_run_idx").on(t.runId), index("matches_state_idx").on(t.state)],
);

export const EXCEPTION_KINDS = [
  "AMBIGUOUS_MANY_TO_ONE",
  "AMOUNT_MISMATCH_BEYOND_FEE",
  "MISSING_COUNTERPART",
  "TIMING_BEYOND_WINDOW",
  "REFERENCE_UNRECOGNIZED",
  "DUPLICATE_SUSPECTED",
  "LOW_CONFIDENCE",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const exceptions = pgTable(
  "exceptions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind").$type<ExceptionKind>().notNull(),
    recordIds: jsonb("record_ids").$type<string[]>().notNull(),
    /** What the system would have done, had it been allowed to act alone. */
    recommendedRecordIds: jsonb("recommended_record_ids").$type<string[]>().notNull(),
    confidence: real("confidence").notNull(),
    explanation: text("explanation").notNull(),
    amountAtRiskMinor: bigint("amount_at_risk_minor", { mode: "number" }).notNull(),
    resolvedByReviewId: text("resolved_by_review_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("exceptions_run_idx").on(t.runId), index("exceptions_kind_idx").on(t.kind)],
);

export const humanReviews = pgTable("human_reviews", {
  id: text("id").primaryKey(),
  exceptionId: text("exception_id").notNull(),
  reviewer: text("reviewer").notNull(),
  outcome: text("outcome").$type<"APPROVED" | "REJECTED" | "ESCALATED">().notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hash-chained audit receipts.
 *
 * A reconciliation decision moves money in somebody's books. The chain is here
 * so an auditor can tell an amended record from an original one: each receipt
 * names the hash of its predecessor, and the whole chain is checked on the
 * audit page rather than assumed.
 */
export const auditReceipts = pgTable(
  "audit_receipts",
  {
    id: text("id").primaryKey(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    correlationId: text("correlation_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    previousHash: text("previous_hash"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("audit_receipts_sequence_key").on(t.sequence),
    index("audit_receipts_event_idx").on(t.eventType),
  ],
);

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

export const evaluationRuns = pgTable("evaluation_runs", {
  id: text("id").primaryKey(),
  matchRunId: text("match_run_id").notNull(),
  baselineRunId: text("baseline_run_id"),
  datasetVersion: text("dataset_version").notNull(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evaluationCases = pgTable(
  "evaluation_cases",
  {
    id: text("id").primaryKey(),
    evaluationRunId: text("evaluation_run_id").notNull(),
    truthGroupId: text("truth_group_id").notNull(),
    outcome: text("outcome").$type<"TRUE_MATCH" | "FALSE_MATCH" | "MISSED" | "CORRECT_EXCEPTION" | "WRONG_EXCEPTION">().notNull(),
    confidence: real("confidence").notNull(),
    detail: text("detail").notNull(),
  },
  (t) => [index("evaluation_cases_run_idx").on(t.evaluationRunId)],
);
