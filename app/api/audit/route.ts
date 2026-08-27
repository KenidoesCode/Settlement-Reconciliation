import { desc } from "drizzle-orm";

import { intParam, route } from "@/api/handler";
import { auditReceipts } from "@/db/schema";
import { verifyChain } from "@/shared/audit";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db, url }) => ({
  chain: await verifyChain(db),
  receipts: await db
    .select()
    .from(auditReceipts)
    .orderBy(desc(auditReceipts.sequence))
    .limit(intParam(url, "limit", 100, 500)),
}));
