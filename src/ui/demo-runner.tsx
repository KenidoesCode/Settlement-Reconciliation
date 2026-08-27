"use client";

import { useState } from "react";

/**
 * Runs the five demonstrations against the live system.
 *
 * Nothing here is scripted. Each button posts to the demonstration endpoint and
 * renders what came back, including the case where a step failed -- if the
 * many-to-one demonstration ever reports a confident match, this component
 * prints exactly that rather than the expected outcome.
 */

const SCENARIOS = [
  { id: "clean-batch", label: "1 · Clean batch" },
  { id: "fee-mismatch", label: "2 · Fee mismatch" },
  { id: "many-to-one-exception", label: "3 · Many-to-one" },
  { id: "missing-counterpart", label: "4 · Missing counterpart" },
  { id: "baseline-vs-ai", label: "5 · Baseline vs engine" },
] as const;

interface Step {
  step: string;
  outcome: string;
  detail: string;
  ok: boolean;
}

interface DemoResult {
  scenario: string;
  headline: string;
  steps: Step[];
  links: { label: string; href: string }[];
  passed: boolean;
}

export function DemoRunner() {
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scenario: string): Promise<void> {
    setRunning(scenario);
    setError(null);
    try {
      const res = await fetch("/api/demo/" + scenario, { method: "POST" });
      const json = (await res.json()) as { result?: DemoResult; message?: string };
      if (!res.ok || !json.result) {
        setError(json.message ?? "The demonstration failed to run.");
        setResult(null);
        return;
      }
      setResult(json.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The demonstration failed to run.");
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            onClick={() => void run(scenario.id)}
            disabled={running !== null}
            className={
              "relative overflow-hidden border px-3.5 py-1.5 text-[0.625rem] uppercase tracking-[0.18em] disabled:opacity-50 " +
              (running === scenario.id
                ? "sweeping border-[var(--color-brass)] text-[var(--color-brass-bright)]"
                : "border-[var(--color-rule-bright)] text-[var(--color-ivory-dim)] hover:border-[var(--color-brass)] hover:text-[var(--color-brass-bright)]")
            }
          >
            {scenario.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-[var(--color-carmine)]">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={"badge " + (result.passed ? "badge-resolved" : "badge-false")}>
              {result.passed ? "As expected" : "Not as expected"}
            </span>
            <p className="text-[0.9375rem] text-[var(--color-ivory)]">{result.headline}</p>
          </div>

          <ol className="space-y-2">
            {result.steps.map((step, i) => (
              <li
                key={step.step}
                className="rise grid gap-1 border-l-2 pl-3 sm:grid-cols-[14rem_1fr]"
                style={{
                  animationDelay: i * 70 + "ms",
                  borderColor: step.ok ? "var(--color-jade)" : "var(--color-carmine)",
                }}
              >
                <div>
                  <p className="mono font-medium text-[var(--color-ivory)]">{step.step}</p>
                  <p className={"label " + (step.ok ? "text-[var(--color-brass-bright)]" : "text-[var(--color-carmine)]")}>
                    {step.outcome}
                  </p>
                </div>
                <p className="text-xs leading-snug text-[var(--color-ivory-dim)]">{step.detail}</p>
              </li>
            ))}
          </ol>

          {result.links.length > 0 && (
            <div className="flex flex-wrap gap-4">
              {result.links.map((link) => (
                <a key={link.href} href={link.href} className="underlink label">
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
