import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptions, matchCandidates, matchRuns, matches } from "@/db/schema";
import { Badge, Figure, Panel, Row } from "@/ui/parts";
import { inr, inrCompact } from "@/shared/money";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const db = await getDb();
  const { id } = await params;

  const [run] = await db.select().from(matchRuns).where(eq(matchRuns.id, id)).limit(1);
  if (!run) notFound();

  const matchRows = await db.select().from(matches).where(eq(matches.runId, id));
  const exceptionRows = await db.select().from(exceptions).where(eq(exceptions.runId, id));
  const candidateRows = await db.select().from(matchCandidates).where(eq(matchCandidates.runId, id)).limit(500);

  const byKind = new Map<string, number>();
  for (const exception of exceptionRows) byKind.set(exception.kind, (byKind.get(exception.kind) ?? 0) + 1);

  const confidenceBands = new Map<string, number>();
  for (const match of matchRows) {
    const band = (Math.floor(match.confidence * 20) / 20).toFixed(2);
    confidenceBands.set(band, (confidenceBands.get(band) ?? 0) + 1);
  }
  const maxBand = Math.max(1, ...confidenceBands.values());

  const groupSizes = new Map<number, number>();
  for (const match of matchRows) {
    groupSizes.set(match.recordIds.length, (groupSizes.get(match.recordIds.length) ?? 0) + 1);
  }

  return (
    <div className="space-y-5">
      <Link href="/runs" className="label underlink">
        All runs
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Reconciliation run</p>
          <h1 className="display text-2xl text-[var(--color-ivory)]">{run.label}</h1>
          <p className="mono mt-1 text-[var(--color-ivory-faint)]">{run.id}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Badge kind="brass">{run.strategy}</Badge>
          <Badge kind="resolved">adjudicator: {run.adjudicator}</Badge>
        </div>
      </div>

      <section className="panel">
        <div className="grid gap-6 sm:grid-cols-3 lg:grid-cols-6">
          <Figure value={String(run.recordCount)} caption="records" />
          <Figure value={String(run.candidateCount)} caption="candidate pairs" />
          <Figure value={String(run.matchedCount)} caption="match groups" tone="jade" />
          <Figure value={String(run.exceptionCount)} caption="exceptions" tone="brass" />
          <Figure value={String(run.unresolvedCount)} caption="unresolved" />
          <Figure value={run.durationMs + "ms"} caption="duration" />
        </div>
        <p className="mt-4 text-xs text-[var(--color-ivory-faint)]">
          {run.candidateCount.toLocaleString()} candidate pairs from {run.recordCount} records. Comparing every
          pair would be {(((run.recordCount * (run.recordCount - 1)) / 2) | 0).toLocaleString()} — blocking is
          what makes this tractable, and the candidate count is printed so a blocking scheme that has quietly
          stopped firing looks like a bug rather than like speed.
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Thresholds used">
          <div className="space-y-2">
            {Object.entries(run.thresholds).map(([key, value]) => (
              <Row key={key} label={key} value={String(value)} />
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Stored per run, so a historical result stays interpretable after the defaults change. Every one of
            these was tuned against this corpus, not derived.
          </p>
        </Panel>

        <Panel title="Confidence distribution">
          <div className="space-y-1.5">
            {[...confidenceBands.entries()]
              .sort(([a], [b]) => Number(b) - Number(a))
              .slice(0, 10)
              .map(([band, count]) => (
                <div key={band}>
                  <div className="flex items-baseline justify-between">
                    <span className="label">{band}</span>
                    <span className="mono text-[var(--color-ivory)]">{count}</span>
                  </div>
                  <div className="mt-0.5 h-[4px] bg-[var(--color-rule)]">
                    <div
                      className="h-full bg-[var(--color-brass)]"
                      style={{ width: (count / maxBand) * 100 + "%" }}
                    />
                  </div>
                </div>
              ))}
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            A distribution piled entirely at the top means the threshold is not doing any work — everything is
            either obvious or discarded, and the interesting cases are not being scored at all.
          </p>
        </Panel>

        <Panel title="Exceptions by kind">
          {byKind.size === 0 ? (
            <p className="text-sm text-[var(--color-ivory-faint)]">No exceptions on this run.</p>
          ) : (
            <div className="space-y-2">
              {[...byKind.entries()]
                .sort(([, a], [, b]) => b - a)
                .map(([kind, count]) => (
                  <Row key={kind} label={kind.replace(/_/g, " ")} value={String(count)} />
                ))}
            </div>
          )}
          <div className="mt-4">
            <Link href="/exceptions" className="underlink label">
              Open the queue
            </Link>
          </div>
        </Panel>
      </div>

      <Panel title="Match groups">
        <div className="mb-3 flex flex-wrap gap-4">
          {[...groupSizes.entries()]
            .sort(([a], [b]) => a - b)
            .map(([size, count]) => (
              <span key={size} className="label">
                {count} groups of {size}
              </span>
            ))}
        </div>
        <table className="register">
          <thead>
            <tr>
              <th>Group</th>
              <th>Records</th>
              <th>Confidence</th>
              <th>Decided by</th>
              <th>Residual</th>
              <th>Adjudicated</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {matchRows.slice(0, 40).map((match, i) => (
              <tr key={match.id} className="rise" style={{ animationDelay: Math.min(i, 16) * 22 + "ms" }}>
                <td>
                  <Link href={"/matches/" + match.id} className="underlink text-[var(--color-ivory)]">
                    {match.id.slice(0, 14)}
                  </Link>
                </td>
                <td>{match.recordIds.length}</td>
                <td className="text-[var(--color-brass-bright)]">{match.confidence.toFixed(3)}</td>
                <td>{match.decidedBy}</td>
                <td>{inr(match.amountDeltaMinor)}</td>
                <td>{match.adjudicated ? "yes" : "—"}</td>
                <td className="max-w-[30rem]">{match.rationale[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {matchRows.length > 40 && (
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Showing 40 of {matchRows.length} groups.
          </p>
        )}
      </Panel>

      <Panel title="Candidate sample">
        <table className="register">
          <thead>
            <tr>
              <th>Score</th>
              <th>Blocking key</th>
              <th>Reference</th>
              <th>Amount</th>
              <th>Date</th>
              <th>Counterparty</th>
            </tr>
          </thead>
          <tbody>
            {candidateRows.slice(0, 20).map((candidate) => (
              <tr key={candidate.id}>
                <td className="text-[var(--color-brass-bright)]">{candidate.score.toFixed(3)}</td>
                <td>{candidate.blockingKey}</td>
                <td>{(candidate.features.reference ?? 0).toFixed(2)}</td>
                <td>{(candidate.features.amount ?? 0).toFixed(2)}</td>
                <td>{(candidate.features.date ?? 0).toFixed(2)}</td>
                <td>{(candidate.features.counterparty ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
          Candidates are persisted as a capped sample of 500 per run. The run generated{" "}
          {run.candidateCount.toLocaleString()}; storing them all would be tens of thousands of rows for a table
          that shows twenty. Total exposure across the queue is {inrCompact(
            exceptionRows.reduce((sum, row) => sum + row.amountAtRiskMinor, 0),
          )}.
        </p>
      </Panel>
    </div>
  );
}
