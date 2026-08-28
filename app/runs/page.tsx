import Link from "next/link";
import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { matchRuns } from "@/db/schema";
import { Panel } from "@/ui/parts";
import { RunLauncher } from "@/ui/run-launcher";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  await ensureBootstrapped();
  const db = await getDb();
  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt)).limit(40);

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Reconciliation runs</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">Run it again, with different thresholds</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ivory-dim)]">
          Every run is scoped by id, so the baseline and the engine coexist rather than overwriting each other.
          Move a threshold and the effect on precision, recall and the size of the exception queue is measurable
          on the next run rather than argued about.
        </p>
      </div>

      <Panel title="New run">
        <RunLauncher />
      </Panel>

      <Panel title="History">
        <div className="registry">
          <table className="register">
            <thead>
              <tr>
                <th>Run</th>
                <th>Strategy</th>
                <th>Adjudicator</th>
                <th>Records</th>
                <th>Candidates</th>
                <th>Matched</th>
                <th>Exceptions</th>
                <th>Unresolved</th>
                <th>ms</th>
                <th>Rec/sec</th>
                <th>Resolve</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr key={run.id} className="rise" style={{ animationDelay: Math.min(i, 14) * 25 + "ms" }}>
                  <td>
                    <Link href={"/runs/" + run.id} className="underlink text-[var(--color-ivory)]">
                      {run.label}
                    </Link>
                  </td>
                  <td>{run.strategy}</td>
                  <td>{run.adjudicator}</td>
                  <td>{run.recordCount}</td>
                  <td>{run.candidateCount}</td>
                  <td className="text-[var(--color-jade)]">{run.matchedCount}</td>
                  <td className="text-[var(--color-amber)]">{run.exceptionCount}</td>
                  <td>{run.unresolvedCount}</td>
                  <td>{run.durationMs}</td>
                  <td>{Math.round(run.recordsPerSecond).toLocaleString()}</td>
                  <td>{(run.thresholds.resolve ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
