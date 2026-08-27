import { z } from "zod";

import { bodyRoute } from "@/api/handler";
import { ingestGeneratedCorpus, ingestRows, parseCsv } from "@/ingest/ingest";
import { SOURCE_KINDS } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("generate"), seed: z.number().int().optional() }),
  z.object({
    mode: z.literal("csv"),
    kind: z.enum(SOURCE_KINDS),
    /** Raw CSV text. Size and row limits are enforced before parsing. */
    csv: z.string().min(1),
    origin: z.string().max(120).default("upload"),
  }),
]);

export const POST = bodyRoute(Schema, async ({ db }, body) => {
  if (body.mode === "generate") {
    return { result: await ingestGeneratedCorpus(db, body.seed) };
  }

  const { rows, skipped } = parseCsv(body.csv, body.kind);
  const result = await ingestRows(db, body.kind, rows, body.origin);
  // Skipped rows are returned, not swallowed. A caller that uploaded 500 rows
  // and got 480 in needs to know which twenty, and why.
  return { result, skipped };
});
