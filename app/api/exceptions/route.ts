import { desc, eq } from "drizzle-orm";

import { intParam, route } from "@/api/handler";
import { exceptions, matchRuns } from "@/db/schema";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db, url }) => {
  const runId =
    url.searchParams.get("runId") ??
    (await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt)).limit(1))[0]?.id ??
    null;

  if (!runId) return { runId: null, exceptions: [] };

  const rows = await db
    .select()
    .from(exceptions)
    .where(eq(exceptions.runId, runId))
    .limit(intParam(url, "limit", 200, 1000));

  // Ordered by money at risk. A controller with an hour should start with the
  // expensive ones, and a chronological queue would not let them.
  return { runId, exceptions: rows.sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor) };
});
