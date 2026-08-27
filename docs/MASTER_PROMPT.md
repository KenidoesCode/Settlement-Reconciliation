# MASTER PROMPT 4A — Multi-Source Settlement Reconciliation

> Captured verbatim as received. This file is the authoritative specification for
> this project. Do not edit it to match the implementation; change the
> implementation to match it, or record a deviation in `docs/design-decisions.md`.

## Standing rules supplied with the prompt

You are building ONE project in this session. Do not touch any other directory. Follow these rules exactly.

**Git hygiene** (enforce from the first commit, never fix retroactively). Never add Co-Authored-By, Claude, Claude-Session, Anthropic, Generated-by, or any AI/tool attribution to commit messages, bodies, trailers, git notes, tags, branch names, or any Git metadata. Commit and author as the Git identity already configured in the repo. Before each commit, print the full commit message and confirm it contains no AI/tool attribution. After each commit, run `git log -1 --format='%an <%ae> | %cn <%ce>%n%B'` and verify. Do not rewrite history to clean attribution — prevent it. Keep commits meaningful; no session logs, transcripts, temp files, .env, secrets, or credentials committed.

**Isolation.** Confirm pwd before modifying anything. Inspect existing repo structure first. Work only inside this project's directory. Never copy hidden AI/tool config from elsewhere. Add a .gitignore covering node_modules, .env*, build output, and OS/editor cruft before the first commit.

**Honesty.** No fake buttons, no placeholder functionality, no mocked responses unless the spec explicitly requires a labeled simulator. Never claim a build, test, payment, metric, or flow works unless you actually ran it and saw it pass. If something can't be completed, say so plainly in the report — don't pretend.

**Phase gates.** Build in the phase order given in the prompt. After each phase, run the relevant checks (typecheck, lint, build, tests, or manual flow verification) and state the result before continuing. Do not advance a phase on a red gate. Commit at meaningful phase boundaries only.

**Ambiguity.** Make the smallest reasonable assumption that keeps moving, and list assumptions in the final report.

**Final report per project:** what was built, features completed, checks/tests actually run (with outcomes), anything genuinely remaining, and exact local run commands.

---

## MASTER PROMPT 4A

You are a senior full-stack engineer, AI engineer, backend engineer, fintech engineer, security engineer, UX engineer, DevOps engineer, QA engineer, and technical writer combined. Own this end-to-end. No stubs, no fake buttons, no fabricated responses. Polished, working, demo-ready.

**OBJECTIVE.** Build a Multi-Source Settlement Reconciliation finance-controller system reconciling ≥50 synthetic records across sources — PG data, orders, settlements, bank statements, invoices — reporting match rate, throughput, accuracy, false matches, unresolved records, exceptions, confidence, routing ambiguous cases to human review. For finance-ops teams reconciling by hand. AI is necessary because fuzzy matching across mismatched references, timing, and fees defeats exact joins. Success = high match rate with low false-match rate and an honest exception list, beating a naive exact-join baseline.

**NON-NEGOTIABLE THESIS.** The matching engine is the product: multi-source ingestion → normalization → candidate generation → fuzzy/confidence matching → resolved/unresolved/exception classification → human review. NOT a chatbot on CSVs.

**BUILD EVERYTHING.** Frontend, backend, PostgreSQL, ingestion/normalization, AI-assisted matching layer, deterministic confidence/threshold engine, eval harness, human-review UI, logging, audit trail, tests, reproducible synthetic multi-source data, deterministic demo mode, deployment config, docs.

**TECH STACK.** Next.js + TS + Tailwind + shadcn/ui, Node backend, PostgreSQL + Drizzle. Python + FastAPI for matching/eval where it helps. Modular monolith, one repo, one DB. No unnecessary infra.

**AI ARCHITECTURE.** Deterministic code owns normalization, blocking/candidate generation, threshold resolution. AI assists ambiguous fuzzy matches (fee-adjusted amounts, reference variants, timing offsets) proposing match + confidence + rationale; policy engine decides resolve vs exception. Never silently resolves above threshold without deterministic confirmation. Low confidence → exception/review.

**MODEL STRATEGY.** Env-config LLM. Baseline = exact-key + nearest-neighbor (no AI); compare match rate, false-match rate, unresolved count. README justifies AI and states where deterministic matching suffices.

**DATASET.** `scripts/generate-ledgers`: ≥50 (target ≥200) reconcilable records across ≥3 sources with realistic defects (fee deductions, split settlements, timing lags, reference typos, missing counterparts, duplicates). Reproducible seed, ground-truth keys held out. Edges: one-to-many, many-to-one, unmatched.

**EVALUATION.** Match rate, false-match rate, match precision/recall, throughput (records/sec), unresolved count, exception count, confidence calibration — from real runs. Report the full batch, not one match.

**FAILURE ENGINEERING.** Ambiguous many-to-one → exception + review, never a silent wrong match. Missing counterpart → unresolved, flagged. Duplicate → dedup + idempotency. Malformed input → validation error. Every path safe.

**SECURITY.** Input validation, authn/authz, PII/financial-data minimization, audit logging, .env.example, safe file ingestion (size/type limits).

**RAZORPAY.** Use Razorpay settlement/payment IDs/formats in the synthetic PG source (test mode), reference in audit trail. Adapter + labeled simulator if no live settlement data.

**DATABASE.** sources, orders, payments, settlements, bank_statements, invoices, match_candidates, matches, exceptions, human_reviews, audit_receipts, evaluation_runs, evaluation_cases. Migrations + seed.

**UI/UX.** Fintech reconciliation dashboard: Overview (match rate, throughput, exceptions), Reconciliation Run, Match Detail (sources side-by-side + confidence + rationale), Exceptions queue, Evaluation, Failures, Audit Trail, Human Review. Loading/empty/error states.

**DEMO-FIRST.** `DEMO_SCENARIO`: clean-batch, fee-mismatch, many-to-one-exception, missing-counterpart, baseline-vs-ai. Seeded; never fabricate a match rate.

**OBSERVABILITY.** Structured logs, request/correlation IDs, match-decision logs, latency/throughput, failure logs; internal page.

**HUMAN-IN-THE-LOOP.** Exception queue: case, sources, confidence, recommended match, approve/reject/escalate; recorded.

**TESTING.** Unit, integration, API, eval, failure, security; many-to-one, missing counterpart, duplicate, malformed input, threshold behavior. Single test command.

**DOCS.** README (full sections + diagram, example calls, quickstart, eval results incl. false-match rate, example exception), `docs/architecture.md` (Mermaid), `docs/threat-model.md`, `docs/design-decisions.md` (why AI vs pure deterministic matching), `docs/failure-diary.md`, `docs/panel-defense.md` (≥20 grounded: false-match cost, calibration, throughput, when deterministic suffices, exception honesty).

**API.** `POST /api/ingest`, `POST /api/reconcile`, `GET /api/matches`, `GET /api/exceptions`, `POST /api/evaluate`, `GET /api/evaluations`, `GET /api/audit`, `POST /api/demo/:scenario`.

**PHASED BUILD (gate after each).** 1 Foundation + .gitignore → 2 DB → 3 ingestion/normalization → 4 candidate generation → 5 AI + confidence engine → 6 eval harness (with baseline) → 7 failure handling → 8 human review → 9 frontend → 10 observability → 11 tests → 12 docs → 13 polish → 14 verification. Gate green before advancing; commit at boundaries, verify metadata. Never claim a match rate/accuracy eval didn't produce; label synthetic data. End with 5-minute demo script + final report.
