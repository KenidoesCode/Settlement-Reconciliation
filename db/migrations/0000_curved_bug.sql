CREATE TABLE "audit_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"event_type" text NOT NULL,
	"correlation_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"previous_hash" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_run_id" text NOT NULL,
	"truth_group_id" text NOT NULL,
	"outcome" text NOT NULL,
	"confidence" real NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"match_run_id" text NOT NULL,
	"baseline_run_id" text,
	"dataset_version" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"record_ids" jsonb NOT NULL,
	"recommended_record_ids" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"explanation" text NOT NULL,
	"amount_at_risk_minor" bigint NOT NULL,
	"resolved_by_review_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"exception_id" text NOT NULL,
	"reviewer" text NOT NULL,
	"outcome" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"left_record_id" text NOT NULL,
	"right_record_id" text NOT NULL,
	"blocking_key" text NOT NULL,
	"features" jsonb NOT NULL,
	"score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"strategy" text NOT NULL,
	"adjudicator" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"record_count" integer NOT NULL,
	"candidate_count" integer NOT NULL,
	"matched_count" integer NOT NULL,
	"exception_count" integer NOT NULL,
	"unresolved_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"records_per_second" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"record_ids" jsonb NOT NULL,
	"state" text NOT NULL,
	"confidence" real NOT NULL,
	"decided_by" text NOT NULL,
	"rationale" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"adjudicated" boolean DEFAULT false NOT NULL,
	"amount_delta_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"reference" text,
	"normalized_reference" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"counterparty" text,
	"normalized_counterparty" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"value_date" timestamp with time zone NOT NULL,
	"truth_group_id" text,
	"raw" jsonb NOT NULL,
	"duplicate_of_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_receipts_sequence_key" ON "audit_receipts" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "audit_receipts_event_idx" ON "audit_receipts" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "evaluation_cases_run_idx" ON "evaluation_cases" USING btree ("evaluation_run_id");--> statement-breakpoint
CREATE INDEX "exceptions_run_idx" ON "exceptions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "exceptions_kind_idx" ON "exceptions" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "match_candidates_run_idx" ON "match_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "match_candidates_left_idx" ON "match_candidates" USING btree ("left_record_id");--> statement-breakpoint
CREATE INDEX "matches_run_idx" ON "matches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "matches_state_idx" ON "matches" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "records_source_external_key" ON "records" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "records_kind_idx" ON "records" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "records_normalized_reference_idx" ON "records" USING btree ("normalized_reference");--> statement-breakpoint
CREATE INDEX "records_amount_idx" ON "records" USING btree ("amount_minor");--> statement-breakpoint
CREATE INDEX "records_value_date_idx" ON "records" USING btree ("value_date");