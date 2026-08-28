import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { evaluationRuns } from "@/db/schema";
import { Figure, Panel, Row, pct } from "@/ui/parts";
import { DemoRunner } from "@/ui/demo-runner";
import { inrCompact } from "@/shared/money";
import type { EvaluationMetrics } from "@/eval/evaluate";

export const dynamic = "force-dynamic";

export default async function EvaluationPage() {
  await ensureBootstrapped();
  const db = await getDb();

  const runs = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt)).limit(10);
  const comparison = runs.find((run) => run.baselineRunId !== null);
  const payload = comparison?.metrics as
    | { system: EvaluationMetrics; baseline: EvaluationMetrics; regressions: string[] }
    | undefined;

  if (!payload) {
    return (
      <Panel title="Evaluation">
        <p className="text-sm">No evaluation has been run.</p>
      </Panel>
    );
  }

  const { system, baseline, regressions } = payload;

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Evaluation against held-out ground truth</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">
          {system.truthPairs} truth pairs, {system.proposedPairs} proposed
        </h1>
        <p className="mono mt-1 text-[var(--color-ivory-faint)]">
          dataset {system.datasetVersion} · adjudicator {system.adjudicator} · {system.recordCount} records
        </p>
      </div>

      {/* The reading comes before the numbers it is about. */}
      <Panel title="How to read this">
        <div className="max-w-4xl space-y-3 text-sm text-[var(--color-ivory-dim)]">
          <p>
            <strong className="text-[var(--color-ivory)]">The unit is a pair of records, not a match group.</strong>{" "}
            A group of four correct records and a group of four with one intruder are both &ldquo;one
            match&rdquo;, and scoring by group would let the intruder disappear. Over pairs, that intruder shows
            up as three false pairs.
          </p>
          <p>
            <strong className="text-[var(--color-ivory)]">A refusal is not a miss.</strong> A truth pair the
            engine declined to resolve and put in the exception queue is counted as a correct exception, not as
            a failure. It still costs recall — which it should — but scoring it as an error would push a
            designer toward resolving everything, which is exactly the wrong instinct in a finance product.
          </p>
          <p>
            <strong className="text-[var(--color-ivory)]">Precision of 1.000 is cheap on its own.</strong> The
            way to get it is to resolve almost nothing, which is what the baseline does. That is why the
            exception count and the unresolved count sit next to it in every table here.
          </p>
          <p>
            <strong className="text-[var(--color-ivory)]">Ground truth exists only for generated records.</strong>{" "}
            Anything ingested through the upload endpoint has no truth group, and the evaluator refuses to
            compute precision and recall over it rather than reporting numbers it cannot support.
          </p>
        </div>
      </Panel>

      <div className="course-panels">
        <Panel>
          <Figure value={system.precision.toFixed(3)} caption="precision" tone="jade" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            {system.truePairs} true / {system.truePairs + system.falsePairs} proposed
          </p>
        </Panel>
        <Panel>
          <Figure value={system.recall.toFixed(3)} caption="recall" tone="brass" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            {system.truePairs} of {system.truthPairs} truth pairs
          </p>
        </Panel>
        <Panel>
          <Figure value={system.f1.toFixed(3)} caption="F1" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">baseline {baseline.f1.toFixed(3)}</p>
        </Panel>
        <Panel>
          <Figure
            value={system.falseMatchRate.toFixed(4)}
            caption="false-match rate"
            tone={system.falseMatchRate > 0 ? "carmine" : "jade"}
          />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            {system.falsePairs} wrongly paired
          </p>
        </Panel>
        <Panel>
          <Figure
            value={Math.round(system.throughputRecordsPerSecond).toLocaleString()}
            caption="records / second"
          />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">{system.durationMs}ms for the batch</p>
        </Panel>
      </div>

      <Panel title="System against baseline">
        <div className="registry">
          <table className="register">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Match rate</th>
                <th>Precision</th>
                <th>Recall</th>
                <th>F1</th>
                <th>True</th>
                <th>False</th>
                <th>Missed</th>
                <th>Correct exceptions</th>
                <th>Unresolved</th>
                <th>Rec/sec</th>
              </tr>
            </thead>
            <tbody>
              {[system, baseline].map((row) => (
                <tr key={row.strategy}>
                  <td className="text-[var(--color-ivory)]">{row.strategy}</td>
                  <td>{pct(row.matchRate)}</td>
                  <td>{row.precision.toFixed(3)}</td>
                  <td>{row.recall.toFixed(3)}</td>
                  <td className="text-[var(--color-brass-bright)]">{row.f1.toFixed(3)}</td>
                  <td className="text-[var(--color-jade)]">{row.truePairs}</td>
                  <td className={row.falsePairs > 0 ? "text-[var(--color-carmine)]" : ""}>{row.falsePairs}</td>
                  <td>{row.missedPairs}</td>
                  <td>{row.exceptionPairs}</td>
                  <td>{row.unresolvedCount}</td>
                  <td>{Math.round(row.throughputRecordsPerSecond).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <p className="label mb-1.5">Where the baseline wins</p>
          {regressions.length === 0 ? (
            <p className="text-sm text-[var(--color-ivory-dim)]">
              Nothing on this run. That is a claim about this corpus and not a general one: on a ledger with
              clean references and no fee deductions, an exact join would tie on everything and cost far less to
              operate.
            </p>
          ) : (
            <ul className="space-y-1">
              {regressions.map((regression) => (
                <li key={regression} className="text-sm text-[var(--color-carmine)]">
                  {regression}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <div className="course-panels">
        <Panel title="Per defect shape">
          <div className="registry">
            <table className="register">
              <thead>
                <tr>
                  <th>Shape</th>
                  <th>Truth pairs</th>
                  <th>Recovered</th>
                  <th>False</th>
                  <th>To a person</th>
                  <th>Lost</th>
                  <th>Recall</th>
                </tr>
              </thead>
              <tbody>
                {system.perShape.map((shape) => (
                  <tr key={shape.shape}>
                    <td className="text-[var(--color-ivory)]">{shape.shape}</td>
                    <td>{shape.truthPairs}</td>
                    <td className="text-[var(--color-jade)]">{shape.truePairs}</td>
                    <td className={shape.falsePairs > 0 ? "text-[var(--color-carmine)]" : ""}>
                      {shape.falsePairs}
                    </td>
                    <td className="text-[var(--color-amber)]">{shape.exceptionPairs}</td>
                    <td className={shape.missedPairs > 0 ? "text-[var(--color-carmine)]" : ""}>
                      {shape.missedPairs}
                    </td>
                    <td>{shape.recall.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Reported per shape so a good aggregate cannot hide a defect class the engine never handles. The
            many-to-one row is supposed to show zero recovered and zero false — every one of those cases should
            reach a person, and a run that starts resolving them has got worse, not better.
          </p>
        </Panel>

        <div className="space-y-5">
          <Panel title="Confidence calibration">
            <div className="registry">
              <table className="register">
                <thead>
                  <tr>
                    <th>Confidence band</th>
                    <th>Pairs</th>
                    <th>Actually correct</th>
                    <th>Observed precision</th>
                  </tr>
                </thead>
                <tbody>
                  {system.calibrationBuckets.map((bucket) => (
                    <tr key={bucket.bucket}>
                      <td>{bucket.bucket}</td>
                      <td>{bucket.pairs}</td>
                      <td>{bucket.truePairs}</td>
                      <td className="text-[var(--color-brass-bright)]">
                        {bucket.observedPrecision.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
              Mean confidence on correct pairs {system.meanConfidenceTrue.toFixed(3)}, on wrong pairs{" "}
              {system.meanConfidenceFalse.toFixed(3)}. If those two are close, the confidence number is not
              carrying information and the threshold is arbitrary — which is the thing this table exists to
              expose.
            </p>
          </Panel>

          <Panel title="Queue and cost">
            <div className="space-y-2">
              <Row label="Exceptions raised" value={String(system.exceptionCount)} />
              <Row label="Unresolved records" value={String(system.unresolvedCount)} />
              <Row label="Money in the queue" value={inrCompact(system.amountInExceptionsMinor)} tone="carmine" />
              <Row label="Baseline exceptions" value={String(baseline.exceptionCount)} />
              <Row label="Baseline unresolved" value={String(baseline.unresolvedCount)} />
            </div>
            <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
              A queue is work. The engine is only better than the baseline if it recovers more while asking for
              a similar amount of it, so both numbers are shown side by side.
            </p>
          </Panel>
        </div>
      </div>

      <Panel title="The five demonstrations">
        <DemoRunner />
      </Panel>
    </div>
  );
}
