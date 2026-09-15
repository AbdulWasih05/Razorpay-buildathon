# Praman | Agentic Dispute Defense

**Live demo: https://praman-zif9.onrender.com/** · [Case study](docs/CASE_STUDY.md) · [EVAL](EVAL.md) · [eval/results.md](eval/results.md)

The demo is hosted on a free tier, so it sleeps after 15 minutes idle. A scheduled ping keeps it awake; if a ping was missed, the first request takes about a minute.

Praman is a **defense-only** dispute evidence responder for agent-initiated payments. For each dispute it:

1. reads the dispute in Razorpay's documented Disputes API schema;
2. assembles the evidence the merchant actually holds;
3. decides whether to contest or abstain, using a deterministic sufficiency gate;
4. drafts a contest mapped to Razorpay's typed evidence fields;
5. submits only when a human approves that specific dispute.

It covers ordinary e-commerce disputes and one agentic protocol: India's UPI Reserve Pay. The capture schema's `protocol` field is open to other protocols, but none is modelled today.

**The thesis: evidence about an agent's payment has to be captured when the payment happens, because by dispute time it is gone.**

That evidence is:
- the agent identifier;
- the Reserve Pay mandate reference;
- the protocol metadata;
- the conversation trace.

All of it lives with the agent platform or the third-party UPI app (TPAP), not with the merchant. When a dispute arrives weeks or months later, there is nothing left to retrieve.

So the transaction store *is* the capture layer. `POST /evidence-pack` implements it as a real endpoint, not a box on a diagram, and all 100 seeded disputes were captured through it.

Razorpay's own announcement shows the gap. [Razorpay and NPCI shipped agentic payments on UPI Reserve Pay](https://razorpay.com/blog/agentic-payments-and-npci/) in February 2026: "users to give a one-time, consent-based authorization by setting spending limits for a merchant". That post is entirely about the consent going in. It says nothing about disputes, chargebacks, evidence, or what a merchant can do when one of those payments is challenged later. Praman handles that other end.

UPI Reserve Pay and UPI Circle are live today. NPCI's Unified Agent Protocol is announced but not shipped (D-037).

---

## Results

The eval uses two sets:
- a dev corpus of 100 disputes;
- a held-out set of 30 that is out-of-distribution **by construction**. It has a different seed, a different scenario mix and different personas. Its conversation text was also written by a different lab's model than the one that reads it here.

| metric                                   | dev (100)     | held-out OOD (30) | shift  |
| ---------------------------------------- | ------------- | ----------------- | ------ |
| recall on winnable disputes              | 31/38 = 81.6% | 7/9 = 77.8%       | −3.8%  |
| precision on contests                    | 100.0%        | 100.0%            | 0.0%   |
| false positives (contested & unwinnable) | 0/52          | 0/20              | 0      |
| false-positive cost                      | ₹0            | ₹0                | ₹0     |
| abstention rate                          | 69.0%         | 73.3%             | +4.3%  |
| assembly failures                        | 0             | 0                 | —      |

**Model of record: `qwen/qwen3.8-27b` via Groq.**
- The intended provider was Anthropic, but no `ANTHROPIC_API_KEY` exists in this environment, so every committed recording is Qwen's.
- It is deliberately *not* `openai/gpt-oss-120b`. That model wrote the held-out corpus, so using it would have contaminated the OOD delta.
- The model is frozen (D-021, D-023). It is named here rather than in a footnote because being honest about where AI is not used includes being honest about *which* AI is.

**Reproduce it:** `pnpm eval` runs in replay mode, with no network and no API key. Two runs produce a byte-identical `eval/results.md`, and a test regenerates the report and diffs it against the committed one.

### Read the abstention rate correctly

69% abstention is the number most likely to be misread. A single percentage can't tell a gate doing its job from a gate too timid to act, so here is what it hides:

| why it abstained                                                 | dev   | held-out |
| ---------------------------------------------------------------- | ----- | -------- |
| correct — the corpus says the dispute is unwinnable              | 52    | 20       |
| conservative — the corpus says it is genuinely ambiguous         | 10    | 0        |
| **recall lost — a required artifact we do not hold, named**      | **7** | **2**    |
| **recall lost — the drafter declined a case with full coverage** | **0** | **0**    |
| **recall lost — the gate misjudged evidence it already held**    | **0** | **0**    |

**Dev set.**
- Every winnable dispute we failed to contest traces to a specific artifact the capture layer does not hold. **None** traces to the gate or the drafter misreading evidence they already had.
- The seven dev losses are named by dispute id in [`eval/results.md`](eval/results.md).
- Five of them come from one known gap, `duplicate_payment_analysis`. Closing it needs a second payment slot in the capture schema, which means reseeding the corpus and re-recording every fixture, so it was frozen unfinished at a cutoff set in advance (D-033).

**Held-out set.** It moved in both directions during the final fixes, and both moves are logged:

1. A fix to rubric provenance (which evidence Razorpay's docs publish for each reason code) led the drafter to veto one gate-cleared, full-coverage dispute. Recall went 7/9 → 6/9 and abstention 73.3% → 76.7% (F-025).
2. A later fix to how money is formatted before a model reads it brought that case back: recall 6/9 → 7/9, with the OOD shift narrowing from −14.9% to −3.8% (F-029).

Dev did not move on any metric either time, and every gate decision stayed identical.

**Why fix 2 is not holdout-tuning.** A prompt change that improves the holdout is exactly what holdout-tuning looks like, so the reasons are laid out in F-029 where they can be checked:
- the defect was found on a *dev* dispute, and the fix was written before any held-out number was regenerated or looked at;
- the fix is a units conversion at a boundary, and adds no instruction, example or evidence;
- one code path applied it to both sets;
- a change tuned to a holdout would be expected to move the set it was tuned on, and this one did not.

### What these numbers do not claim

- **The corpus is self-generated.** This is the central weakness. It is mitigated, not eliminated. The metric is *decision quality under our own labelling*, and the held-out delta is the evidence that the system is not just tuned to its own generator.
- **Ground truth is our judgement encoded as rules.** "Winnable" means "defensible on the evidence we hold", not "would have been won".
- **Zero false positives is partly a statement about the corpus.** Most unwinnable dev cases are unwinnable by arithmetic (amount over the mandate cap, mandate expired), not by judgement. What really tests the gate is the ambiguous row and the held-out set.
- **Live model output is not reproducible, and nothing here claims it is.** The numbers are byte-reproducible because responses are replayed from committed recordings keyed by request hash, not because a model is deterministic.
- **No live Razorpay call is made anywhere.**
  - Payment ids are synthetic and shape-valid, and marked as such: `pay_SIMzSR4DUVsdOB`, `disp_SIM…`, `order_SIM…`. Each is the prefix plus exactly 14 base62 characters, so no schema check is weakened.
  - The Disputes API exposes only fetch, accept and contest. A dispute originates with the customer or the issuing bank, so it cannot be created in test mode, with or without an account.
  - The contest path is built and verified against the documented request examples, not against a live dispute (D-032).

---

## Where we deliberately did NOT use AI

The rule: **a money action must never depend on a stochastic step, and an eval must be reproducible.** Everything on the money path is deterministic code.

| Deliberately NOT AI | Why |
| --- | --- |
| Schema and field mapping | Razorpay's docs fully specify it. A model could only add variance to something with one correct answer. It is encoded as Zod schemas, with contract tests against the doc examples verbatim. |
| The sufficiency gate and the contest/abstain decision | This decides whether money is contested. A reviewer can read a threshold; they cannot read a model's mind. |
| Metrics computation | An eval a model helps score is not an eval. |
| The submission path | There is one door: the human approve action in the review UI. Nothing stochastic gets to press it. |
| Mandate validity, limit and amount checks | These are arithmetic and interval comparisons. A model here would be worse and harder to explain. |
| **Any model influence that could ADD a contest, raise an amount, or submit** | This row matters because the drafter changed the outcome on 2 of 100 dev disputes, both labelled ambiguous by the corpus. The drafter holds a **veto toward safety only**: it may withhold a contest the gate approved, but it can never create one the gate declined, and a declined dispute makes no model call at all. It cannot touch the amount, choose an evidence field, attach a document or reach the adapter. Every path it can take leads to *less* money being claimed, never more, and a test asserts the pipeline never contests more than the gate cleared. A component whose worst case is excess caution is not a stochastic step a money action depends on (D-025). |
| An agentic loop anywhere in Praman's runtime | The three jobs given to a model are single-shot text transforms: no decision to delegate, no tool to call, no state to carry. A loop would add nondeterminism and a hard replay problem to buy capability we do not want. **Praman is agentic in its domain, not in its implementation** (D-019). |

**This repository was built with Claude Code, which is built on the Claude Agent SDK.** It sits in the build loop, not on the money path. No agent loop runs inside Praman, and the deployed product makes single-shot structured calls behind one interface.

**Where a model does earn its place.** These are tasks with natural language in, natural language out, and no single correct answer:
- conversation-trace summarisation;
- explanation-letter drafting;
- ambiguity flagging.

All three sit behind one interface in `packages/llm`, and all three are recorded and replayed. Each has four failure modes: error, timeout, refusal and schema-validation failure. Every one routes to `abstain("assembly failure, manual review required")` with an audit entry, never to a silent retry onto the money path.

**Enforced, not promised.** `eslint.config.js` forbids `packages/core`, the deterministic domain, from importing `@praman/llm` or any model SDK. Crossing that boundary fails the build.

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

The order is the argument:
1. Deterministic code collects the evidence and decides.
2. The model is asked only to read language and write language.
3. Deterministic code assembles the payload.

**A dispute the gate declines never reaches a model at all.** That was 67 of 100 on the dev set, so no model output can have influenced those outcomes.

| Package | What it owns |
| --- | --- |
| `packages/core` | The domain: Razorpay schemas, evidence collector, sufficiency gate, field mapper. Zero LLM imports, enforced by the linter. |
| `packages/simulator` | A seeded, deterministic corpus generator for both payment types, plus the held-out generator. |
| `packages/llm` | The only door to a model: record/replay, structured outputs, four failure paths. |
| `packages/adapter` | The Disputes API contract, with a simulator client and a real client behind one interface. |
| `apps/api` | Fastify. `POST /evidence-pack` is the capture layer; the review routes run the pipeline. |
| `apps/ui` | The React review console, the overview page and the eval page. |
| `eval/` | The harness, the holdout guard and `results.md`. It cannot import the adapter; a test enforces this. |

---

## Run it

Requires Node 22+, pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env          # GROQ_API_KEY only if you want --live; replay needs nothing
pnpm db:up                    # Postgres 16 on port 5433
pnpm db:migrate && pnpm db:generate
pnpm api:dev                  # API on :3000
pnpm seed                     # 100 disputes, through the capture endpoint
pnpm ui:dev                   # review console on :5173
```

Deploying it takes one file. [`render.yaml`](render.yaml) declares the web service and the database. `pnpm start` applies migrations before booting, and `SEED_ON_BOOT` fills an empty store through the capture endpoint. The UI is served by the API process, so there is one origin and no CORS allowlist.

These run with no database and no API key:

```bash
pnpm eval                     # the full batch over both sets → eval/results.md
pnpm abstentions              # the abstention breakdown, gate only
pnpm test                     # 290 tests, plus 7 that run only with a database
```

`pnpm eval` and `pnpm abstentions` are pure: seeded corpus in, replayed model responses in, numbers out. Anyone who clones the repo gets the same table.

### Reproducibility, stated plainly

- Every model response is recorded under a SHA-256 of the request: provider, model, prompt id, prompt version, temperature, token budget and the exact prompt text.
- Eval runs replay from the committed fixture. `--live` re-records.
- **A replay miss throws.** It never falls back to a live call, because a stale fixture should stop the run rather than quietly produce a different number.

This makes gate decisions, precision, recall and false-positive cost byte-reproducible. It does **not** make live model output reproducible, and nothing here claims it does.

---

## Documents

| File | What it holds |
| --- | --- |
| [`eval/results.md`](eval/results.md) | The batch report. Generated, not written. |
| [`EVAL.md`](EVAL.md) | Corpus design, the two-generator holdout, how the distribution is grounded, and thirteen known weaknesses. |
| [`docs/CASE_STUDY.md`](docs/CASE_STUDY.md) | The problem, the architecture, the decisions that shaped it and the incidents that tested it. The `D-0xx` and `F-0xx` ids cited throughout refer to its entries. |
| [`docs/REVAMP.md`](docs/REVAMP.md) | The roadmap in progress: Docker, LLM telemetry, an eval regression gate, reviewer auth, and a second dispute provider. |
