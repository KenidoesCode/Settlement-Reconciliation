"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { inr } from "@/shared/money";

/**
 * The exception queue.
 *
 * ORDERED BY MONEY AT RISK, NOT BY TIME.
 * ---------------------------------------------------------------------------
 * A controller with forty exceptions and an hour should start with the
 * expensive ones. A chronological queue actively prevents that, and it is the
 * default in every reconciliation tool that treats its queue as a log rather
 * than as work.
 *
 * EVERY INDISTINGUISHABLE CANDIDATE IS SHOWN, NOT THE BEST ONE.
 * ---------------------------------------------------------------------------
 * When the engine could not tell three bank lines apart, showing the reviewer
 * one of them and asking "approve?" is worse than useless: it launders a
 * coin-flip through a person and produces an approval that looks like human
 * judgement. So the card shows all of them, side by side, and the reviewer can
 * escalate instead of choosing.
 */

interface Candidate {
  id: string;
  kind: string;
  externalId: string;
  reference: string | null;
  amountMinor: number;
  valueDate: string;
}

export interface QueueItem {
  id: string;
  kind: string;
  confidence: number;
  explanation: string;
  amountAtRiskMinor: number;
  resolvedByReviewId: string | null;
  subject: Candidate | null;
  recommended: Candidate[];
}

export function ExceptionQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function review(exceptionId: string, outcome: "APPROVED" | "REJECTED" | "ESCALATED"): Promise<void> {
    setBusy(exceptionId);
    setError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exceptionId,
          outcome,
          reviewer: "controller",
          note: notes[exceptionId] ?? "",
        }),
      });
      if (!response.ok) {
        const json = (await response.json()) as { message?: string };
        setError(json.message ?? "The review failed.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="border border-dashed border-[var(--color-rule)] px-4 py-8 text-center text-sm text-[var(--color-ivory-faint)]">
        Nothing waiting. An empty queue on a real ledger usually means the thresholds are too loose, not that
        the day went well.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-[var(--color-carmine)]">{error}</p>}

      {items.map((item, index) => (
        <article
          key={item.id}
          className="rise border border-[var(--color-rule)] bg-[var(--color-midnight-panel)] p-4"
          style={{ animationDelay: Math.min(index, 12) * 35 + "ms" }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <span className="badge badge-exception">{item.kind.replace(/_/g, " ")}</span>
              <p className="figure mt-2 text-[1.4rem] text-[var(--color-carmine)]">
                {inr(item.amountAtRiskMinor)}
              </p>
              <p className="label">at risk</p>
            </div>
            <div className="text-right">
              <p className="mono text-[var(--color-brass-bright)]">{item.confidence.toFixed(3)}</p>
              <p className="label">engine confidence</p>
            </div>
          </div>

          <p className="mt-3 max-w-4xl text-sm text-[var(--color-ivory-dim)]">{item.explanation}</p>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="label mb-1.5">This record</p>
              {item.subject ? (
                <RecordCard record={item.subject} />
              ) : (
                <p className="text-sm text-[var(--color-ivory-faint)]">record unavailable</p>
              )}
            </div>

            <div>
              <p className="label mb-1.5">
                {item.recommended.length === 0
                  ? "Nothing to pair it with"
                  : item.recommended.length === 1
                    ? "Recommended counterpart"
                    : item.recommended.length + " candidates the engine could not tell apart"}
              </p>
              {item.recommended.length === 0 ? (
                <p className="text-sm text-[var(--color-ivory-faint)]">
                  No counterpart anywhere in the corpus. Approving this would post against nothing.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {item.recommended.map((candidate) => (
                    <RecordCard key={candidate.id} record={candidate} />
                  ))}
                </div>
              )}
              {item.recommended.length > 1 && (
                <p className="mt-2 text-xs text-[var(--color-amber)]">
                  More than one candidate is shown deliberately. Approving here would pick one of several
                  indistinguishable records — escalate instead unless you know something the engine does not.
                </p>
              )}
            </div>
          </div>

          {item.resolvedByReviewId ? (
            <p className="mt-4 border-t border-[var(--color-rule)] pt-3 text-sm text-[var(--color-jade)]">
              Reviewed. The exception stays on the record; it is not deleted.
            </p>
          ) : (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[var(--color-rule)] pt-3">
              <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
                <span className="label">Note</span>
                <input
                  value={notes[item.id] ?? ""}
                  onChange={(e) => setNotes((current) => ({ ...current, [item.id]: e.target.value }))}
                  placeholder="what you checked, and where"
                  className="mono border border-[var(--color-rule-bright)] bg-transparent px-2 py-1.5 text-[var(--color-ivory)]"
                />
              </label>
              <Action onClick={() => void review(item.id, "APPROVED")} busy={busy === item.id} tone="jade">
                Approve
              </Action>
              <Action onClick={() => void review(item.id, "REJECTED")} busy={busy === item.id} tone="carmine">
                Reject
              </Action>
              <Action onClick={() => void review(item.id, "ESCALATED")} busy={busy === item.id} tone="amber">
                Escalate
              </Action>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function RecordCard({ record }: { record: Candidate }) {
  return (
    <div className="border border-[var(--color-rule)] p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{record.kind.replace(/_/g, " ")}</span>
        <span className="mono text-[var(--color-ivory)]">{inr(record.amountMinor)}</span>
      </div>
      <p className="mono mt-1 text-[0.6875rem] text-[var(--color-ivory-faint)]">{record.externalId}</p>
      <p className="mono text-[0.6875rem] text-[var(--color-ivory-faint)]">
        {record.reference ?? "(no reference)"}
      </p>
      <p className="label mt-1">{record.valueDate.slice(0, 10)}</p>
    </div>
  );
}

function Action({
  onClick,
  children,
  busy,
  tone,
}: {
  onClick: () => void;
  children: React.ReactNode;
  busy: boolean;
  tone: "jade" | "carmine" | "amber";
}) {
  const colour =
    tone === "jade"
      ? "border-[var(--color-jade)] text-[var(--color-jade)]"
      : tone === "carmine"
        ? "border-[var(--color-carmine)] text-[var(--color-carmine)]"
        : "border-[var(--color-amber)] text-[var(--color-amber)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "border px-3.5 py-1.5 text-[0.625rem] uppercase tracking-[0.18em] disabled:opacity-40 " + colour
      }
    >
      {children}
    </button>
  );
}
