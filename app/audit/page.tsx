import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { auditReceipts } from "@/db/schema";
import { verifyChain } from "@/shared/audit";
import { Badge, Figure, Panel } from "@/ui/parts";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await ensureBootstrapped();
  const db = await getDb();

  const chain = await verifyChain(db);
  const receipts = await db.select().from(auditReceipts).orderBy(desc(auditReceipts.sequence)).limit(60);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Audit trail</p>
          <h1 className="display text-2xl text-[var(--color-ivory)]">{chain.count} hash-chained receipts</h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-ivory-dim)]">
            Every ingestion, every run and every human review appends a receipt naming the SHA-256 of its
            predecessor. Remove one and everything after it stops linking; edit one and its own hash stops
            matching. The two cases are reported separately because they are different incidents.
          </p>
        </div>
        <Badge kind={chain.intact ? "resolved" : "false"}>
          {chain.intact ? "Chain intact" : "Chain broken"}
        </Badge>
      </div>

      <section className="panel">
        <div className="grid gap-6 sm:grid-cols-3">
          <Figure value={String(chain.count)} caption="receipts" />
          <Figure
            value={String(chain.breaks.length)}
            caption="broken links"
            tone={chain.breaks.length > 0 ? "carmine" : "jade"}
          />
          <Figure
            value={String(chain.tampered.length)}
            caption="payload hash mismatches"
            tone={chain.tampered.length > 0 ? "carmine" : "jade"}
          />
        </div>
      </section>

      {chain.breaks.length > 0 && (
        <Panel title="Broken links">
          <table className="register">
            <thead>
              <tr>
                <th>Sequence</th>
                <th>Receipt</th>
                <th>Claims predecessor</th>
                <th>Actual predecessor</th>
              </tr>
            </thead>
            <tbody>
              {chain.breaks.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.sequence}</td>
                  <td>{entry.id}</td>
                  <td>{entry.claimed?.slice(0, 20) ?? "null"}</td>
                  <td>{entry.actual?.slice(0, 20) ?? "null"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Receipts">
        <table className="register">
          <thead>
            <tr>
              <th>Seq</th>
              <th>Event</th>
              <th>Payload hash</th>
              <th>Previous</th>
              <th>Correlation</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt, i) => (
              <tr key={receipt.id} className="rise" style={{ animationDelay: Math.min(i, 16) * 22 + "ms" }}>
                <td className="text-[var(--color-ivory-faint)]">{receipt.sequence}</td>
                <td className="text-[var(--color-ivory)]">{receipt.eventType}</td>
                <td className="text-[var(--color-brass-bright)]" title={receipt.payloadHash}>
                  {receipt.payloadHash.slice(0, 18)}
                </td>
                <td title={receipt.previousHash ?? ""}>{receipt.previousHash?.slice(0, 14) ?? "genesis"}</td>
                <td>{receipt.correlationId.slice(0, 14)}</td>
                <td>{receipt.occurredAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
