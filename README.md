# Praman

**Live demo: https://PRAMAN-DEPLOY-URL-PENDING** · [DECISIONS](DECISIONS.md) · [FAILURES](FAILURES.md) · [EVAL](EVAL.md) · [eval/results.md](eval/results.md)

A **defense-only** dispute evidence responder for India's UPI agentic stack. It
reads a dispute in Razorpay's documented Disputes API schema, assembles the
evidence a merchant actually holds, decides contest-or-abstain through a
deterministic sufficiency gate, drafts a contest mapped to Razorpay's typed
evidence fields, and submits only through a human approving that specific
dispute.

The thesis, scoped precisely: **agentic evidence has to be captured at
transaction time, because by dispute time it is gone.** The agent identifier,
the Reserve Pay mandate reference, the protocol metadata and the conversation
trace live with the agent platform or the TPAP, not with the merchant. Ninety
days later there is nothing to retrieve. So the transaction store *is* the
capture layer, and `POST /evidence-pack` is that layer as a real endpoint rather
than a box on a diagram — every one of the 100 seeded disputes was captured
through it.

---

## Results

Dev corpus of 100 disputes and a held-out set of 30 that is out-of-distribution
**by construction** — different seed, different scenario mix, different
personas, and conversation language written by a different lab's model than the
one that reads it here.

| metric | dev (100) | held-out OOD (30) | shift |
| --- | --- | --- | --- |
| recall on winnable disputes | 31/38 = 81.6% | 7/9 = 77.8% | −3.8% |
| precision on contests | 100.0% | 100.0% | 0.0% |
| false positives (contested & unwinnable) | 0/52 | 0/20 | 0 |
| false-positive cost | ₹0 | ₹0 | ₹0 |
| abstention rate | 69.0% | 73.3% | +4.3% |
| assembly failures | 0 | 0 | — |

**Model of record: `qwen/qwen3.8-27b` via Groq.** The intended provider was
Anthropic; no `ANTHROPIC_API_KEY` exists in this environment, so every committed
recording is Qwen's, and deliberately *not* `openai/gpt-oss-120b`, which wrote
the held-out corpus and would have contaminated the OOD delta. The model is
frozen: it is named here rather than in a footnote because the honesty of a
"where we did not use AI" section extends to *which* AI (D-021, D-023).

**Reproduce it:** `pnpm eval` — replay mode, no network, no API key. Two runs
produce a byte-identical `eval/results.md`; a test regenerates the report and
diffs it against the committed one.

### Read the abstention rate correctly

69% abstention is the number most likely to be misread, so here is the split it
hides. A single percentage cannot tell a gate doing its job from a gate too
timid to act.

| why it abstained | dev | held-out |
| --- | --- | --- |
| correct — the corpus says the dispute is unwinnable | 52 | 20 |
| conservative — the corpus says it is genuinely ambiguous | 10 | 0 |
| **recall lost — a required artifact we do not hold, named** | **7** | **2** |
| **recall lost — the gate misjudged evidence it already held** | **0** | **0** |

Every winnable dispute we failed to contest is attributable to a specific
artifact the capture layer does not hold, and **not one** to the gate misreading
evidence it already had. The seven dev losses are named individually by dispute
id in [`eval/results.md`](eval/results.md); five of them
are one gap (`duplicate_payment_analysis`) that we scheduled, did not finish,
and froze rather than rushing on the last day — see D-033.

### What these numbers do not claim

- **The corpus is self-generated.** This is the central weakness and it is not
  eliminated, only mitigated. The metric is *decision quality under our own
  labelling*; the held-out delta is the evidence the system is not merely tuned
  to its own generator.
- **Ground truth is our judgement encoded as rules.** "Winnable" means
  "defensible on the evidence we hold", not "would have been won".
- **Zero false positives is partly a statement about the corpus.** Most
  unwinnable dev cases are unwinnable by arithmetic — amount over the mandate
  cap, mandate expired — not by judgement. The gate is really discriminated by
  the ambiguous row and by the held-out set.
- **Live model output is not reproducible and is never claimed to be.** These
  numbers are byte-reproducible because responses are replayed from committed
  recordings keyed by request hash, not because a model is deterministic.
- **No live Razorpay call is made anywhere.** Payment ids are synthetic and
  shape-valid, and they say so: `pay_SIMzSR4DUVsdOB`, `disp_SIM…`, `order_SIM…`
  — prefix plus exactly 14 base62 characters, so no schema check is weakened.
  The Disputes API exposes fetch, accept and contest only; a dispute originates
  with the customer or the issuing bank, so it cannot be created in test mode
  with or without an account. The contest path is built and verified against the
  documented request examples rather than against a live dispute (D-032).

---

## Track 2 bar mapping

| The bar | Where it is |
| --- | --- |
| **Defense-only** | Nothing in this repository generates fraud or abuses a dispute process. The simulator creates dispute *scenarios*; the product only ever defends. |
| **Held-out test set** | 30 disputes, generated once by a different model with a different prompt and persona set, never read during development. Not promised — enforced by a static test that forbids any file outside a six-entry allowlist from importing the holdout config — the eval harness is on it, because a held-out set that is never scored measures nothing, and by a guard that throws if a held-out id reaches a dev code path. |
| **Precision / recall** | Against derived ground truth, reported for both sets with the shift delta, above and in `eval/results.md`. |
| **False-positive cost in ₹** | ₹0 on both sets, because there are no false positives. The cost model excludes the disputed amount on purpose: Razorpay's docs say the amount is deducted **if you lose**, which happens whether or not you contested, so charging it to the decision would attribute a loss the decision did not cause (D-034). |
| **Abstention** | 69% dev / 73% held-out, decomposed above rather than quoted flat. Insufficient evidence abstains with a stated reason; a bluffed contest that loses is the false-positive cost we measure. |

---

## Where we deliberately did NOT use AI

The rubric asks for "the right tool in the right place, **and where you chose
not to use one**." The rule: **a money action must never depend on a stochastic
step, and an eval must be reproducible.** Everything on the money path is
deterministic code.

| Deliberately NOT AI | Why |
| --- | --- |
| Schema and field mapping | Fully specified by Razorpay's docs. A model could only add variance to something with one correct answer. Encoded as Zod schemas with contract tests against verbatim doc examples. |
| The sufficiency gate and the contest/abstain decision | This decides whether money is contested. A reviewer can read a threshold; they cannot read a model's mind. |
| Metrics computation | An eval a model participates in scoring is not an eval. |
| The submission path | One door: the human approve action in the review UI. Nothing stochastic gets to press it. |
| Mandate validity, limit and amount checks | Arithmetic and interval comparison. A model here would be worse and less explainable. |
| **Any model influence that could ADD a contest, raise an amount, or submit** | The drafter changed the outcome on 2 of 100 dev disputes, so this row is load-bearing. It holds a **veto toward safety only**: it may withhold a contest the gate approved, and it can never create one the gate declined — a declined dispute makes no model call at all. It cannot touch the amount, choose an evidence field, attach a document, or reach the adapter. Every path it can take leads to *less* money being claimed, never more, and a test asserts the pipeline can never contest more than the gate cleared. Both vetoes landed on disputes the corpus labels ambiguous. A component whose worst case is excess caution is not a stochastic step a money action depends on (D-025). |
| An agentic loop anywhere in Praman's runtime | The three jobs we hand a model are single-shot text transforms: no decision to delegate, no tool to call, no state to carry. A loop would add nondeterminism and a hard replay problem to buy capability we do not want. **Praman is agentic in its domain, not in its implementation** (D-019). |

**Claude Code — the Claude Agent SDK — built this repository.** It is in the
build loop, not on the money path: no agent loop runs inside Praman itself, and
the deployed product makes single-shot structured calls behind one interface.
Saying so here rather than being asked about it is the point.

**Where a model genuinely earns its place** — natural language in, natural
language out, no single correct answer: conversation-trace summarisation,
explanation-letter drafting, ambiguity flagging. All three sit behind one
interface in `packages/llm`, all three are recorded and replayed, and all four
of their failure modes — error, timeout, refusal, schema-validation failure —
route to `abstain("assembly failure, manual review required")` with an audit
entry, never a silent retry onto the money path.

**Enforced, not promised.** `eslint.config.js` forbids `packages/core` — the
deterministic domain — from importing `@praman/llm` or any model SDK. Crossing
the boundary fails the build.

---

## Architecture

```
   transaction time                              dispute time
   ────────────────                              ────────────
   agent checkout                                Razorpay webhook
        │                                              │
        ▼                                              ▼
   POST /evidence-pack ───────► PostgreSQL ────► collector        deterministic
   mandate · agent id ·         (the capture       │              ────────────
   protocol metadata ·           layer)            ▼
   conversation trace                        sufficiency gate ──── abstain (69%)
   orchestration log                               │                no model is
                                                   │                called at all
                                          contest  │
                                                   ▼
                                          packages/llm            model
                                          trace summary           ─────
                                          letter draft            single-shot,
                                          ambiguity flags         recorded/replayed
                                                   │              four failure paths
                                                   │              → abstain
                                                   ▼
                                          field mapper            deterministic
                                          Razorpay evidence       ────────────
                                          fields + amount
                                                   │
                                                   ▼
                                          review UI  ──► human approves ──► adapter
                                                         THE ONE DOOR
```

The order is the argument. Deterministic code collects the evidence and decides;
the model is asked only to read language and write language; deterministic code
assembles the payload. **A dispute the gate declines never reaches a model at
all** — 67 of 100 on the dev set — so no model output can have influenced those
outcomes.

| Package | What it owns |
| --- | --- |
| `packages/core` | Domain: Razorpay schemas, evidence collector, sufficiency gate, field mapper. Zero LLM imports, enforced by the linter. |
| `packages/simulator` | Seeded, deterministic corpus generator for both rails, and the held-out generator. |
| `packages/llm` | The only door to a model. Record/replay, structured outputs, four failure paths. |
| `packages/adapter` | The Disputes API contract. Simulator client and real client behind one interface. |
| `apps/api` | Fastify. `POST /evidence-pack` is the capture layer; the review routes are the pipeline. |
| `apps/ui` | React review queue and the metrics page. Plain tables; clarity over polish. |
| `eval/` | The harness, the holdout guard, and `results.md`. Cannot import the adapter — a test enforces it. |

---

## Run it

Requires Node 20+, pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env          # GROQ_API_KEY only if you want --live; replay needs nothing
pnpm db:up                    # Postgres 16 on port 5433
pnpm db:migrate && pnpm db:generate
pnpm api:dev                  # API on :3000
pnpm seed                     # 100 disputes, through the capture endpoint
pnpm ui:dev                   # review queue on :5173
```

Then, with no database and no API key at all:

```bash
pnpm eval                     # the full batch over both sets → eval/results.md
pnpm abstentions              # the decomposition, gate only
pnpm test                     # 233 tests, plus 5 that run only with a database
```

`pnpm eval` and `pnpm abstentions` are pure: seeded corpus in, replayed model
responses in, numbers out. A stranger clones this and gets the same table.

### Reproducibility, stated plainly

Every model response is recorded under a SHA-256 of the request — provider,
model, prompt id, prompt version, temperature, token budget, and the exact
prompt text. Eval runs replay from the committed fixture; `--live` re-records.
**A replay miss throws.** It never falls back to a live call, because the
failure mode of a stale fixture must be a stopped run and not a quietly
different number.

This makes gate decisions, precision, recall and false-positive cost
byte-reproducible. It does **not** make live model output reproducible, and
nothing here claims it does.

---

## Documents

| File | What it holds |
| --- | --- |
| [`eval/results.md`](eval/results.md) | The batch report. Generated, not written. |
| [`EVAL.md`](EVAL.md) | Corpus design, the two-generator holdout, distribution grounding, and eleven known weaknesses stated before anyone has to ask. |
| [`DECISIONS.md`](DECISIONS.md) | Every non-obvious choice: what, why, what was rejected. 35 entries. |
| [`FAILURES.md`](FAILURES.md) | What broke, how it was diagnosed, what the fix was. Logged the same session, never backfilled. 16 entries. |
| [`TASKS.md`](TASKS.md) | The build loop, including what was cut and why. |

Built solo by Abdul Wasih for the Razorpay AI Buildathon, Track 2.
