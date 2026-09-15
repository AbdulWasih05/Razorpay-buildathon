# CLAUDE.md — Praman | Agentic Dispute Defense

> Working instructions for this repository.
> - Decision ids (`D-0xx`) and incident ids (`F-0xx`) refer to entries in `docs/CASE_STUDY.md`.
> - Scope and progress for the current work live in `docs/REVAMP.md`.

## 1. What this project is

Praman is a **defense-only dispute evidence responder for agent-initiated payments**. It handles ordinary e-commerce disputes today. Its differentiated module is agent-initiated payments on India's UPI agentic stack (Reserve Pay mandates, UPI Circle, UAP).

**Core product insight:** agentic evidence has to be **captured at transaction time**. That evidence is the agent identifier, the mandate reference, protocol metadata, and the conversation context. By dispute time the trace is unrecoverable, because it lives with the agent platform or TPAP, not with the merchant. The transaction store IS the capture layer.

**The pipeline:**
1. Ingest dispute events in Razorpay's exact Disputes API schema. That UPI disputes surface in this system was verified, and the doc URL and captured wording are recorded under D-008 — "we verified this" is itself a checkable claim.
2. Assemble evidence from the capture store.
3. Decide contest-vs-abstain through an evidence-sufficiency gate.
4. Draft contests mapped to the provider's typed evidence fields.
5. Submit only through a human-approved, draft-first, deadline-aware flow.

**Schema fidelity is a feature.** Someone who knows the provider's API should recognise it on sight.

## 2. What "good" means here

1. **The problem matters.** Pick things that actually matter to a merchant defending a dispute.
2. **You would trust it.** It runs, it is structured, and the gates, audit logs and determinism are the product, not decoration.
3. **AI judgment.** Use the right tool in the right place, and say where we chose not to use one.
4. **Failure recovery.** Record what broke and what was done about it, honestly and in the same session.

## 3. Hard rules — never violate, never "improve"

1. **Provider schema fidelity.** Dispute entities, evidence fields, contest payloads and error states mirror each provider's documented API exactly. Each provider's live docs are the authority for that provider.
   - The Razorpay summary below is a convenience copy, and it has already been wrong (D-002, D-003). Where it disagrees with the docs, the docs win, the code follows the docs, and THIS FILE gets corrected — never the other way round.
   - **Razorpay, verified against the docs 2026-08-30:**
     - `disp_` ids, `payment_id`, `reason_code`, `respond_by`
     - `status`: `open` / `under_review` / `won` / `lost` / `closed`
     - `phase`, **five values**: `fraud`, `retrieval`, `chargeback`, `pre_arbitration`, `arbitration`
     - evidence fields: `summary`, `shipping_proof`, `billing_proof`, `cancellation_proof`, `customer_communication`, `proof_of_service`, `explanation_letter`, `refund_confirmation`, `access_activity_log`, `refund_cancellation_policy`, `term_and_conditions`, `others`
     - `action: draft|submit`
     - **`summary` ≤1000 chars.** The cap is on `summary`; `explanation_letter` is a list of document ids like every other typed field.
     - Documents API with `purpose: dispute_evidence`
   - When unsure about a field, check https://razorpay.com/docs/api/disputes/. Never invent fields, and never omit documented ones.
   - The same discipline applies to any provider added later, against that provider's own docs.
2. **The submit path has exactly one door.** In the product, the approve action in the review UI is the only path to submit; no other code path may call submit.
   - This includes any write to a provider, such as staging evidence.
   - Eval mode scores gate decisions and draft outputs only, and NEVER touches the submission adapter. A test enforces this.
3. **Defense-only.** Nothing offense-capable, ever.
   - No fraud-generation tooling and no dispute-abuse tooling, not even for testing.
   - The synthetic generator creates *dispute scenarios*, not attack tools.
4. **LLM boundary.**
   - **LLM is used ONLY for:** conversation-trace summarization, explanation-letter drafting, ambiguity flagging.
   - **LLM is NEVER used for:** schema/field mapping, gate thresholds, metrics computation, submission decisions, or anything else on the money path.
   - **Reason** (recorded in `docs/CASE_STUDY.md`): a money action must never depend on a stochastic step, and evals must be reproducible.
   - **Runtime failure policy:** if any LLM step (1) fails or errors, (2) times out, (3) refuses, or (4) returns output that fails schema validation, the dispute is routed to abstain with reason "assembly failure, manual review required". That is logged in the audit trail and never silently retried into the money path.
   - Tests cover all FOUR failure paths.
5. **Eval integrity.**
   - **Corpus generation** is seeded and deterministic. Reason-code distribution is grounded in cited published data where available, with the assumption stated explicitly where not.
   - **The held-out set is out-of-distribution by construction.** It is generated with a different model and a different prompt/persona set than the dev corpus, created at generation time, and NEVER read during feature development. A guard test enforces this.
   - **Reproducibility via record/replay.** `packages/llm` records LLM responses keyed by request hash and commits them as fixtures. Eval runs replay by default; `--live` regenerates. Gate decisions, precision/recall and FP cost are byte-reproducible.
   - **The README states the replay design plainly.** Never claim unqualified byte-reproducibility of live LLM output.
   - **Report ALL metrics, including bad ones:** precision, recall, false-positive cost in ₹, abstention rate, per-case exception reasons, and the **dev-vs-OOD distribution-shift delta**.
   - **No cherry-picking.** If a metric is ugly, it ships ugly.
6. **Honesty taxonomy.** Every claim in README/docs is measured, structural, or scoped.
   - Never claim "first ever". The verified claim is "first for India's UPI agentic stack."
   - Simulated won/lost outcomes are tagged `simulated: true` at the data level and labeled "simulated" wherever rendered. No outcome number appears in the UI or docs without its provenance.
   - Headline metrics are precision/recall against labels and false-positive cost, never simulated wins.
   - "₹ protected" is banned phrasing. Use "₹ at stake in drafted contests" or "₹ in correctly abstained disputes."
   - Supporting several dispute providers is never offered as evidence of supporting several agentic protocols.
7. **Abstention over bluffing.** Insufficient evidence means abstain with a stated reason. A bluffed contest that loses costs fees and time, and that IS the false-positive cost we measure.

## 4. Stack & structure

- **Runtime:** Node 22+, TypeScript strict, pnpm monorepo.
- **API:** Fastify. **DB:** PostgreSQL via Prisma. **UI:** React (Vite), a dense risk-ops console, not a product page.
  - Colour encodes state and is never decoration.
  - Hairlines and background steps, never shadows.
  - Sans for language; mono for identity (ids, amounts, codes, field names, timestamps).
  - No motion. One register, committed (light).
  - Clarity over polish; nothing on this screen exists to look impressive.
  - Every panel is marked `deterministic` or `llm`, and evidence the core computes gets rendered rather than discarded.
- **LLM:** structured outputs and **single-shot calls — deliberately NOT the Claude Agent SDK (D-019)**. Model calls are isolated in `packages/llm` behind one interface.
  - The intended provider is the Anthropic Messages API, used whenever `ANTHROPIC_API_KEY` is set.
  - **No such key exists in this environment, so the committed recordings were produced by `qwen/qwen3.8-27b` via Groq.**
  - **Deliberately NOT `openai/gpt-oss-120b`.** It wrote the held-out corpus and would contaminate the OOD delta (D-021, enforced by `assertNotHoldoutFamily`).
- **Routes:** `/` overview, `/app` review console, `/eval` eval page.
  - Hand-rolled routing, no router dependency. The API SPA fallback serves extensionless GETs.
  - Typefaces are vendored latin-subset woff2 in `apps/ui/src/fonts/` (Inter, JetBrains Mono, both SIL OFL 1.1), self-hosted and never from a CDN.
  - **No number on the landing page is written by hand.** It renders the `Headline` table out of the committed `eval/results.md` verbatim, and a test forbids `%` and `₹` in its source.
- **The demo clock is simulated too (D-043).**
  - Every `respond_by` is a fixed offset from the seeded `CORPUS_EPOCH`, so deadlines are read against `CORPUS_NOW`, never `Date.now()`.
  - `CORPUS_NOW` is served by the API as `/health`'s `simulatedNow` and labelled `clock: simulated` in the console.
  - Reading seeded rows against a real clock measures the corpus's age, not a reviewer's urgency (F-024).
  - **Never move `CORPUS_EPOCH` to fix a date problem.** It is the replay-fixture hash base (D-007).
- **Deploy:** Render, from `render.yaml`: one web service plus one free Postgres.
  - The Fastify process serves the API and the built UI from a single origin, so there is no separate front-end deploy and no CORS allowlist.
  - Free-plan costs are stated in the README's first line, not hidden: 15-minute sleep, ~1-minute cold start, 30-day Postgres expiry.
  - A committed GitHub Actions schedule pings `/health` every five minutes to keep the instance awake. It is best-effort, so the cold-start note stays. **Never upgrade the ping into a promise of uptime.**
- **Layout:**
  - `packages/core`: domain (dispute entities, gate, mapping), with zero LLM imports.
  - `packages/simulator`: seeded corpus generator and webhook emitter.
  - `packages/llm`
  - `packages/adapter`: the Disputes API contract, with a simulator client and a real client behind one interface.
  - `apps/api`: includes the `POST /evidence-pack` capture endpoint. ALL seeding flows through it, never through direct DB writes for evidence packs.
  - `apps/ui`
  - `eval/`: harness, plus `EVAL.md`.
  - Docs: `README.md`, `EVAL.md`, `docs/CASE_STUDY.md`, `docs/REVAMP.md`.

## 5. Working discipline (every session)

- **TDD on core.** The gate, mapping and metrics are test-first. Contract tests pin each provider's schema.
- **Incidents.** When anything breaks — a test, a schema assumption, an LLM behaving badly — record it in `docs/CASE_STUDY.md` under Incidents in the SAME session: what broke, how it was diagnosed, and what the fix or fallback was. Never backfill from memory.
- **Decisions.** Every non-obvious choice gets an entry in `docs/CASE_STUDY.md` under Decisions: what, why, and what was rejected. Keep the README's "Where we deliberately did NOT use AI" section current.
- **Wasih must understand every line.** He has to explain it from first principles, unaided.
  - If a generated solution is clever but opaque, simplify it until it can be explained that way.
  - When completing a task, add a 2–3 line "what to understand here" note under it in `docs/REVAMP.md`.
- **Honest history, at most 5 commits a day.**
  - Work in small increments, then fold same-day commits into at most five before pushing.
  - Folding may only merge **adjacent** same-day commits. Every original message is preserved verbatim inside the folded one, and original author dates are kept.
  - Nothing is reordered, backdated, or rewritten to look like it happened differently.
  - Commit messages state what and why.
- **Scope discipline.** Work `docs/REVAMP.md` phase by phase, top to bottom.
  - Do not add features that aren't in it.
  - Before ending a session, tick completed checkboxes, update its Status block, and add a Session log line.
  - If blocked for more than 30 minutes, record the blocker in its Status block and move to the next task.

## 6. Definition of done (project level)

- The live deploy link is in the first line of the README.
- A plain-text metrics table sits near the top of the README, with dev AND OOD held-out numbers and the shift delta.
- "Where we deliberately did NOT use AI" is a visible README section.
- The project runs locally with one command.
- A stranger can reproduce the seeded eval.
- A batch of 100+ disputes is processed with full metrics and an exception list.
- There is one demoable abstention case.
- Every checkable claim has passed a fact-check.
- README, EVAL.md and `docs/CASE_STUDY.md` are complete and honest.
