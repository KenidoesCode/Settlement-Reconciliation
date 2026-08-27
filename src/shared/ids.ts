import { randomBytes } from "node:crypto";

export type IdPrefix = "src" | "rec" | "run" | "cnd" | "mch" | "exc" | "rev" | "aud" | "evr" | "evc" | "cor" | "grp";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function suffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

export function newId(prefix: IdPrefix): string {
  return prefix + "_" + Date.now().toString(36).padStart(9, "0") + suffix(10);
}

export function newCorrelationId(): string {
  return newId("cor");
}

/** Deterministic id from a key, so a fixed seed reproduces a fixed corpus. */
export function deterministicId(prefix: IdPrefix, key: string): string {
  return prefix + "_" + key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
}
