import { desc } from "drizzle-orm";
import { sha256 } from "@noble/hashes/sha2.js";

import type { Database } from "../db/client";
import { auditReceipts } from "../db/schema";
import { newId } from "./ids";

/**
 * Hash-chained audit receipts.
 *
 * A reconciliation decision moves money in somebody's books, so the record of
 * what was decided has to be distinguishable from a record of what someone
 * later wished had been decided. Each receipt names the SHA-256 of its
 * predecessor's payload; remove or edit one and every receipt after it stops
 * linking, and the audit page reports where.
 *
 * The canonical form is a sorted-key JSON serialization, so the same payload
 * hashes the same regardless of how the object was built.
 */

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}

export function hashPayload(payload: unknown): string {
  const bytes = sha256(new TextEncoder().encode(canonical(payload)));
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function appendReceipt(
  db: Database,
  input: { eventType: string; correlationId: string; payload: Record<string, unknown> },
): Promise<{ id: string; payloadHash: string }> {
  const [tail] = await db
    .select({ payloadHash: auditReceipts.payloadHash })
    .from(auditReceipts)
    .orderBy(desc(auditReceipts.sequence))
    .limit(1);

  const id = newId("aud");
  const payloadHash = hashPayload(input.payload);

  await db.insert(auditReceipts).values({
    id,
    eventType: input.eventType,
    correlationId: input.correlationId,
    payload: input.payload,
    payloadHash,
    previousHash: tail?.payloadHash ?? null,
  });

  return { id, payloadHash };
}

export interface ChainReport {
  count: number;
  intact: boolean;
  breaks: { sequence: number; id: string; claimed: string | null; actual: string | null }[];
  tampered: { sequence: number; id: string }[];
}

/** Walks the chain and re-hashes every payload. Both failures are distinct. */
export async function verifyChain(db: Database): Promise<ChainReport> {
  const rows = await db.select().from(auditReceipts).orderBy(auditReceipts.sequence);
  const breaks: ChainReport["breaks"] = [];
  const tampered: ChainReport["tampered"] = [];
  let previous: string | null = null;

  for (const row of rows) {
    if (hashPayload(row.payload) !== row.payloadHash) tampered.push({ sequence: row.sequence, id: row.id });
    if (row.previousHash !== previous) {
      breaks.push({ sequence: row.sequence, id: row.id, claimed: row.previousHash, actual: previous });
    }
    previous = row.payloadHash;
  }

  return { count: rows.length, intact: breaks.length === 0 && tampered.length === 0, breaks, tampered };
}
