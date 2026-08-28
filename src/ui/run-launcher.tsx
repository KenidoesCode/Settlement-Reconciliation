"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Launches a reconciliation run with the thresholds the operator chooses.
 *
 * The thresholds are exposed rather than hidden because they are the product's
 * real controls: raising the resolve threshold trades recall for precision and
 * lengthens the exception queue, and the only honest way to present that trade
 * is to let someone move it and see what happens. The result panel prints the
 * outcome of the run just launched, so the trade is measured rather than
 * described.
 */

interface RunResult {
  runId: string;
  strategy: string;
  adjudicator: string;
  recordCount: number;
  candidateCount: number;
  matchedCount: number;
  exceptionCount: number;
  unresolvedCount: number;
  adjudicatedCount: number;
  durationMs: number;
  recordsPerSecond: number;
}

export function RunLauncher() {
  const router = useRouter();
  const [strategy, setStrategy] = useState<"fuzzy+adjudicator" | "fuzzy" | "baseline-exact">(
    "fuzzy+adjudicator",
  );
  const [resolve, setResolve] = useState(0.82);
  const [floor, setFloor] = useState(0.45);
  const [margin, setMargin] = useState(0.08);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function launch(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy,
          label: strategy + " @ " + resolve.toFixed(2),
          thresholds: { resolve, floor, ambiguityMargin: margin },
        }),
      });
      const json = (await response.json()) as { result?: RunResult; message?: string };
      if (!response.ok || !json.result) {
        setError(json.message ?? "The run failed.");
        return;
      }
      setResult(json.result);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-5">
        <label className="flex flex-col gap-1">
          <span className="label">Strategy</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof strategy)}
            className="mono border border-[var(--color-rule-bright)] bg-transparent px-2 py-1.5 text-[var(--color-ivory)]"
          >
            <option value="fuzzy+adjudicator">fuzzy + adjudicator</option>
            <option value="fuzzy">fuzzy only</option>
            <option value="baseline-exact">baseline: exact join</option>
          </select>
        </label>

        <Slider label="Resolve threshold" value={resolve} min={0.5} max={0.99} onChange={setResolve} />
        <Slider label="Review floor" value={floor} min={0.2} max={0.8} onChange={setFloor} />
        <Slider label="Ambiguity margin" value={margin} min={0.01} max={0.3} onChange={setMargin} />

        <button
          type="button"
          onClick={() => void launch()}
          disabled={busy}
          className={
            "relative overflow-hidden border border-[var(--color-brass)] px-5 py-2 text-[0.625rem] uppercase tracking-[0.22em] text-[var(--color-brass-bright)] transition-colors hover:bg-[rgba(201,162,39,0.1)] disabled:opacity-50 " +
            (busy ? "sweeping" : "")
          }
        >
          {busy ? "Reconciling" : "Reconcile"}
        </button>
      </div>

      {error && <p className="text-sm text-[var(--color-carmine)]">{error}</p>}

      {/*
        The honest note.

        On this deployment DATABASE_URL is pglite://:memory:, so every serverless
        function instance holds its own database. The run below is real -- it is
        computed against a real corpus and the numbers are its actual output --
        but it was written to the API function's memory, and the History table on
        this page is rendered by a different function that never saw it.

        Saying so is not an apology. A launcher that appeared to add a row and
        silently did not would be the dishonest version.
      */}
      <p className="border-l-2 border-[var(--color-amber)] pl-3 text-xs leading-relaxed text-[var(--color-ivory-dim)]">
        <span className="label text-[var(--color-amber)]">Note on this deployment.</span> The run is
        real and its numbers are computed live, but it will not appear in the History table below.
        This demo runs an in-process database per serverless function, so a write from the API
        function is invisible to the page function that renders the table. Point{" "}
        <code className="mono">DATABASE_URL</code> at any PostgreSQL server — the driver already
        supports it — and both the run and the table come from the same place.
      </p>

      {result && (
        <div className="rise course-figures border-t border-[var(--color-rule)] pt-4">
          <Stat label="records" value={String(result.recordCount)} />
          <Stat label="candidates" value={String(result.candidateCount)} />
          <Stat label="matches" value={String(result.matchedCount)} tone="jade" />
          <Stat label="exceptions" value={String(result.exceptionCount)} tone="amber" />
          <Stat label="adjudicated" value={String(result.adjudicatedCount)} />
          <Stat label="rec/sec" value={Math.round(result.recordsPerSecond).toLocaleString()} />
          <a href={"/runs/" + result.runId} className="underlink label self-end">
            open this run
          </a>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-[10rem] flex-col gap-1">
      <span className="label">
        {label} · <span className="text-[var(--color-brass-bright)]">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--color-brass)]"
      />
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "jade" | "amber" }) {
  return (
    <div>
      <p
        className={
          "mono text-lg " +
          (tone === "jade"
            ? "text-[var(--color-jade)]"
            : tone === "amber"
              ? "text-[var(--color-amber)]"
              : "text-[var(--color-ivory)]")
        }
      >
        {value}
      </p>
      <p className="label">{label}</p>
    </div>
  );
}
