# Settlement Reconciliation

Multi-source reconciliation across payments, orders, settlements, bank statements
and invoices. Blocking, fuzzy scoring, and a policy engine whose most important
job is refusing to decide the cases it cannot actually tell apart.

**A settlement is never the order amount.** It is the order minus a gateway fee
minus GST on that fee. The bank narration wraps the reference in `NEFT/…/HDFC`
or truncates it to a field width. The credit lands three days late, or eleven.
An exact join finds none of this, which is why reconciliation is still done by
hand in most finance teams.

---

## Results

728 records across 5 sources, 1,098 ground-truth pairs, measured against
held-out truth the matcher never sees.

| | Exact-join baseline | Fuzzy + adjudicator |
| --- | --- | --- |
| Match rate | 84.5% | **89.0%** |
| Precision | 1.000 | **1.000** |
| Recall | 0.596 | **0.934** |
| F1 | 0.747 | **0.966** |
| False matches | 0 | **0** |
| Missed pairs | 432 | **30** |
| Exceptions raised | 113 | 78 |
| Unresolved records | 101 | **3** |
| Throughput | ~8,000 rec/sec | ~7,800 rec/sec |

Per defect shape:

| Shape | Truth pairs | Recovered | False | To a person | Lost | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 360 | 360 | 0 | 0 | 0 | 1.000 |
| fee-deducted | 340 | 340 | 0 | 0 | 0 | 1.000 |
| split-settlement | 210 | 168 | 0 | 12 | **30** | **0.800** |
| timing-lag | 66 | 66 | 0 | 0 | 0 | 1.000 |
| reference-typo | 60 | 60 | 0 | 0 | 0 | 1.000 |
| missing-counterpart | 8 | 8 | 0 | 0 | 0 | 1.000 |
| duplicate | 24 | 24 | 0 | 0 | 0 | 1.000 |
| many-to-one | 30 | **0** | **0** | **30** | 0 | **0.000** |

### Reading these honestly

**The many-to-one row of 0.000 recall is the result this system is proudest of.**
Three identical credits from one merchant on one day, references mangled past
recognition. Nothing distinguishes them. Every one of those 30 pairs goes to a
person, none is resolved, and none is silently lost. A version of this engine
that scored recall there would be guessing, and a guess that happens to be right
on this corpus will be wrong on the next one.

**The split-settlement recall of 0.800 is the real weakness.** 30 truth pairs
lost outright — neither matched nor queued. The merge pass recovers a split when
the parts sum to the whole and share a reference; it does not recover one where
the reference was also mangled, and those cases fall out of the ledger without
anyone being told. That is the worst failure mode in this product and it is the
first thing to fix.

**Precision of 1.000 with zero false matches is partly fitted to this corpus.**
The rule that got it there — that two same-length references differing only in
digit positions are different serial numbers, not one mistyped — exploits the
fact that this generator produces references as a shared prefix plus a sequence.
Real ledgers use other conventions. On one of them that rule would need
re-deriving, and precision would very likely not be 1.000. It is stated at the
function, not just here.

**"Where the baseline wins: nothing on this run" is a claim about this corpus.**
On a ledger with clean references and no fee deductions, an exact join would tie
on everything and cost far less to operate. The comparison code populates the
regression list from the same pass that computes the wins, so a run where the
baseline is better cannot report the wins without the losses beside them.

**Ground truth exists only for generated records.** Anything uploaded through
`/api/ingest` has no truth group, and the evaluator refuses to compute precision
and recall over it rather than reporting numbers it cannot support.

---

## The engine

Three stages, and the boundaries between them are the design.

```
  ingest ─→ normalize ─→ BLOCKING ─→ SCORING ─→ [adjudicator] ─→ POLICY ─→ group
                         recall       features    ambiguous band   decides   union-find
                         only         only        only                       + split merge
```

**Blocking** is recall-only. Keys are deliberately loose and overlapping —
reference, reference prefix (for truncation), two adjacent amount buckets,
counterparty-and-date — because a missed block is a missed match forever.
Precision is left entirely to scoring. 728 records produce ~2,000 candidate
pairs instead of 264,628.

**Scoring** produces five feature values and a weighted total. Nothing decides.
Two hard gates rather than features: a currency mismatch scores zero (two amounts
in different currencies are incomparable, not similar), and **two records from
the same source score zero** — reconciliation means finding a counterpart in a
*different* system, and an earlier version that scored same-source pairs had
three orders for the same amount matching *each other* on reference similarity
alone.

**Amount agreement is not `|a - b| < ε`.** A gap explainable as a fee plus 18%
GST scores 0.92; the score decays to zero at three times the tolerance. That
single feature is most of the difference between 0.596 and 0.934 recall.

**The policy engine** is the only place a decision is made, and its central rule
was rewritten after measuring:

> Ambiguity is **mutual exclusivity**, not similarity. Two candidates are
> mutually exclusive when they come from the **same source** and **each one alone
> accounts for the subject's amount**.

The first version treated "several candidates score about the same" as ambiguity
and scored **0.000 recall on the clean shape** — the easiest shape in the corpus.
In a four-record reconciliation every record has three near-perfect candidates,
and they are not alternatives; they are the other three parts of the same event.
Two bank lines for 40% and 60% of an order are complementary too — they *sum*.
Two bank lines each for the full amount are alternatives, and picking is
guessing. That test separates the trap from the clean case and from the split
case, which similarity alone cannot do.

**Matches are groups, not pairs.** Pairwise decisions are unioned into connected
components, so an order, a payment, a settlement and a bank line are one
reconciliation rather than three pairings.

---

## Where AI sits, and where it does not

Deterministic code owns normalization, blocking, scoring, thresholds and every
decision. The adjudicator is called **only** for candidates in the band between
the review floor and the resolve threshold, and it can do exactly two things:
nudge a confidence within ±0.12 and supply a reason.

It cannot:

- resolve a match — the policy engine re-checks ambiguity *after* adjudication,
  so a tie stays an exception however confident the adjudicator is;
- push a pair past the resolve threshold on its own — the clamp is enforced in
  code, not trusted;
- see the ground truth — it receives the same normalized fields the scorer does.

**`ADJUDICATOR=deterministic` is the default and produced every number above.**
It is a second opinion computed from the features rather than a model: it
recognises a gap that is within two rupees of a standard fee rate plus GST, a
date offset matching a known settlement cycle, a reference that is a clean
prefix truncation, and — costing confidence — a match carried by the counterparty
alone, which is the pattern that produces false matches.

`ADJUDICATOR=openai|anthropic` with `LLM_API_KEY` routes the same pairs to a
model under the same clamp and the same schema. Every evaluation result records
which one ran, because a match rate produced by a model and one produced by a
scorer are different claims. A model failure falls back to the deterministic
opinion and marks the result `fellBack` rather than failing the batch or
silently resolving.

**Where deterministic matching suffices, and it mostly does:** clean,
fee-deducted, timing-lag and duplicate shapes are all solved by the feature
scorer alone. The adjudicator earns its place only in the ambiguous band, and on
this corpus that is a few dozen pairs out of a thousand.

---

## Failure engineering

| Failure | Caught where | What happens | What must never happen |
| --- | --- | --- | --- |
| Ambiguous many-to-one | Policy, mutual-exclusivity test | Exception with **every** indistinguishable candidate attached | A confident pick between interchangeable records |
| Missing counterpart | Policy, empty candidate set | `MISSING_COUNTERPART` with the amount at risk | Filing it as a low-confidence match |
| Duplicate delivery | Ingestion, unique index | Stored with `duplicateOfId`, excluded from matching | A second plausible match for money that moved once |
| Malformed row | CSV parser, before any write | Rejected with its line number | Coercing an unparseable amount |
| Oversized upload | Ingestion, before parsing | 413 with the limit stated | Parsing first, checking after |
| Adjudicator down | Adjudicator, any failure | Deterministic fallback, marked `fellBack` | Failing the batch, or silently resolving |
| No ground truth | Evaluator | Refuses to compute precision/recall | Reporting metrics it cannot support |

The exception queue is **ordered by money at risk, not by time**. A controller
with forty exceptions and an hour should start with the expensive ones, and a
chronological queue actively prevents that.

When the engine could not tell three bank lines apart, the queue shows **all
three**, side by side. Showing one and asking "approve?" launders a coin-flip
through a person and produces an approval that looks like human judgement.

A review does not delete the exception it settles. The audit trail records the
engine's confidence, the number of candidates offered, and the amount at risk as
they stood at the time — because an approval on an exception that offered three
indistinguishable candidates is not the same decision as one that offered a
single clear counterpart.

---

## Audit

Every ingestion, run and review appends a hash-chained receipt naming the
SHA-256 of its predecessor's canonical payload. Remove one and everything after
it stops linking; edit one and its own hash stops matching. Both cases are
detected and reported separately, because they are different incidents.

---

## Data

All synthetic, labelled as such on every page. Razorpay-shaped identifiers
(`order_`, `pay_`, `setl_`) because match detail binds them and an unrealistic
identifier would make the binding unconvincing. **No live credential is read and
no Razorpay endpoint is called from this repository.**

The corpus is built from **fixed counts per defect shape, not probabilities** — a
corpus that only *usually* contains a many-to-one case is one whose hardest
number moves for reasons unrelated to the matcher. Reference corruption models
what actually happens (truncation to a field width, case folding, separator
substitution, OCR confusions, dropped characters), not random character noise: a
matcher tuned against random noise is tuned against the wrong thing.

---

## Design

**Art deco, 1931** — the visual language of the buildings finance was actually
conducted in. Midnight ground, brass rules, stepped chevrons, wide display
capitals. The reason it fits rather than being a mood: reconciliation is a
two-column problem — books on one side, bank on the other, a line drawn between
them when they agree — and deco is built on symmetry about a centre axis. The
ornament and the data structure are the same shape.

The **tie-line ledger** on the match detail page is where that pays off: books
left, bank right, a brass line for every pair the engine tied together, and the
residual printed on the axis in jade when it is inside the declared fees and
carmine when it is not.

---

## Running it

```bash
npm install
npm run db:migrate        # PGlite: real PostgreSQL, in-process, no server
npm run gen:ledgers       # seeded corpus with held-out ground truth
npm run reconcile         # the engine
npm run reconcile -- --baseline
npm run evaluate          # precision, recall, per-shape, baseline comparison
npm test                  # 55 tests against a real in-process database
npm run verify            # typecheck + lint + tests + build
```

`DATABASE_URL=pglite://:memory:` runs entirely in memory, which is what the
deployment uses: a serverless filesystem is read-only apart from an ephemeral
`/tmp`. The corpus is therefore generated, reconciled twice and evaluated during
bootstrap on each cold instance (~1.7s). The alternative is a deployed
reconciliation dashboard with nothing in it.

`postgres://…` switches to a real server with the same migrations.

## API

```
POST /api/ingest       { "mode": "generate" } | { "mode": "csv", "kind": "...", "csv": "..." }
POST /api/reconcile    { "strategy": "fuzzy+adjudicator", "thresholds": { "resolve": 0.82 } }
GET  /api/matches?runId=
GET  /api/exceptions?runId=      ordered by money at risk
POST /api/evaluate     { "withBaseline": true }
POST /api/reviews      { "exceptionId": "...", "outcome": "ESCALATED", "note": "..." }
GET  /api/audit
POST /api/demo/<clean-batch|fee-mismatch|many-to-one-exception|missing-counterpart|baseline-vs-ai>
GET  /api/health
```

## Tuned, not derived

Every threshold below was set by running this corpus and reading where precision
and recall crossed. None is derived from loss data, and all would need
re-deriving for a real ledger. Each is labelled at its definition.

| | | |
| --- | --- | --- |
| `resolve` | 0.82 | below it the reference-typo shape starts producing false matches |
| `floor` | 0.45 | below it a candidate is noise, and queueing it wastes review time |
| `ambiguityMargin` | 0.08 | tighter, and the many-to-one near-ties let a coin-flip resolve |
| `dateWindowDays` | 12 | the corpus lags up to 11 days; a real deployment sets this from its T+n contract |
| `feeToleranceFraction` | 0.035 | a 2.5% fee plus 18% GST tops out near 2.95% |
| `roundingSlackMinor` | 200 | two rupees, for paise rounding on a split |
| adjudicator clamp | ±0.12 | enough to move a borderline pair, never enough to decide one |
| serial-reference score | 0.3 | keeps such a pair in the candidate set, far too little to resolve it alone |

## Known limits

- **Split settlements with a mangled reference are lost**, not queued. 30 pairs
  on this corpus. The merge pass requires a shared normalized reference before
  it will try summation, because without that constraint it becomes subset-sum
  over the whole ledger — intractable, and an excellent way to invent matches
  out of arithmetic coincidence.
- **Precision is partly fitted to this corpus's reference format.** See above.
- **No model was called.** The default adjudicator is deterministic and every
  reported number came from it.
- **Blocks larger than 60 records are skipped**, not sampled. A block that has
  swallowed a large share of the corpus is not a block, but the skip is silent
  in the sense that it does not appear as its own metric — only as a lower
  candidate count.
- **Candidates are persisted as a capped sample of 500 per run.** The run page
  prints both numbers so the table is not mistaken for the full set.
