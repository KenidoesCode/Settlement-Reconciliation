import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { exceptionsCsv, reconciliationReport } from "@/eval/export";
import { jsonError } from "@/api/handler";
import { newCorrelationId } from "@/shared/ids";
import { appendReceipt } from "@/shared/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Downloads the run's outputs.
 *
 * Served as attachments rather than as an API response, because the point of
 * this endpoint is that the file leaves here and is opened somewhere else — a
 * spreadsheet for the CSV, a document for the report. An endpoint that requires
 * a curl pipeline before a controller can look at their queue is an endpoint
 * nobody uses.
 *
 * The export is recorded on the audit chain. Who took the queue out of the
 * system, and when, is exactly the kind of thing an auditor asks about later.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const correlationId = newCorrelationId();
  try {
    await ensureBootstrapped();
    const db = await getDb();

    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "csv";
    const runId = url.searchParams.get("runId") ?? undefined;

    if (format !== "csv" && format !== "md") {
      return NextResponse.json(
        { error: "VALIDATION_FAILED", message: "format must be csv or md.", correlationId },
        { status: 400 },
      );
    }

    const { filename, body } =
      format === "csv" ? await exceptionsCsv(db, runId) : await reconciliationReport(db, runId);

    await appendReceipt(db, {
      eventType: "EXPORT",
      correlationId,
      payload: { format, filename, bytes: Buffer.byteLength(body, "utf8"), runId: runId ?? "latest" },
    });

    return new NextResponse(body, {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + filename + '"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return jsonError(error, correlationId);
  }
}
