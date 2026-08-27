/**
 * Normalization.
 *
 * Deterministic, no model, no configuration. This is the layer the matcher can
 * trust: if the same reference appears in two systems with different casing and
 * separators, that difference should never reach the scorer, because a scorer
 * that has to handle it will also handle differences that are real.
 *
 * WHAT IS STRIPPED AND WHY
 * ---------------------------------------------------------------------------
 * Bank narrations wrap the merchant reference in transport metadata: a channel
 * (NEFT, IMPS, UPI, RTGS), a bank code, a batch number, sometimes a date. None
 * of that identifies the payment -- it identifies how the money moved -- so it
 * is removed before comparison. The original string is kept on the record, so
 * nothing is lost and the Match Detail page shows what actually arrived.
 */

const CHANNEL_PREFIXES = /^(NEFT|IMPS|UPI|RTGS|ACH|CHQ|TRF|MPS)[\s/:-]+/i;
const BANK_SUFFIX = /[\s/-]+(HDFC|ICICI|AXIS|KOTAK|SBI|YESB)[A-Z0-9]*$/i;

/**
 * The confusable-glyph fold.
 *
 * O/0, I/l/1, S/5, B/8 collapse into one class. This is not a general
 * transliteration -- it is specifically the set of confusions that OCR and
 * hand-keying actually produce on alphanumeric references, which is why it is a
 * fixed table rather than a similarity metric. Applying it makes RZP1O0234 and
 * RZP100234 compare equal, which is the intent; it also makes two genuinely
 * different references collide slightly more often, and that cost is paid for
 * by requiring the amount and the counterparty to agree as well.
 */
const CONFUSABLES: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  S: "5",
  B: "8",
  Z: "2",
  G: "6",
};

export function normalizeReference(reference: string | null | undefined): string | null {
  if (!reference) return null;

  let value = reference.trim().toUpperCase();
  value = value.replace(CHANNEL_PREFIXES, "");
  value = value.replace(BANK_SUFFIX, "");
  value = value.replace(/[^A-Z0-9]/g, "");
  if (value.length === 0) return null;

  let folded = "";
  for (const character of value) folded += CONFUSABLES[character] ?? character;
  return folded;
}

const COMPANY_SUFFIXES =
  /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CORP|CO|COMPANY|SERVICES|SOLUTIONS|RETAIL|MEDIA|E-?RETAIL|ROASTERS|BEVERAGES|TECHNOLOGIES)\b/g;

export function normalizeCounterparty(counterparty: string | null | undefined): string | null {
  if (!counterparty) return null;
  const value = counterparty
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length === 0 ? null : value;
}

/**
 * Similarity of two normalized references, in [0, 1].
 *
 * Normalized Levenshtein rather than a token or trigram measure, because
 * references are short opaque strings where a single dropped character is the
 * common corruption and token overlap has nothing to work with. The length
 * guard exists because edit distance on a two-character string is meaningless:
 * one edit takes it from 1.0 to 0.5.
 */
export function referenceSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;

  /*
    A DIFFERENT SERIAL NUMBER IS NOT A CORRUPTED ONE.

    This branch was added after measuring. Edit distance rated R2P100030 and
    R2P100089 at 0.78 -- two digits out of nine -- and with amounts that happened
    to sit within a fee of each other, two unrelated transactions resolved into
    one match at 0.83 confidence. Because matches are connected components, that
    single wrong pair merged two whole reconciliation groups and produced twenty
    false pairs from one mistake.

    The rule that fixes it: after confusable folding, two references of the SAME
    LENGTH differing only at digit positions are two different numbers.
    References are serial. RZP100030 and RZP100089 are the thirtieth and the
    eighty-ninth of something, not one of them mistyped.

    Corruption looks different, and this is the whole point: corruption changes
    the LENGTH (a truncation, a dropped character) or substitutes across the
    letter/digit boundary (O for 0, S for 5) -- and the normalizer has already
    folded that second class away before this function sees it. So a residual,
    same-length, digits-only difference is the one thing edit distance is least
    able to interpret and the one thing that matters most to get right.

    They still score above zero: the amount and the counterparty may yet make
    the match, and a hard zero here would override evidence this function does
    not have. 0.3 is enough to keep such a pair in the candidate set and far too
    little to resolve it alone. Tuned, not derived.
  */
  if (a.length === b.length) {
    let differing = 0;
    let allDigitPositions = true;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      differing += 1;
      const left = a[i] as string;
      const right = b[i] as string;
      if (!/[0-9]/.test(left) || !/[0-9]/.test(right)) allDigitPositions = false;
    }
    if (differing > 0 && differing <= 3 && allDigitPositions) {
      return 0.3 * (1 - differing / (a.length + 1));
    }
  }

  // A containment case scores high on purpose: a truncated reference is a very
  // common bank corruption and edit distance punishes it out of proportion.
  if (a.includes(b) || b.includes(a)) {
    return 0.9 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) + 0.1;
  }

  const distance = levenshtein(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

export function counterpartySimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

function levenshtein(a: string, b: string): number {
  // Two-row band. The full matrix is not needed and these strings are short,
  // but the candidate generator calls this hundreds of thousands of times.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }

  return previous[b.length] as number;
}
