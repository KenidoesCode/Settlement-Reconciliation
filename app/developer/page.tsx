import { getDb } from "@/db/client";
import { ensureBootstrapped } from "@/db/bootstrap";
import { sources } from "@/db/schema";
import { environmentStatus } from "@/shared/env";
import { DEFAULT_THRESHOLDS } from "@/match/engine";
import { ADJUSTMENT_LIMIT } from "@/match/adjudicator";
import { SHAPE_MIX, DATASET_VERSION } from "@/ingest/generate";
import { Panel, Row } from "@/ui/parts";

export const dynamic = "force-dynamic";

const ENDPOINTS = [
  {
    method: "POST",
    path: "/api/ingest",
    body: '{ "mode": "generate", "seed": 20260828 }  |  { "mode": "csv", "kind": "BANK_STATEMENT", "csv": "..." }',
    note: "Generates the seeded corpus, or ingests a CSV. Rejected rows come back with line numbers.",
  },
  {
    method: "POST",
    path: "/api/reconcile",
    body: '{ "strategy": "fuzzy+adjudicator", "thresholds": { "resolve": 0.82 } }',
    note: "Runs the pipeline. Every threshold is overridable per run and stored with the run.",
  },
  { method: "GET", path: "/api/matches?runId=", body: null, note: "Match groups for a run." },
  {
    method: "GET",
    path: "/api/exceptions?runId=",
    body: null,
    note: "The exception queue, ordered by money at risk.",
  },
  {
    method: "POST",
    path: "/api/evaluate",
    body: '{ "runId": "run_...", "withBaseline": true }',
    note: "Precision, recall, per-shape results and the baseline comparison.",
  },
  { method: "GET", path: "/api/audit", body: null, note: "The hash chain and its receipts." },
  {
    method: "POST",
    path: "/api/reviews",
    body: '{ "exceptionId": "exc_...", "outcome": "ESCALATED", "note": "..." }',
    note: "Records a review. Appends to the audit chain; does not delete the exception.",
  },
  { method: "POST", path: "/api/demo/<scenario>", body: null, note: "One of the five demonstrations, run live." },
  { method: "GET", path: "/api/health", body: null, note: "Environment, record count, chain state." },
];

export default async function DeveloperPage() {
  await ensureBootstrapped();
  const db = await getDb();
  const env = environmentStatus();
  const sourceRows = await db.select().from(sources);

  return (
    <div className="space-y-5">
      <div>
        <p className="label">Developer</p>
        <h1 className="display text-2xl text-[var(--color-ivory)]">Everything is reachable over HTTP</h1>
      </div>

      <div className="course-panels">
        <Panel title="Endpoints">
          <div className="space-y-3">
            {ENDPOINTS.map((endpoint) => (
              <div key={endpoint.path} className="border-l border-[var(--color-rule-bright)] pl-3">
                <p className="mono text-[var(--color-ivory)]">
                  <span className="text-[var(--color-brass-bright)]">{endpoint.method}</span> {endpoint.path}
                </p>
                {endpoint.body && (
                  <p className="mono mt-0.5 text-[0.6875rem] text-[var(--color-ivory-faint)]">{endpoint.body}</p>
                )}
                <p className="mt-0.5 text-xs text-[var(--color-ivory-dim)]">{endpoint.note}</p>
              </div>
            ))}
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel title="Environment">
            <div className="space-y-2">
              <Row label="Mode" value={env.nodeEnv} />
              <Row label="Database driver" value={env.database.driver} />
              <Row label="Database target" value={env.database.target} />
              <Row label="Adjudicator configured" value={env.adjudicator.configured} />
              <Row label="Adjudicator effective" value={env.adjudicator.effective} />
              <Row label="LLM key present" value={env.adjudicator.apiKeyPresent ? "yes" : "no"} />
              <Row label="Corpus seed" value={String(env.seed)} />
              <Row label="Max upload bytes" value={env.limits.maxUploadBytes.toLocaleString()} />
              <Row label="Max rows per file" value={env.limits.maxRowsPerFile.toLocaleString()} />
            </div>
            <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
              A model adjudicator with no API key is not configured, whatever the variable says. The effective
              row is what actually runs, and every evaluation result records it — a match rate produced by a
              model and one produced by a scorer are different claims.
            </p>
          </Panel>

          <Panel title="Default thresholds">
            <div className="space-y-2">
              {Object.entries(DEFAULT_THRESHOLDS).map(([key, value]) => (
                <Row key={key} label={key} value={String(value)} />
              ))}
              <Row label="adjudicator adjustment limit" value={String(ADJUSTMENT_LIMIT)} />
            </div>
            <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
              Every one of these was tuned against this corpus and would need re-deriving for a real ledger. The
              adjudicator can move a confidence by at most {ADJUSTMENT_LIMIT}, clamped in code rather than
              trusted, and the policy engine re-checks ambiguity afterwards — so an adjudicator cannot resolve a
              tie however confident it is.
            </p>
          </Panel>
        </div>
      </div>

      <div className="course-panels">
        <Panel title="Corpus composition">
          <div className="space-y-2">
            {Object.entries(SHAPE_MIX).map(([shape, count]) => (
              <Row key={shape} label={shape} value={String(count) + " groups"} />
            ))}
            <Row label="dataset version" value={DATASET_VERSION} />
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            Fixed counts, not probabilities. A corpus that only usually contains a many-to-one case is a corpus
            whose hardest number moves for reasons unrelated to the matcher.
          </p>
        </Panel>

        <Panel title="Sources">
          <div className="space-y-2">
            {sourceRows.map((source) => (
              <Row key={source.id} label={source.label} value={source.rowCount + " rows"} />
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--color-ivory-faint)]">
            All synthetic. Razorpay-shaped identifiers (order_, pay_, setl_) are used because receipts and match
            detail bind them and an unrealistic identifier would make the binding unconvincing. No live
            credential is read and no Razorpay endpoint is called from this repository.
          </p>
        </Panel>
      </div>

      <Panel title="Local run">
        <pre className="mono overflow-x-auto whitespace-pre bg-[rgba(255,255,255,0.03)] p-3 text-[0.6875rem] text-[var(--color-ivory-dim)]">
{`npm install
npm run db:migrate          # PGlite: real PostgreSQL, in-process, no server
npm run gen:ledgers         # seeded multi-source corpus with ground truth
npm run reconcile           # baseline and engine, both persisted
npm run evaluate            # precision, recall, per-shape, baseline comparison
npm test                    # 40+ tests against a real in-process database
npm run verify              # typecheck + lint + tests + build`}
        </pre>
      </Panel>
    </div>
  );
}
