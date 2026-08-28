import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { evaluationRuns, exceptions, matchRuns, matches, records, sources } from "@/db/schema";
import { verifyChain } from "@/shared/audit";
import { Badge, Figure, Panel, Row, pct } from "@/ui/parts";
import { inr, inrCompact } from "@/shared/money";
import type { EvaluationMetrics } from "@/eval/evaluate";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  await ensureBootstrapped();
  const db = await getDb();

  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt)).limit(6);
  const system = runs.find((run) => run.strategy !== "baseline-exact");

  const sourceRows = await db.select().from(sources);
  const allRecords = await db.select().from(records);
  const [comparison] = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt)).limit(1);
  const chain = await verifyChain(db);

  const metrics = comparison?.metrics as
    | { system: EvaluationMetrics; baseline: EvaluationMetrics; regressions: string[] }
    | undefined;

  const systemMatches = system ? await db.select().from(matches).where(eq(matches.runId, system.id)) : [];
  const systemExceptions = system ? await db.select().from(exceptions).where(eq(exceptions.runId, system.id)) : [];

  const settled = systemMatches.reduce((sum, match) => sum + Math.abs(match.amountDeltaMinor), 0);
  const atRisk = systemExceptions.reduce((sum, exception) => sum + exception.amountAtRiskMinor, 0);
  const duplicates = allRecords.filter((row) => row.duplicateOfId !== null).length;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ */}
      {/* The head                                                            */}
      {/* ------------------------------------------------------------------ */}
      <section className="panel">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <p className="label">Multi-source settlement reconciliation</p>
            <h1 className="display mt-1.5 text-2xl leading-tight text-[var(--color-ivory)]">
              {allRecords.length} records, {sourceRows.length} sources, one ledger
            </h1>
            <p className="mt-3 text-[0.9375rem] text-[var(--color-ivory-dim)]">
              A settlement is never the order amount, references arrive mangled by the bank, and credits land days
              late. An exact join finds none of it. This engine blocks, scores, and then refuses to decide the
              cases it genuinely cannot tell apart — because a confident wrong match is the expensive failure,
              not an honest exception.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Badge kind={chain.intact ? "resolved" : "false"}>
              {chain.intact ? "Audit chain intact" : "Audit chain broken"}
            </Badge>
            <Badge kind="brass">Synthetic data — not a real ledger</Badge>
            <a
              href="/api/export?format=csv"
              className="badge badge-resolved hover:bg-[rgba(79,174,135,0.1)]"
            >
              Exception queue · CSV ↓
            </a>
            <a
              href="/api/export?format=md"
              className="badge badge-brass hover:bg-[rgba(201,162,39,0.1)]"
            >
              Reconciliation report ↓
            </a>
          </div>
        </div>

        {metrics && (
          <div className="course-figures mt-7">
            <Figure value={pct(metrics.system.matchRate)} caption="records matched" tone="brass" />
            <Figure value={metrics.system.precision.toFixed(3)} caption="precision" tone="jade" />
            <Figure value={metrics.system.recall.toFixed(3)} caption="recall" />
            <Figure
              value={metrics.system.falseMatchRate.toFixed(4)}
              caption="false-match rate"
              tone={metrics.system.falseMatchRate > 0 ? "carmine" : "jade"}
            />
            <Figure
              value={Math.round(metrics.system.throughputRecordsPerSecond).toLocaleString()}
              caption="records / second"
            />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* System against baseline — side by side, losses included             */}
      {/* ------------------------------------------------------------------ */}
      {metrics && (
        <Panel
          title="Against the exact-join baseline"
          right={
            <Link href="/evaluation" className="underlink label">
              Full evaluation
            </Link>
          }
        >
          <div className="registry">
            <table className="register">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Match rate</th>
                  <th>Precision</th>
                  <th>Recall</th>
                  <th>F1</th>
                  <th>False matches</th>
                  <th>Exceptions</th>
                  <th>Unresolved</th>
                  <th>Rec/sec</th>
                </tr>
              </thead>
              <tbody>
                {[metrics.system, metrics.baseline].map((row) => (
                  <tr key={row.strategy}>
                    <td className="text-[var(--color-ivory)]">{row.strategy}</td>
                    <td>{pct(row.matchRate)}</td>
                    <td>{row.precision.toFixed(3)}</td>
                    <td>{row.recall.toFixed(3)}</td>
                    <td className="text-[var(--color-brass-bright)]">{row.f1.toFixed(3)}</td>
                    <td className={row.falsePairs > 0 ? "text-[var(--color-carmine)]" : ""}>{row.falsePairs}</td>
                    <td>{row.exceptionCount}</td>
                    <td>{row.unresolvedCount}</td>
                    <td>{Math.round(row.throughputRecordsPerSecond).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <p className="label mb-1.5">Where the baseline wins</p>
            {metrics.regressions.length === 0 ? (
              <p className="text-sm text-[var(--color-ivory-dim)]">
                Nothing on this run. That is a statement about this corpus, not a general claim — the baseline
                declines far more often, and on a ledger whose references are clean it would tie on precision
                while costing nothing.
              </p>
            ) : (
              <ul className="space-y-1">
                {metrics.regressions.map((regression) => (
                  <li key={regression} className="text-sm text-[var(--color-carmine)]">
                    {regression}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}

      <div className="course-panels">
        <Panel title="Sources">
          <div className="space-y-2">
            {sourceRows.map((source) => (
              <Row key={source.id} label={source.kind.replace(/_/g, " ")} value={String(source.rowCount)} />
            ))}
            <Row label="Duplicates suppressed" value={String(duplicates)} tone={duplicates > 0 ? "jade" : undefined} />
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Duplicates are caught at ingestion, not by the matcher. A duplicate that reaches the matcher becomes
            a plausible second match for money that only moved once.
          </p>
        </Panel>

        <Panel title="Money">
          <div className="space-y-2">
            <Row label="In resolved matches" value={String(systemMatches.length) + " groups"} />
            <Row label="Residual across groups" value={inrCompact(settled)} />
            <Row
              label="Sitting in exceptions"
              value={inrCompact(atRisk)}
              tone={atRisk > 0 ? "carmine" : undefined}
            />
            <Row label="Exceptions open" value={String(systemExceptions.length)} />
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            The exception queue is ordered by amount at risk. A controller with forty exceptions and an hour
            should start with the expensive ones, so the number is computed rather than the queue being
            chronological.
          </p>
        </Panel>

        <Panel title="Runs" right={<Link href="/runs" className="underlink label">All runs</Link>}>
          <div className="space-y-2.5">
            {runs.slice(0, 4).map((run) => (
              <Link key={run.id} href={"/runs/" + run.id} className="block">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="mono text-[var(--color-ivory)]">{run.label}</span>
                  <span className="label">{run.durationMs}ms</span>
                </div>
                <p className="label mt-0.5">
                  {run.matchedCount} matched · {run.exceptionCount} exceptions · {run.candidateCount} candidates
                </p>
              </Link>
            ))}
          </div>
        </Panel>
      </div>

      {system && (
        <Panel
          title="Latest resolved matches"
          right={
            <Link href={"/runs/" + system.id} className="underlink label">
              Open the run
            </Link>
          }
        >
          <div className="registry">
            <table className="register">
              <thead>
                <tr>
                  <th>Records</th>
                  <th>Sources</th>
                  <th>Confidence</th>
                  <th>Decided by</th>
                  <th>Residual</th>
                  <th>Adjudicated</th>
                </tr>
              </thead>
              <tbody>
                {systemMatches.slice(0, 10).map((match, i) => (
                  <tr key={match.id} className="rise" style={{ animationDelay: Math.min(i, 10) * 30 + "ms" }}>
                    <td>
                      <Link href={"/matches/" + match.id} className="underlink text-[var(--color-ivory)]">
                        {match.recordIds.length} records
                      </Link>
                    </td>
                    <td>{match.recordIds.length}</td>
                    <td className="text-[var(--color-brass-bright)]">{match.confidence.toFixed(3)}</td>
                    <td>{match.decidedBy}</td>
                    <td>{inr(match.amountDeltaMinor)}</td>
                    <td>{match.adjudicated ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
