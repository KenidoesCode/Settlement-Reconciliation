import { z } from "zod";
import { eq } from "drizzle-orm";

import { bodyRoute, route } from "@/api/handler";
import { exceptions, humanReviews } from "@/db/schema";
import { appendReceipt } from "@/shared/audit";
import { AppError } from "@/shared/errors";
import { newId } from "@/shared/ids";

export const dynamic = "force-dynamic";

const Schema = z.object({
  exceptionId: z.string().min(1),
  outcome: z.enum(["APPROVED", "REJECTED", "ESCALATED"]),
  reviewer: z.string().min(1).max(80).default("controller"),
  note: z.string().max(500).default(""),
});

export const POST = bodyRoute(Schema, async ({ db, correlationId }, body) => {
  const [exception] = await db.select().from(exceptions).where(eq(exceptions.id, body.exceptionId)).limit(1);
  if (!exception) throw new AppError("EXCEPTION_NOT_FOUND", "No exception " + body.exceptionId + ".");
  if (exception.resolvedByReviewId) {
    throw new AppError("EXCEPTION_ALREADY_RESOLVED", "That exception has already been reviewed.");
  }

  const id = newId("rev");
  await db.insert(humanReviews).values({
    id,
    exceptionId: exception.id,
    reviewer: body.reviewer,
    outcome: body.outcome,
    note: body.note,
  });

  // The exception is marked resolved, not deleted. The record of what the
  // system could not decide survives the decision a person made about it.
  await db.update(exceptions).set({ resolvedByReviewId: id }).where(eq(exceptions.id, exception.id));

  await appendReceipt(db, {
    eventType: "HUMAN_REVIEW",
    correlationId,
    payload: {
      reviewId: id,
      exceptionId: exception.id,
      exceptionKind: exception.kind,
      outcome: body.outcome,
      reviewer: body.reviewer,
      amountAtRiskMinor: exception.amountAtRiskMinor,
      systemConfidence: exception.confidence,
    },
  });

  return { reviewId: id, outcome: body.outcome };
});

export const GET = route(async ({ db }) => ({ reviews: await db.select().from(humanReviews) }));
