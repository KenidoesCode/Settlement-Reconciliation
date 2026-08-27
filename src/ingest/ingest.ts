import { eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { records, sources, type SourceKind } from "../db/schema";
import { normalizeCounterparty, normalizeReference } from "./normalize";
import { generateCorpus, type GeneratedRecord, DATASET_VERSION } from "./generate";
import { appendReceipt } from "../shared/audit";
import { AppError } from "../shared/errors";
import { getEnv } from "../shared/env";
import { deterministicId, newCorrelationId, newId } from "../shared/ids";
import { logger } from "../shared/logger";

/**
 * Ingestion.
 *
 * Normalizes, deduplicates and records. Deduplication happens HERE and not in
 * the matcher, because a duplicate that reaches the matcher becomes a plausible
 * second match for money that only moved once -- the failure a controller
 * notices last and cares about most.
 *
 * A duplicate is not deleted. It is stored with `duplicateOfId` pointing at the
 * row it repeats, and excluded from matching. "The bank sent this line twice"
 * is a fact about the bank, and deleting the evidence would make it
 * unavailable exactly when someone is asking why a figure moved.
 */

export interface IngestResult {
  sourceIds: Record<string, string>;
  inserted: number;
  duplicates: number;
  datasetVersion: string;
  seed: number;
}

const SOURCE_LABELS: Record<SourceKind, string> = {
  PG_PAYMENT: "Razorpay payments (test mode, simulated)",
  ORDER: "Order management system",
  SETTLEMENT: "Razorpay settlements (test mode, simulated)",
  BANK_STATEMENT: "Bank statement — current account",
  INVOICE: "Invoicing system",
};

export async function ingestGeneratedCorpus(db: Database, seed?: number): Promise<IngestResult> {
  const env = getEnv();
  const correlationId = newCorrelationId();
  const effectiveSeed = seed ?? env.SEED;
  const corpus = generateCorpus(effectiveSeed);

  const sourceIds: Record<string, string> = {};
  for (const kind of Object.keys(SOURCE_LABELS) as SourceKind[]) {
    const id = deterministicId("src", kind);
    sourceIds[kind] = id;
    await db
      .insert(sources)
      .values({ id, kind, label: SOURCE_LABELS[kind], origin: "generated:seed-" + effectiveSeed, rowCount: 0 })
      .onConflictDoNothing();
  }

  const seen = new Map<string, string>();
  const rows: (typeof records.$inferInsert)[] = [];
  let duplicates = 0;

  for (const record of corpus.records) {
    const sourceId = sourceIds[record.sourceKind] as string;
    const key = sourceId + "|" + record.externalId;
    const existing = seen.get(key);

    const id = newId("rec");
    if (existing) duplicates += 1;

    rows.push({
      id,
      sourceId,
      kind: record.sourceKind,
      // A redelivered row keeps its own row identity but a distinct external id,
      // because the unique index is what makes the duplicate detectable at all.
      externalId: existing ? record.externalId + "#dup" + duplicates : record.externalId,
      reference: record.reference,
      normalizedReference: normalizeReference(record.reference),
      amountMinor: record.amountMinor,
      currency: record.currency,
      feeMinor: record.feeMinor,
      taxMinor: record.taxMinor,
      counterparty: record.counterparty,
      normalizedCounterparty: normalizeCounterparty(record.counterparty),
      occurredAt: record.occurredAt,
      valueDate: record.valueDate,
      truthGroupId: record.truthGroupId,
      raw: record.raw,
      duplicateOfId: existing ?? null,
    });

    if (!existing) seen.set(key, id);
  }

  // Chunked: a single insert of two thousand rows exceeds the parameter limit
  // on a real PostgreSQL connection, and discovering that in production rather
  // than here would be avoidable.
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(records).values(rows.slice(i, i + 200)).onConflictDoNothing();
  }

  for (const kind of Object.keys(SOURCE_LABELS) as SourceKind[]) {
    const count = rows.filter((row) => row.kind === kind).length;
    await db.update(sources).set({ rowCount: count }).where(eq(sources.id, sourceIds[kind] as string));
  }

  await appendReceipt(db, {
    eventType: "INGEST",
    correlationId,
    payload: {
      datasetVersion: DATASET_VERSION,
      seed: effectiveSeed,
      inserted: rows.length,
      duplicates,
      sources: Object.keys(SOURCE_LABELS),
      synthetic: true,
    },
  });

  logger.info("ingest_complete", { inserted: rows.length, duplicates, seed: effectiveSeed });

  return { sourceIds, inserted: rows.length, duplicates, datasetVersion: DATASET_VERSION, seed: effectiveSeed };
}

/* -------------------------------------------------------------------------- */
/* CSV ingestion                                                              */
/* -------------------------------------------------------------------------- */

const REQUIRED_COLUMNS = ["external_id", "amount_minor", "currency", "value_date"];

/**
 * Parses an uploaded CSV.
 *
 * Deliberately strict. A reconciliation tool takes files from strangers, and a
 * lenient parser that guesses at a malformed row will eventually guess an
 * amount. Size and row limits are enforced before parsing, not after, because a
 * limit checked after the work is done is not a limit.
 */
export function parseCsv(
  text: string,
  kind: SourceKind,
): { rows: GeneratedRecord[]; skipped: { line: number; reason: string }[] } {
  const env = getEnv();

  if (text.length > env.MAX_UPLOAD_BYTES) {
    throw new AppError("INGEST_TOO_LARGE", "The file exceeds " + env.MAX_UPLOAD_BYTES + " bytes.");
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new AppError("INGEST_MALFORMED", "The file is empty.");
  if (lines.length - 1 > env.MAX_ROWS_PER_FILE) {
    throw new AppError("INGEST_TOO_LARGE", "The file has more than " + env.MAX_ROWS_PER_FILE + " rows.");
  }

  const header = (lines[0] as string).split(",").map((column) => column.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new AppError("INGEST_MALFORMED", "Missing required columns: " + missing.join(", ") + ".", {
      required: REQUIRED_COLUMNS,
      found: header,
    });
  }

  const index = (name: string): number => header.indexOf(name);
  const rows: GeneratedRecord[] = [];
  const skipped: { line: number; reason: string }[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const externalId = cells[index("external_id")];
    const amountRaw = cells[index("amount_minor")];
    const currency = cells[index("currency")];
    const valueDateRaw = cells[index("value_date")];

    if (!externalId) {
      skipped.push({ line: i + 1, reason: "no external_id" });
      continue;
    }
    const amountMinor = Number.parseInt(amountRaw ?? "", 10);
    if (!Number.isSafeInteger(amountMinor)) {
      // Rejected, never coerced. A row whose amount cannot be parsed exactly is
      // a row whose amount is unknown, and a reconciliation built on a guessed
      // amount is worse than one with a gap in it.
      skipped.push({ line: i + 1, reason: "amount_minor is not an exact integer" });
      continue;
    }
    const valueDate = new Date(valueDateRaw ?? "");
    if (Number.isNaN(valueDate.getTime())) {
      skipped.push({ line: i + 1, reason: "value_date is not a date" });
      continue;
    }
    if (!currency || currency.length !== 3) {
      skipped.push({ line: i + 1, reason: "currency is not a three-letter code" });
      continue;
    }

    rows.push({
      sourceKind: kind,
      externalId,
      reference: cells[index("reference")] ?? null,
      amountMinor,
      currency: currency.toUpperCase(),
      feeMinor: Number.parseInt(cells[index("fee_minor")] ?? "0", 10) || 0,
      taxMinor: Number.parseInt(cells[index("tax_minor")] ?? "0", 10) || 0,
      counterparty: cells[index("counterparty")] ?? null,
      occurredAt: valueDate,
      valueDate,
      // Uploaded rows have no ground truth, and inventing one would corrupt
      // every metric computed afterwards.
      truthGroupId: null,
      raw: Object.fromEntries(header.map((column, position) => [column, cells[position] ?? null])),
    });
  }

  return { rows, skipped };
}

export async function ingestRows(
  db: Database,
  kind: SourceKind,
  rows: GeneratedRecord[],
  origin: string,
): Promise<{ sourceId: string; inserted: number; duplicates: number }> {
  const correlationId = newCorrelationId();
  const sourceId = deterministicId("src", kind);

  await db
    .insert(sources)
    .values({ id: sourceId, kind, label: SOURCE_LABELS[kind], origin, rowCount: 0 })
    .onConflictDoNothing();

  const existing = await db.select({ externalId: records.externalId }).from(records).where(eq(records.sourceId, sourceId));
  const known = new Set(existing.map((row) => row.externalId));

  let duplicates = 0;
  const values: (typeof records.$inferInsert)[] = [];

  for (const row of rows) {
    if (known.has(row.externalId)) {
      duplicates += 1;
      continue;
    }
    known.add(row.externalId);
    values.push({
      id: newId("rec"),
      sourceId,
      kind,
      externalId: row.externalId,
      reference: row.reference,
      normalizedReference: normalizeReference(row.reference),
      amountMinor: row.amountMinor,
      currency: row.currency,
      feeMinor: row.feeMinor,
      taxMinor: row.taxMinor,
      counterparty: row.counterparty,
      normalizedCounterparty: normalizeCounterparty(row.counterparty),
      occurredAt: row.occurredAt,
      valueDate: row.valueDate,
      truthGroupId: null,
      raw: row.raw,
      duplicateOfId: null,
    });
  }

  for (let i = 0; i < values.length; i += 200) {
    await db.insert(records).values(values.slice(i, i + 200)).onConflictDoNothing();
  }

  await appendReceipt(db, {
    eventType: "INGEST_UPLOAD",
    correlationId,
    payload: { kind, origin, inserted: values.length, duplicates },
  });

  return { sourceId, inserted: values.length, duplicates };
}
