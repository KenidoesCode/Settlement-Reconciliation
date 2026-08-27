import { route } from "@/api/handler";
import { environmentStatus } from "@/shared/env";
import { records } from "@/db/schema";
import { verifyChain } from "@/shared/audit";
import { latestRun } from "@/match/reconcile";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db }) => {
  const chain = await verifyChain(db);
  const rows = await db.select({ id: records.id }).from(records);
  return {
    ok: chain.intact,
    environment: environmentStatus(),
    records: rows.length,
    auditChain: { receipts: chain.count, intact: chain.intact },
    latestRun: await latestRun(db),
  };
});
