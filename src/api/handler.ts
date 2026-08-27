import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb, type Database } from "../db/client";
import { ensureBootstrapped } from "../db/bootstrap";
import { AppError, toAppError } from "../shared/errors";
import { newCorrelationId } from "../shared/ids";
import { logger } from "../shared/logger";

export interface Ctx {
  db: Database;
  url: URL;
  correlationId: string;
}

/**
 * One error contract for every route.
 *
 * A refusal returns its reason. An exception queue whose entries say only
 * hiding why a match was refused is worse than useless: it teaches controllers
 * that exceptions are noise.
 */
export function jsonError(error: unknown, correlationId: string): NextResponse {
  const appError = toAppError(error);
  if (appError.status >= 500) {
    logger.error("request_failed", { code: appError.code, correlationId, message: appError.message });
  }
  return NextResponse.json(
    { error: appError.code, message: appError.message, details: appError.details, correlationId },
    { status: appError.status },
  );
}

export function route(handler: (ctx: Ctx) => Promise<unknown>) {
  return async (request: Request): Promise<NextResponse> => {
    const correlationId = newCorrelationId();
    try {
      await ensureBootstrapped();
      const db = await getDb();
      const body = await handler({ db, url: new URL(request.url), correlationId });
      return NextResponse.json({ ...(body as Record<string, unknown>), correlationId });
    } catch (error) {
      return jsonError(error, correlationId);
    }
  };
}

export function bodyRoute<S extends z.ZodType>(
  schema: S,
  handler: (ctx: Ctx, body: z.infer<S>) => Promise<unknown>,
) {
  return async (request: Request): Promise<NextResponse> => {
    const correlationId = newCorrelationId();
    try {
      await ensureBootstrapped();
      const db = await getDb();
      const raw: unknown = await request.json().catch(() => ({}));
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new AppError("VALIDATION_FAILED", "The request body did not validate.", {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const body = await handler({ db, url: new URL(request.url), correlationId }, parsed.data);
      return NextResponse.json({ ...(body as Record<string, unknown>), correlationId });
    } catch (error) {
      return jsonError(error, correlationId);
    }
  };
}

export function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
}
