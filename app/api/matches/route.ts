import { desc, eq } from "drizzle-orm";

import { intParam, route } from "@/api/handler";
import { matchRuns, matches } from "@/db/schema";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db, url }) => {
  const runId = url.searchParams.get("runId");
  const limit = intParam(url, "limit", 100, 500);

  const resolvedRunId =
    runId ??
    (await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt)).limit(1))[0]?.id ??
    null;

  if (!resolvedRunId) return { runId: null, matches: [] };

  return {
    runId: resolvedRunId,
    matches: await db.select().from(matches).where(eq(matches.runId, resolvedRunId)).limit(limit),
  };
});
