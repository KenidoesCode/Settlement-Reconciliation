import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { matchCandidates, matches, records } from "@/db/schema";
import { Badge, Panel, Row } from "@/ui/parts";
import { inr } from "@/shared/money";

export const dynamic = "force-dynamic";

/**
 * The tie-line ledger.
 *
 * Books on the left, bank on the right, a brass line down the middle for every
 * pair the engine tied together. This is the one place in the product where the
 * ornament and the data are the same thing: each arc is a resolved pair, and
 * the residual printed on the axis is the money the two sides disagree about.
 *
 * The layout is chosen against the obvious alternative, which is a table of
 * record rows with a shared match id. That table is denser and it hides the one
 * fact a controller is actually checking -- whether the two sides of this event
 * agree -- behind a column they have to read across.
 */

const BOOK_SIDE = new Set(["ORDER", "PG_PAYMENT", "INVOICE"]);

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const db = await getDb();
  const { id } = await params;

  const [match] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  if (!match) notFound();

  const rows = await db.select().from(records).where(inArray(records.id, match.recordIds));
  const candidates = await db
    .select()
    .from(matchCandidates)
    .where(eq(matchCandidates.runId, match.runId))
    .limit(400);

  const relevant = candidates.filter(
    (candidate) =>
      match.recordIds.includes(candidate.leftRecordId) || match.recordIds.includes(candidate.rightRecordId),
  );

  const books = rows.filter((row) => BOOK_SIDE.has(row.kind));
  const bank = rows.filter((row) => !BOOK_SIDE.has(row.kind));

  const booksTotal = books.reduce((sum, row) => sum + row.amountMinor, 0);
  const bankTotal = bank.reduce((sum, row) => sum + row.amountMinor, 0);
  const declaredFees = rows.reduce((sum, row) => sum + row.feeMinor + row.taxMinor, 0);

  const lines = Math.max(books.length, bank.length);

  return (
    <div className="space-y-5">
      <Link href={"/runs/" + match.runId} className="label underlink">
        Back to the run
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Match</p>
          <h1 className="display text-2xl text-[var(--color-ivory)]">
            {rows.length} records across {new Set(rows.map((r) => r.kind)).size} sources
          </h1>
          <p className="mono mt-1 text-[var(--color-ivory-faint)]">{match.id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge kind="resolved">Confidence {match.confidence.toFixed(3)}</Badge>
          <Badge kind="brass">{match.decidedBy}</Badge>
          {match.adjudicated && <Badge kind="exception">Adjudicated</Badge>}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The tie                                                             */}
      {/* ------------------------------------------------------------------ */}
      <Panel title="Books · axis · bank">
        <div className="tie">
          <div>
            <p className="label mb-2">Books</p>
            {books.map((row, i) => (
              <div key={row.id} className="tie-side rise" style={{ animationDelay: i * 60 + "ms" }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label">{row.kind.replace(/_/g, " ")}</span>
                  <span className="mono text-[var(--color-ivory)]">{inr(row.amountMinor)}</span>
                </div>
                <p className="mono mt-0.5 text-[var(--color-ivory-faint)]">{row.externalId}</p>
                <p className="mono text-[var(--color-ivory-faint)]">{row.reference ?? "(no reference)"}</p>
                <p className="label mt-0.5">{row.valueDate.toISOString().slice(0, 10)}</p>
              </div>
            ))}
            {books.length === 0 && <p className="label px-3 py-4">nothing on this side</p>}
          </div>

          <div className="tie-axis">
            {Array.from({ length: lines }).map((_, i) => (
              <div
                key={i}
                className="tie-arc"
                style={{ top: 34 + i * 96 + "px", animationDelay: 120 + i * 90 + "ms" }}
              />
            ))}
            <div className="absolute inset-x-0 bottom-2 text-center">
              <p className="label">residual</p>
              <p
                className={
                  "mono " +
                  (Math.abs(booksTotal - bankTotal) <= declaredFees + 200
                    ? "text-[var(--color-jade)]"
                    : "text-[var(--color-carmine)]")
                }
              >
                {inr(booksTotal - bankTotal)}
              </p>
            </div>
          </div>

          <div>
            <p className="label mb-2 text-right">Bank &amp; settlement</p>
            {bank.map((row, i) => (
              <div key={row.id} className="tie-side rise text-right" style={{ animationDelay: i * 60 + "ms" }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="mono text-[var(--color-ivory)]">{inr(row.amountMinor)}</span>
                  <span className="label">{row.kind.replace(/_/g, " ")}</span>
                </div>
                <p className="mono mt-0.5 text-[var(--color-ivory-faint)]">{row.externalId}</p>
                <p className="mono text-[var(--color-ivory-faint)]">{row.reference ?? "(no reference)"}</p>
                <p className="label mt-0.5">{row.valueDate.toISOString().slice(0, 10)}</p>
              </div>
            ))}
            {bank.length === 0 && <p className="label px-3 py-4 text-right">nothing on this side</p>}
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Row label="Books total" value={inr(booksTotal)} />
          <Row label="Bank total" value={inr(bankTotal)} />
          <Row
            label="Fees declared"
            value={inr(declaredFees)}
            tone={declaredFees > 0 ? "jade" : undefined}
          />
        </div>
        <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
          A residual inside the declared fees is the settlement working correctly, not a discrepancy. A residual
          beyond them is the thing worth a controller&apos;s attention, and the axis colours accordingly.
        </p>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Why the engine tied these together">
          <ul className="space-y-2">
            {match.rationale.map((reason, i) => (
              <li key={i} className="text-sm text-[var(--color-ivory-dim)]">
                {reason}
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-2">
            {Object.entries(match.features).map(([feature, value]) => (
              <div key={feature}>
                <div className="flex items-baseline justify-between">
                  <span className="label">{feature}</span>
                  <span className="mono text-[var(--color-ivory)]">{Number(value).toFixed(3)}</span>
                </div>
                {/* The feature bar is the score, not a decoration: its width is
                    the value the policy engine actually read. */}
                <div className="mt-1 h-[3px] bg-[var(--color-rule)]">
                  <div
                    className="h-full bg-[var(--color-brass)]"
                    style={{ width: Math.max(0, Math.min(1, Number(value))) * 100 + "%" }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Candidates the blocker produced for these records">
          {relevant.length === 0 ? (
            <p className="text-sm text-[var(--color-ivory-faint)]">
              No candidate rows retained for this match. Candidates are persisted as a capped sample.
            </p>
          ) : (
            <table className="register">
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Blocking key</th>
                  <th>Left</th>
                  <th>Right</th>
                </tr>
              </thead>
              <tbody>
                {relevant.slice(0, 14).map((candidate) => (
                  <tr key={candidate.id}>
                    <td className="text-[var(--color-brass-bright)]">{candidate.score.toFixed(3)}</td>
                    <td>{candidate.blockingKey}</td>
                    <td>{candidate.leftRecordId.slice(0, 14)}</td>
                    <td>{candidate.rightRecordId.slice(0, 14)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Blocking is recall-only. A key that never fires is a match lost forever, so the keys overlap
            deliberately and precision is left entirely to scoring.
          </p>
        </Panel>
      </div>

      <Panel title="Records as they arrived">
        <table className="register">
          <thead>
            <tr>
              <th>Source</th>
              <th>External id</th>
              <th>Reference</th>
              <th>Normalized</th>
              <th>Amount</th>
              <th>Fee</th>
              <th>Value date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="text-[var(--color-ivory)]">{row.kind.replace(/_/g, " ")}</td>
                <td>{row.externalId}</td>
                <td>{row.reference ?? "—"}</td>
                <td className="text-[var(--color-brass-bright)]">{row.normalizedReference ?? "—"}</td>
                <td>{inr(row.amountMinor)}</td>
                <td>{row.feeMinor + row.taxMinor > 0 ? inr(row.feeMinor + row.taxMinor) : "—"}</td>
                <td>{row.valueDate.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
          The normalized column is what the matcher compared. The reference column is what actually arrived, kept
          verbatim so a normalization that is throwing away something real stays visible.
        </p>
      </Panel>
    </div>
  );
}
