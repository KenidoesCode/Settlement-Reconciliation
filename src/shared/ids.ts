import { randomBytes } from "node:crypto";

export type IdPrefix = "src" | "rec" | "run" | "cnd" | "mch" | "exc" | "rev" | "aud" | "evr" | "evc" | "cor" | "grp";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function suffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

/**
 * ===========================================================================
 * DETERMINISTIC IDS DURING BOOTSTRAP
 * ===========================================================================
 * This deployment runs PGlite with an in-memory database, which on a serverless
 * host means EVERY FUNCTION INSTANCE HAS ITS OWN. The page renderer and the API
 * routes are separate functions, so they seed separate databases -- and with
 * time-and-random ids they seeded them with different identifiers.
 *
 * The visible consequence was that a run id returned by `/api/matches` gave a
 * 404 on `/matches/<id>`, and a link to a specific run stopped working minutes
 * later when a new instance came up. Both surfaces held correct data. They just
 * disagreed about what anything was called.
 *
 * So during bootstrap, ids come from a counter instead of the clock. Every
 * instance runs the same bootstrap in the same order and therefore mints the
 * same identifiers, and the two surfaces agree. Ids minted at REQUEST time stay
 * time-and-random, because those genuinely are unique events.
 *
 * What this does NOT fix, and nothing can without a shared database: a write
 * made at request time is still invisible to the next read, because it landed
 * in one instance's memory. That limitation is stated in the console rather
 * than hidden.
 */
let deterministicCounter: number | null = null;

export async function withDeterministicIds<T>(fn: () => Promise<T>): Promise<T> {
  deterministicCounter = 0;
  try {
    return await fn();
  } finally {
    deterministicCounter = null;
  }
}

export function newId(prefix: IdPrefix): string {
  if (deterministicCounter !== null) {
    const n = deterministicCounter;
    deterministicCounter += 1;
    // Zero-padded base36. Cannot collide with a request-time id, whose leading
    // characters are a base36 millisecond timestamp and never all zero.
    return prefix + "_" + n.toString(36).padStart(12, "0");
  }
  return prefix + "_" + Date.now().toString(36).padStart(9, "0") + suffix(10);
}

export function newCorrelationId(): string {
  return newId("cor");
}

/** Deterministic id from a key, so a fixed seed reproduces a fixed corpus. */
export function deterministicId(prefix: IdPrefix, key: string): string {
  return prefix + "_" + key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
}
