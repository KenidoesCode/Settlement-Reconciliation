import { desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptions, matchRuns, records } from "@/db/schema";
import { Figure, Panel } from "@/ui/parts";
import { ExceptionQueue, type QueueItem } from "@/ui/exception-queue";
import { inrCompact } from "@/shared/money";

export const dynamic = "force-dynamic";

/** Exception cards rendered per page. See the comment at the sort below. */
const QUEUE_SIZE = 20;

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  await ensureBootstrapped();
  const db = await getDb();
  const params = await searchParams;

  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const system = runs.find((run) => run.strategy !== "baseline-exact");
  if (!system) {
    return (
      <Panel title="Exceptions">
        <p className="text-sm">No reconciliation run yet.</p>
      </Panel>
    );
  }

  const all = await db.select().from(exceptions).where(eq(exceptions.runId, system.id));
  const filtered = params.kind ? all.filter((row) => row.kind === params.kind) : all;

  /*
    Ordered by money at risk. See the note in the queue component.

    Twenty, not forty. Measured on the deployed site: forty cards shipped 226 KB
    of HTML, most of it the explanation paragraph repeated on every card -- and
    those paragraphs are long on purpose, because an exception that does not say
    why it is an exception is a blank form. Twenty is more than a reviewer works
    through in a sitting, the count is stated below, and the rest are one API
    call away.
  */
  const ordered = [...filtered].sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor).slice(0, QUEUE_SIZE);

  const referencedIds = [
    ...new Set(ordered.flatMap((row) => [...row.recordIds, ...row.recommendedRecordIds])),
  ];
  const recordRows =
    referencedIds.length > 0 ? await db.select().from(records).where(inArray(records.id, referencedIds)) : [];
  const byId = new Map(recordRows.map((row) => [row.id, row] as const));

  const toCandidate = (id: string) => {
    const row = byId.get(id);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      externalId: row.externalId,
      reference: row.reference,
      amountMinor: row.amountMinor,
      valueDate: row.valueDate.toISOString(),
    };
  };

  const items: QueueItem[] = ordered.map((row) => ({
    id: row.id,
    kind: row.kind,
    confidence: row.confidence,
    explanation: row.explanation,
    amountAtRiskMinor: row.amountAtRiskMinor,
    resolvedByReviewId: row.resolvedByReviewId,
    subject: toCandidate(row.recordIds[0] ?? ""),
    recommended: row.recommendedRecordIds.map(toCandidate).filter(Boolean) as QueueItem["recommended"],
  }));

  const byKind = new Map<string, { count: number; amount: number }>();
  for (const row of all) {
    const entry = byKind.get(row.kind) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += row.amountAtRiskMinor;
    byKind.set(row.kind, entry);
  }

  const open = all.filter((row) => row.resolvedByReviewId === null);
  const totalAtRisk = open.reduce((sum, row) => sum + row.amountAtRiskMinor, 0);
  const multiCandidate = all.filter((row) => row.recommendedRecordIds.length > 1);

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Exception queue</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">
          {open.length} open, {inrCompact(totalAtRisk)} unactioned
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ivory-dim)]">
          These are the cases the engine refused to decide. Refusing is the product working, not failing — a
          matcher that resolves everything has simply moved its errors somewhere nobody looks.
        </p>
      </div>

      <section className="panel">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Figure value={String(open.length)} caption="open exceptions" tone="brass" />
          <Figure value={inrCompact(totalAtRisk)} caption="money at risk" tone="carmine" />
          <Figure value={String(multiCandidate.length)} caption="genuinely ambiguous" />
          <Figure value={String(all.length - open.length)} caption="reviewed" tone="jade" />
        </div>
      </section>

      <Panel
        title="By kind"
        right={
          <span className="flex gap-4">
            <a href="/api/export?format=csv" className="underlink label">
              Queue as CSV
            </a>
            <a href="/api/export?format=md" className="underlink label">
              Full report
            </a>
          </span>
        }
      >
        <div className="flex flex-wrap gap-2">
          <a
            href="/exceptions"
            className={
              "badge " + (params.kind ? "badge-unresolved" : "badge-brass")
            }
          >
            all · {all.length}
          </a>
          {[...byKind.entries()]
            .sort(([, a], [, b]) => b.amount - a.amount)
            .map(([kind, entry]) => (
              <a
                key={kind}
                href={"/exceptions?kind=" + kind}
                className={"badge " + (params.kind === kind ? "badge-brass" : "badge-unresolved")}
              >
                {kind.replace(/_/g, " ")} · {entry.count} · {inrCompact(entry.amount)}
              </a>
            ))}
        </div>
      </Panel>

      <ExceptionQueue items={items} />

      {filtered.length > QUEUE_SIZE && (
        <p className="text-xs text-[var(--color-ivory-faint)]">
          Showing the {QUEUE_SIZE} largest of {filtered.length}. The rest are in the API at{" "}
          <code className="mono">/api/exceptions</code>.
        </p>
      )}
    </div>
  );
}
