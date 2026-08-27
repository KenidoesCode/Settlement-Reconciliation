import { z } from "zod";

import { getEnv } from "../shared/env";
import { AppError } from "../shared/errors";
import { logger } from "../shared/logger";
import { explainFeatures, type Features, type MatchableRecord, type Ranked } from "./engine";

/**
 * ===========================================================================
 * THE ADJUDICATOR
 * ===========================================================================
 *
 * Called for AMBIGUOUS candidates only -- the band between the floor and the
 * resolve threshold, where the deterministic scorer has said "plausible, not
 * certain". It proposes, with a rationale. It does not decide.
 *
 * WHAT IT IS ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * Nudge a confidence within a bounded range and supply a human-readable reason.
 * That is all. Specifically it CANNOT:
 *
 *   - raise a pair past the resolve threshold on its own. The policy engine
 *     re-checks ambiguity after adjudication, so a many-to-one tie stays an
 *     exception no matter how confident the adjudicator is.
 *   - lower a score below the floor, which would hide a case from the queue.
 *   - see the ground truth. It receives the same normalized fields the scorer
 *     receives, and nothing else.
 *
 * The bound is ADJUSTMENT_LIMIT and it is enforced here rather than trusted.
 * An adjudicator that could move a score arbitrarily would be the decision
 * maker, and the entire separation this file sits inside would be decorative.
 *
 * WHICH IMPLEMENTATION ACTUALLY RUNS
 * ---------------------------------------------------------------------------
 * `deterministic` is the default and is what produced every number in the
 * README. It is a second opinion computed from the features rather than a
 * model: it looks for the specific patterns a human reviewer looks for -- a gap
 * that is almost exactly a standard fee, a date offset that matches a known
 * settlement cycle, a reference that is a clean truncation -- and says so.
 *
 * Setting ADJUDICATOR=openai|anthropic with an API key routes the same pairs to
 * a model under the same bounds and the same schema. Every evaluation result
 * records which one ran, because a match rate produced by a model and one
 * produced by a scorer are different claims and collapsing them would be
 * dishonest.
 */

/** The most the adjudicator may move a confidence, in either direction. */
export const ADJUSTMENT_LIMIT = 0.12;

const ProposalSchema = z.object({
  chosenRecordId: z.string().min(1).nullable(),
  confidenceAdjustment: z.number().min(-1).max(1),
  rationale: z.string().min(1).max(400),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export interface AdjudicationResult {
  proposal: Proposal;
  /** After clamping. This is what the policy engine sees. */
  appliedAdjustment: number;
  adjudicator: string;
  latencyMs: number;
  /** Set when the configured adjudicator failed and the deterministic one ran. */
  fellBack: boolean;
}

export async function adjudicate(
  subject: MatchableRecord,
  ranked: Ranked[],
): Promise<AdjudicationResult> {
  const env = getEnv();
  const started = performance.now();

  if (env.ADJUDICATOR === "deterministic" || !env.adjudicatorAvailable) {
    const proposal = deterministicProposal(subject, ranked);
    return {
      proposal,
      appliedAdjustment: clamp(proposal.confidenceAdjustment),
      adjudicator: "deterministic",
      latencyMs: Number((performance.now() - started).toFixed(3)),
      fellBack: env.ADJUDICATOR !== "deterministic",
    };
  }

  try {
    const proposal = await modelProposal(subject, ranked);
    return {
      proposal,
      appliedAdjustment: clamp(proposal.confidenceAdjustment),
      adjudicator: env.ADJUDICATOR + ":" + (env.LLM_MODEL || "default"),
      latencyMs: Number((performance.now() - started).toFixed(3)),
      fellBack: false,
    };
  } catch (error) {
    // A failed adjudication must not fail the batch, and it must not silently
    // resolve either. Falling back to the deterministic second opinion keeps
    // the run honest, and `fellBack` puts it in the result rather than a log.
    logger.warn("adjudicator_failed", {
      adjudicator: env.ADJUDICATOR,
      reason: error instanceof Error ? error.message : "unknown",
    });
    const proposal = deterministicProposal(subject, ranked);
    return {
      proposal,
      appliedAdjustment: clamp(proposal.confidenceAdjustment),
      adjudicator: "deterministic (fallback)",
      latencyMs: Number((performance.now() - started).toFixed(3)),
      fellBack: true,
    };
  }
}

function clamp(adjustment: number): number {
  return Math.max(-ADJUSTMENT_LIMIT, Math.min(ADJUSTMENT_LIMIT, adjustment));
}

/* -------------------------------------------------------------------------- */
/* The deterministic second opinion                                           */
/* -------------------------------------------------------------------------- */

/** Standard Indian gateway fee rates, plus 18% GST. Used to recognise a gap. */
const KNOWN_FEE_RATES = [0.018, 0.02, 0.0236, 0.025];
const GST = 0.18;

/** Settlement cycles a bank credit plausibly follows. T+2 is the common one. */
const KNOWN_CYCLES_DAYS = [1, 2, 3, 7];

function deterministicProposal(subject: MatchableRecord, ranked: Ranked[]): Proposal {
  const best = ranked[0];
  if (!best) {
    return { chosenRecordId: null, confidenceAdjustment: 0, rationale: "No candidate to adjudicate." };
  }

  const reasons: string[] = [];
  let adjustment = 0;

  // ---- is the amount gap exactly a standard fee? --------------------------
  const gross = Math.max(subject.amountMinor, best.record.amountMinor);
  const gap = Math.abs(subject.amountMinor - best.record.amountMinor);
  const matchedRate = KNOWN_FEE_RATES.find((rate) => {
    const expected = Math.round(gross * rate * (1 + GST));
    return Math.abs(expected - gap) <= 200;
  });

  if (matchedRate && gap > 0) {
    adjustment += 0.09;
    reasons.push(
      "the " +
        (gap / 100).toFixed(2) +
        " rupee gap is within two rupees of a " +
        (matchedRate * 100).toFixed(2) +
        "% fee plus 18% GST on " +
        (gross / 100).toFixed(2),
    );
  } else if (gap > 0 && best.features.amount < 0.5) {
    adjustment -= 0.06;
    reasons.push("the amount gap does not correspond to any standard fee rate");
  }

  // ---- does the date offset match a settlement cycle? ---------------------
  const days = Math.round(Math.abs(subject.valueDate.getTime() - best.record.valueDate.getTime()) / 86_400_000);
  if (KNOWN_CYCLES_DAYS.includes(days)) {
    adjustment += 0.04;
    reasons.push("the " + days + "-day offset matches a standard T+" + days + " settlement cycle");
  } else if (days > 10) {
    adjustment -= 0.05;
    reasons.push("a " + days + "-day offset is outside every standard cycle");
  }

  // ---- is the reference a clean truncation rather than a corruption? ------
  const a = subject.normalizedReference;
  const b = best.record.normalizedReference;
  if (a && b && a !== b && (a.startsWith(b) || b.startsWith(a))) {
    adjustment += 0.07;
    reasons.push("one reference is a prefix of the other, which is a field-width truncation rather than a different reference");
  }

  // ---- is the counterparty carrying the match on its own? -----------------
  if (best.features.reference < 0.3 && best.features.counterparty >= 0.99) {
    // Counterparty alone is weak evidence: a merchant has many payments. This
    // is the pattern that produces false matches, so it costs confidence.
    adjustment -= 0.08;
    reasons.push("the counterparty matches but the reference does not, and a counterparty is shared by every payment from that merchant");
  }

  return {
    chosenRecordId: best.record.id,
    confidenceAdjustment: Number(adjustment.toFixed(4)),
    rationale:
      reasons.length > 0
        ? reasons.join("; ") + "."
        : "Nothing beyond the feature scores distinguishes this pair: " + explainFeatures(best.features),
  };
}

/* -------------------------------------------------------------------------- */
/* The model adjudicator                                                      */
/* -------------------------------------------------------------------------- */

async function modelProposal(subject: MatchableRecord, ranked: Ranked[]): Promise<Proposal> {
  const env = getEnv();

  const prompt = buildPrompt(subject, ranked);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  try {
    const response =
      env.ADJUDICATOR === "anthropic"
        ? await callAnthropic(prompt, controller.signal)
        : await callOpenAI(prompt, controller.signal);

    const parsed = ProposalSchema.safeParse(response);
    if (!parsed.success) {
      throw new AppError("ADJUDICATOR_MALFORMED_OUTPUT", "The adjudicator returned output that did not validate.", {
        issues: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message),
      });
    }

    // The chosen id must be one that was offered. A model that returns an id it
    // invented is not making a weaker suggestion, it is making an invalid one.
    const offered = new Set(ranked.map((r) => r.record.id));
    if (parsed.data.chosenRecordId !== null && !offered.has(parsed.data.chosenRecordId)) {
      throw new AppError("ADJUDICATOR_MALFORMED_OUTPUT", "The adjudicator chose a record it was not offered.");
    }

    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(subject: MatchableRecord, ranked: Ranked[]): string {
  // Ids are opaque and no ground truth is included. The model sees exactly what
  // the scorer sees.
  const describe = (record: MatchableRecord): string =>
    [
      "id=" + record.id,
      "source=" + record.kind,
      "reference=" + (record.normalizedReference ?? "(none)"),
      "counterparty=" + (record.normalizedCounterparty ?? "(none)"),
      "amountMinor=" + record.amountMinor,
      "feeMinor=" + record.feeMinor,
      "valueDate=" + record.valueDate.toISOString().slice(0, 10),
    ].join(" ");

  return [
    "You are adjudicating an ambiguous settlement reconciliation candidate.",
    "",
    "SUBJECT: " + describe(subject),
    "",
    "CANDIDATES:",
    ...ranked.map((r, i) => i + 1 + ". " + describe(r.record) + " score=" + r.score.toFixed(3)),
    "",
    "Return JSON: { chosenRecordId: string|null, confidenceAdjustment: number, rationale: string }.",
    "confidenceAdjustment is bounded to plus or minus " + ADJUSTMENT_LIMIT + " and will be clamped.",
    "You cannot resolve a match. You are proposing to a policy engine that decides.",
    "If several candidates are indistinguishable, return null and say so: an ambiguous case must reach a human.",
  ].join("\n");
}

async function callOpenAI(prompt: string, signal: AbortSignal): Promise<unknown> {
  const env = getEnv();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.LLM_API_KEY },
    body: JSON.stringify({
      model: env.LLM_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!response.ok) throw new AppError("ADJUDICATOR_UNAVAILABLE", "Adjudicator returned " + response.status + ".");
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
}

async function callAnthropic(prompt: string, signal: AbortSignal): Promise<unknown> {
  const env = getEnv();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.LLM_MODEL || "claude-sonnet-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt + "\n\nReply with JSON only." }],
    }),
  });
  if (!response.ok) throw new AppError("ADJUDICATOR_UNAVAILABLE", "Adjudicator returned " + response.status + ".");
  const json = (await response.json()) as { content?: { text?: string }[] };
  const text = json.content?.[0]?.text ?? "{}";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : "{}");
}

export type { Features };
