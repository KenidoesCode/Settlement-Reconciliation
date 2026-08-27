import Link from "next/link";
import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptions, humanReviews } from "@/db/schema";
import { Figure, Panel } from "@/ui/parts";
import { inr, inrCompact } from "@/shared/money";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  await ensureBootstrapped();
  const db = await getDb();

  const reviews = await db.select().from(humanReviews).orderBy(desc(humanReviews.createdAt)).limit(60);
  const all = await db.select().from(exceptions);
  const byId = new Map(all.map((row) => [row.id, row] as const));

  const approved = reviews.filter((review) => review.outcome === "APPROVED");
  const escalated = reviews.filter((review) => review.outcome === "ESCALATED");
  const reviewedAmount = reviews.reduce(
    (sum, review) => sum + (byId.get(review.exceptionId)?.amountAtRiskMinor ?? 0),
    0,
  );

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Human review</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">{reviews.length} decisions on the record</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ivory-dim)]">
          A review does not delete the exception it settles. Six months later the question is never whether a
          match was approved — it is who approved it, what the engine had said, and what they wrote down at the
          time.
        </p>
      </div>

      <section className="panel">
        <div className="grid gap-6 sm:grid-cols-4">
          <Figure value={String(reviews.length)} caption="reviews" />
          <Figure value={String(approved.length)} caption="approved" tone="jade" />
          <Figure value={String(escalated.length)} caption="escalated" tone="brass" />
          <Figure value={inrCompact(reviewedAmount)} caption="value reviewed" />
        </div>
      </section>

      <Panel title="Decisions">
        {reviews.length === 0 ? (
          <p className="text-sm text-[var(--color-ivory-faint)]">
            Nothing reviewed yet.{" "}
            <Link href="/exceptions" className="underlink">
              Open the exception queue
            </Link>{" "}
            to work through it.
          </p>
        ) : (
          <table className="register">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Reviewer</th>
                <th>Exception kind</th>
                <th>Engine confidence</th>
                <th>Candidates offered</th>
                <th>Amount</th>
                <th>Note</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review, i) => {
                const exception = byId.get(review.exceptionId);
                return (
                  <tr key={review.id} className="rise" style={{ animationDelay: Math.min(i, 14) * 25 + "ms" }}>
                    <td
                      className={
                        review.outcome === "APPROVED"
                          ? "text-[var(--color-jade)]"
                          : review.outcome === "REJECTED"
                            ? "text-[var(--color-carmine)]"
                            : "text-[var(--color-amber)]"
                      }
                    >
                      {review.outcome}
                    </td>
                    <td>{review.reviewer}</td>
                    <td>{exception?.kind.replace(/_/g, " ") ?? "—"}</td>
                    <td>{exception?.confidence.toFixed(3) ?? "—"}</td>
                    <td className={(exception?.recommendedRecordIds.length ?? 0) > 1 ? "text-[var(--color-amber)]" : ""}>
                      {exception?.recommendedRecordIds.length ?? 0}
                    </td>
                    <td>{exception ? inr(exception.amountAtRiskMinor) : "—"}</td>
                    <td className="max-w-[24rem]">{review.note || "—"}</td>
                    <td>{review.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Why the candidates-offered column is here">
        <p className="max-w-4xl text-sm text-[var(--color-ivory-dim)]">
          An approval on an exception that offered three indistinguishable candidates is not the same decision as
          an approval on one that offered a single clear counterpart, and an audit that cannot tell them apart
          cannot answer the only question worth asking about a reconciliation that later turned out to be wrong.
          Every review is also appended to the hash-chained audit trail with the engine confidence and the
          amount at risk as they stood at the time.
        </p>
      </Panel>
    </div>
  );
}
