import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptions, matchRuns, records } from "@/db/schema";
import { malformedIngestProbe } from "@/eval/demo";
import { Figure, Panel, Row } from "@/ui/parts";
import { inrCompact } from "@/shared/money";

export const dynamic = "force-dynamic";

/**
 * Failures.
 *
 * Every path the specification calls out under failure engineering, shown with
 * what actually happened rather than with an assertion that it is handled. The
 * malformed-input panel runs the parser live against a deliberately broken CSV
 * on every page load, so a regression that starts silently coercing a bad amount
 * shows up here instead of in a test nobody runs.
 */
export default async function FailuresPage() {
  await ensureBootstrapped();
  const db = await getDb();

  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const system = runs.find((run) => run.strategy !== "baseline-exact");

  const exceptionRows = system ? await db.select().from(exceptions).where(eq(exceptions.runId, system.id)) : [];
  const allRecords = await db.select().from(records);
  const duplicates = allRecords.filter((row) => row.duplicateOfId !== null);

  const probe = malformedIngestProbe();

  const byKind = new Map<string, { count: number; amount: number }>();
  for (const row of exceptionRows) {
    const entry = byKind.get(row.kind) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += row.amountAtRiskMinor;
    byKind.set(row.kind, entry);
  }

  const ambiguous = exceptionRows.filter((row) => row.kind === "AMBIGUOUS_MANY_TO_ONE");
  const missing = exceptionRows.filter((row) => row.kind === "MISSING_COUNTERPART");

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Failure engineering</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">Every path that can go wrong, and what it does</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ivory-dim)]">
          Nothing on this page is an assertion that a case is handled. Each panel shows the count the current run
          actually produced, and the malformed-input panel runs the parser live.
        </p>
      </div>

      <div className="course-panels">
        <Panel>
          <Figure value={String(ambiguous.length)} caption="ambiguous, sent to a person" tone="brass" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            Never a silent wrong match. Being confident about which of several indistinguishable records is the
            right one is the error the ambiguity test exists to prevent.
          </p>
        </Panel>
        <Panel>
          <Figure value={String(missing.length)} caption="missing counterparts" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            Flagged as absence, not filed as a low-confidence match. There is nothing here to have got wrong.
          </p>
        </Panel>
        <Panel>
          <Figure value={String(duplicates.length)} caption="duplicates suppressed" tone="jade" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            Caught at ingestion by a unique index on (source, external id) and excluded from matching. Stored,
            not deleted — the bank sending a line twice is a fact about the bank.
          </p>
        </Panel>
        <Panel>
          <Figure value={String(probe.rejected.length)} caption="malformed rows rejected" tone="carmine" />
          <p className="mt-2 text-xs text-[var(--color-ivory-faint)]">
            {probe.accepted} of {probe.accepted + probe.rejected.length} rows accepted from the probe file.
          </p>
        </Panel>
      </div>

      <div className="course-panels">
        <Panel title="Malformed input, run live">
          <p className="mb-3 text-sm text-[var(--color-ivory-dim)]">
            A five-row CSV with four deliberate defects is parsed on every load of this page. Rows are rejected,
            never coerced: a row whose amount cannot be parsed exactly is a row whose amount is unknown, and a
            reconciliation built on a guessed amount is worse than one with a gap in it.
          </p>
          <ul className="space-y-1.5">
            {probe.rejected.map((reason) => (
              <li key={reason} className="mono text-[0.75rem] text-[var(--color-carmine)]">
                {reason}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Size and row limits are enforced before parsing rather than after. A limit checked once the work is
            done is not a limit.
          </p>
        </Panel>

        <Panel title="Exception kinds this run produced">
          {byKind.size === 0 ? (
            <p className="text-sm text-[var(--color-ivory-faint)]">No exceptions on the current run.</p>
          ) : (
            <div className="space-y-2">
              {[...byKind.entries()]
                .sort(([, a], [, b]) => b.amount - a.amount)
                .map(([kind, entry]) => (
                  <Row
                    key={kind}
                    label={kind.replace(/_/g, " ")}
                    value={entry.count + " · " + inrCompact(entry.amount)}
                  />
                ))}
            </div>
          )}
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            An exception kind that never appears is not proof that the case is handled — it means the corpus
            never produced it. The evaluation page reports per-shape recall for exactly that reason.
          </p>
        </Panel>
      </div>

      <Panel title="What each failure does">
        <div className="registry">
          <table className="register">
            <thead>
              <tr>
                <th>Failure</th>
                <th>Where it is caught</th>
                <th>What happens</th>
                <th>What must never happen</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  "Ambiguous many-to-one",
                  "Policy engine, mutual-exclusivity test",
                  "Exception with every indistinguishable candidate attached",
                  "A confident pick between interchangeable records",
                ],
                [
                  "Missing counterpart",
                  "Policy engine, empty candidate set",
                  "MISSING_COUNTERPART exception with the amount at risk",
                  "Filing it as a low-confidence match",
                ],
                [
                  "Duplicate delivery",
                  "Ingestion, unique index on (source, external id)",
                  "Stored with duplicateOfId, excluded from matching",
                  "A second plausible match for money that moved once",
                ],
                [
                  "Malformed row",
                  "CSV parser, before any database write",
                  "Row rejected and reported with its line number",
                  "Coercing an unparseable amount to a number",
                ],
                [
                  "Oversized upload",
                  "Ingestion, before parsing",
                  "413 with the limit stated",
                  "Parsing first and checking the size afterwards",
                ],
                [
                  "Adjudicator unavailable",
                  "Adjudicator, on any failure or timeout",
                  "Falls back to the deterministic second opinion, marked fellBack",
                  "Failing the batch, or silently resolving",
                ],
                [
                  "Uploaded data with no ground truth",
                  "Evaluator",
                  "Refuses to compute precision and recall",
                  "Reporting metrics it cannot support",
                ],
                [
                  "Split settlement",
                  "Group merge pass, by summation",
                  "Parts merged into the whole when they add up",
                  "Merging on similarity rather than on arithmetic",
                ],
              ].map(([failure, where, what, never]) => (
                <tr key={failure}>
                  <td className="text-[var(--color-ivory)]">{failure}</td>
                  <td>{where}</td>
                  <td className="text-[var(--color-jade)]">{what}</td>
                  <td className="text-[var(--color-carmine)]">{never}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
