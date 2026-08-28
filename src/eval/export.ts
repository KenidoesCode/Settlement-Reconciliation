import { desc, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client";
import { evaluationRuns, exceptions, matchRuns, matches, records } from "../db/schema";
import { AppError } from "../shared/errors";
import { inr } from "../shared/money";
import type { EvaluationMetrics } from "./evaluate";

/**
 * Exports.
 *
 * Two formats, for two different people.
 *
 * The CSV is for the controller who has to WORK the queue: it opens in a
 * spreadsheet, it is ordered by money at risk, and every column is one they can
 * act on. It is not a dump of the database — a dump would include the run id
 * and the feature vector and none of the amounts, which is the export every
 * reconciliation tool ships and nobody uses.
 *
 * The Markdown report is for the person who has to SIGN OFF on the run. It
 * leads with what the engine did and did not do, includes the baseline
 * comparison and the regressions, and states the corpus limits — because a
 * reconciliation report that only lists successes is asking to be trusted.
 */

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Quote when the cell contains a delimiter, a quote or a newline. A naive
  // export that skips this produces a file that opens with the columns shifted,
  // which is worse than no file because it looks fine.
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export async function exceptionsCsv(db: Database, runId?: string): Promise<{ filename: string; body: string }> {
  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const run = runId ? runs.find((r) => r.id === runId) : runs.find((r) => r.strategy !== "baseline-exact");
  if (!run) throw new AppError("RUN_NOT_FOUND", "No reconciliation run to export.");

  const rows = await db.select().from(exceptions).where(eq(exceptions.runId, run.id));
  const ordered = [...rows].sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor);

  const referenced = [...new Set(ordered.flatMap((r) => [...r.recordIds, ...r.recommendedRecordIds]))];
  const recordRows =
    referenced.length > 0 ? await db.select().from(records).where(inArray(records.id, referenced)) : [];
  const byId = new Map(recordRows.map((r) => [r.id, r] as const));

  const lines: string[] = [];
  lines.push(
    csvRow([
      "exception_id",
      "kind",
      "amount_at_risk_inr",
      "amount_at_risk_minor",
      "engine_confidence",
      "candidates_offered",
      "record_source",
      "record_external_id",
      "record_reference",
      "record_amount_inr",
      "record_value_date",
      "recommended_external_ids",
      "recommended_sources",
      "reviewed",
      "explanation",
    ]),
  );

  for (const row of ordered) {
    const subject = byId.get(row.recordIds[0] ?? "");
    const recommended = row.recommendedRecordIds.map((id) => byId.get(id)).filter(Boolean);

    lines.push(
      csvRow([
        row.id,
        row.kind,
        // Both a human-readable amount and the exact minor units. The rupee
        // column is what a controller reads; the minor-unit column is what
        // survives a spreadsheet deciding a currency string is text.
        inr(row.amountAtRiskMinor),
        row.amountAtRiskMinor,
        row.confidence.toFixed(4),
        row.recommendedRecordIds.length,
        subject?.kind ?? "",
        subject?.externalId ?? "",
        subject?.reference ?? "",
        subject ? inr(subject.amountMinor) : "",
        subject ? subject.valueDate.toISOString().slice(0, 10) : "",
        recommended.map((r) => r?.externalId ?? "").join(" | "),
        recommended.map((r) => r?.kind ?? "").join(" | "),
        row.resolvedByReviewId ? "yes" : "no",
        row.explanation,
      ]),
    );
  }

  return {
    filename: "exceptions-" + run.id + ".csv",
    // CRLF: the line ending Excel expects on Windows, which is where a finance
    // controller opens this.
    body: lines.join(String.fromCharCode(13) + String.fromCharCode(10)) + String.fromCharCode(13) + String.fromCharCode(10),
  };
}

export async function reconciliationReport(db: Database, runId?: string): Promise<{ filename: string; body: string }> {
  const runs = await db.select().from(matchRuns).orderBy(desc(matchRuns.createdAt));
  const run = runId ? runs.find((r) => r.id === runId) : runs.find((r) => r.strategy !== "baseline-exact");
  if (!run) throw new AppError("RUN_NOT_FOUND", "No reconciliation run to report on.");

  const evaluations = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt));
  const comparison = evaluations.find((e) => e.baselineRunId !== null)?.metrics as
    | { system: EvaluationMetrics; baseline: EvaluationMetrics; regressions: string[] }
    | undefined;

  const matchRows = await db.select().from(matches).where(eq(matches.runId, run.id));
  const exceptionRows = await db.select().from(exceptions).where(eq(exceptions.runId, run.id));
  const atRisk = exceptionRows.reduce((sum, r) => sum + r.amountAtRiskMinor, 0);
  const open = exceptionRows.filter((r) => r.resolvedByReviewId === null);

  const byKind = new Map<string, { count: number; amount: number }>();
  for (const row of exceptionRows) {
    const entry = byKind.get(row.kind) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += row.amountAtRiskMinor;
    byKind.set(row.kind, entry);
  }

  const out: string[] = [];
  const push = (line = ""): void => {
    out.push(line);
  };

  push("# Reconciliation report");
  push();
  push("**Run** `" + run.id + "` — " + run.label);
  push();
  push("Generated " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC.");
  push();
  push("> **Synthetic data.** This is a generated corpus, not a real ledger. No live");
  push("> credential is read and no Razorpay endpoint is called from this system.");
  push();

  /*
    WHAT THE RUN DID NOT DO COMES FIRST.

    A reconciliation report that opens with a match rate invites the reader to
    stop there. The number that decides whether this run can be signed off is
    how much money is sitting unactioned in the queue, so that is the first
    thing on the page.
  */
  push("## What still needs a person");
  push();
  push("- **" + open.length + " open exceptions**, holding **" + inr(atRisk) + "** unactioned.");
  push("- " + exceptionRows.filter((r) => r.recommendedRecordIds.length > 1).length +
       " of them are genuinely ambiguous: the engine found several candidates it could not tell apart and is showing all of them rather than picking one.");
  push("- " + run.unresolvedCount + " records produced no candidate the engine had any reason to believe in.");
  push();
  push("An empty queue on a real ledger usually means the thresholds are too loose, not that the day went well.");
  push();

  push("## Exceptions by kind");
  push();
  push("| Kind | Count | Amount at risk |");
  push("|---|---:|---:|");
  for (const [kind, entry] of [...byKind.entries()].sort(([, a], [, b]) => b.amount - a.amount)) {
    push("| `" + kind + "` | " + entry.count + " | " + inr(entry.amount) + " |");
  }
  push();

  push("## What the run did");
  push();
  push("| | |");
  push("|---|---:|");
  push("| Records reconciled | " + run.recordCount + " |");
  push("| Candidate pairs scored | " + run.candidateCount.toLocaleString() + " |");
  push("| Match groups resolved | " + matchRows.length + " |");
  push("| Exceptions raised | " + exceptionRows.length + " |");
  push("| Unresolved records | " + run.unresolvedCount + " |");
  push("| Duration | " + run.durationMs + " ms |");
  push("| Throughput | " + Math.round(run.recordsPerSecond).toLocaleString() + " records/sec |");
  push("| Adjudicator | " + run.adjudicator + " |");
  push();
  push("Comparing every pair would have been " +
       Math.round((run.recordCount * (run.recordCount - 1)) / 2).toLocaleString() +
       " comparisons. Blocking reduced that to " + run.candidateCount.toLocaleString() + ".");
  push();

  push("### Thresholds used");
  push();
  push("| Threshold | Value |");
  push("|---|---:|");
  for (const [key, value] of Object.entries(run.thresholds)) push("| `" + key + "` | " + value + " |");
  push();
  push("Every one of these was tuned against this corpus, not derived from loss data.");
  push("A real ledger would need them re-derived.");
  push();

  if (comparison) {
    const { system, baseline, regressions } = comparison;

    push("## Measured against held-out ground truth");
    push();
    push("The unit is a **pair of records**, not a match group: a group of four correct");
    push("records and a group of four with one intruder are both \"one match\", and scoring");
    push("by group would let the intruder disappear.");
    push();
    push("A truth pair the engine declined to resolve and sent to the queue is counted as a");
    push("**correct exception**, not a miss. It still costs recall — which it should — but");
    push("scoring it as an error would push a designer toward resolving everything.");
    push();
    push("| | Exact-join baseline | This engine |");
    push("|---|---:|---:|");
    push("| Match rate | " + (baseline.matchRate * 100).toFixed(1) + "% | " + (system.matchRate * 100).toFixed(1) + "% |");
    push("| Precision | " + baseline.precision.toFixed(3) + " | " + system.precision.toFixed(3) + " |");
    push("| Recall | " + baseline.recall.toFixed(3) + " | " + system.recall.toFixed(3) + " |");
    push("| F1 | " + baseline.f1.toFixed(3) + " | " + system.f1.toFixed(3) + " |");
    push("| False matches | " + baseline.falsePairs + " | " + system.falsePairs + " |");
    push("| Missed pairs | " + baseline.missedPairs + " | " + system.missedPairs + " |");
    push("| Unresolved records | " + baseline.unresolvedCount + " | " + system.unresolvedCount + " |");
    push();

    push("### Per defect shape");
    push();
    push("| Shape | Truth pairs | Recovered | False | To a person | Lost | Recall |");
    push("|---|---:|---:|---:|---:|---:|---:|");
    for (const shape of system.perShape) {
      push(
        "| " + shape.shape + " | " + shape.truthPairs + " | " + shape.truePairs + " | " + shape.falsePairs +
        " | " + shape.exceptionPairs + " | " + shape.missedPairs + " | " + shape.recall.toFixed(3) + " |",
      );
    }
    push();
    push("Reported per shape so a good aggregate cannot hide a defect class the engine");
    push("never handles. The `many-to-one` row is *supposed* to show zero recovered and");
    push("zero false — every one of those cases should reach a person, and a run that");
    push("starts resolving them has got worse, not better.");
    push();

    push("### Where the baseline wins");
    push();
    if (regressions.length === 0) {
      push("Nothing on this run. That is a claim about this corpus and not a general one:");
      push("on a ledger with clean references and no fee deductions, an exact join would tie");
      push("on everything and cost far less to operate.");
    } else {
      for (const regression of regressions) push("- " + regression);
    }
    push();

    push("### Confidence calibration");
    push();
    push("| Band | Pairs | Correct | Observed precision |");
    push("|---|---:|---:|---:|");
    for (const bucket of system.calibrationBuckets) {
      push("| " + bucket.bucket + " | " + bucket.pairs + " | " + bucket.truePairs + " | " + bucket.observedPrecision.toFixed(3) + " |");
    }
    push();
    push("Mean confidence on correct pairs " + system.meanConfidenceTrue.toFixed(3) + ", on wrong pairs " +
         system.meanConfidenceFalse.toFixed(3) + ". If those two were close, the confidence");
    push("number would not be carrying information and the threshold would be arbitrary.");
    push();
  } else {
    push("## Measured against ground truth");
    push();
    push("No evaluation has been run against this reconciliation, so no precision or recall");
    push("figure is reported. Uploaded records carry no ground truth and the evaluator");
    push("refuses to compute metrics it cannot support.");
    push();
  }

  push("## Limits of this report");
  push();
  push("- The corpus is synthetic and its reference format is regular. Precision here is");
  push("  partly a property of that regularity.");
  push("- Split settlements whose reference was also mangled are lost outright rather than");
  push("  queued. That is the worst failure mode in this system.");
  push("- Candidates are persisted as a capped sample per run, so the candidate table in");
  push("  the console is not the full set.");
  push();

  return { filename: "reconciliation-report-" + run.id + ".md", body: out.join("\n") };
}
