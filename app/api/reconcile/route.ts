import { z } from "zod";

import { bodyRoute } from "@/api/handler";
import { reconcile } from "@/match/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Schema = z.object({
  strategy: z.enum(["baseline-exact", "fuzzy", "fuzzy+adjudicator"]).default("fuzzy+adjudicator"),
  label: z.string().max(80).optional(),
  thresholds: z
    .object({
      resolve: z.number().min(0).max(1).optional(),
      floor: z.number().min(0).max(1).optional(),
      ambiguityMargin: z.number().min(0).max(1).optional(),
      dateWindowDays: z.number().min(0).max(90).optional(),
      feeToleranceFraction: z.number().min(0).max(0.5).optional(),
      roundingSlackMinor: z.number().int().min(0).max(100000).optional(),
    })
    .optional(),
});

export const POST = bodyRoute(Schema, async ({ db, correlationId }, body) => ({
  result: await reconcile(db, {
    strategy: body.strategy,
    ...(body.label ? { label: body.label } : {}),
    ...(body.thresholds ? { thresholds: body.thresholds } : {}),
    correlationId,
  }),
}));
