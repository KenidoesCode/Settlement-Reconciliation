import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { DEMO_SCENARIOS, runDemo, type DemoScenario } from "@/eval/demo";
import { jsonError } from "@/api/handler";
import { newCorrelationId } from "@/shared/ids";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ scenario: string }> },
): Promise<NextResponse> {
  const correlationId = newCorrelationId();
  try {
    await ensureBootstrapped();
    const db = await getDb();
    const { scenario } = await context.params;

    if (!(DEMO_SCENARIOS as readonly string[]).includes(scenario)) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Available: " + DEMO_SCENARIOS.join(", ") + ".", correlationId },
        { status: 404 },
      );
    }

    return NextResponse.json({ result: await runDemo(db, scenario as DemoScenario), correlationId });
  } catch (error) {
    return jsonError(error, correlationId);
  }
}
