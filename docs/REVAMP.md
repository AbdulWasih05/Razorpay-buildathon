# Praman | Agentic Dispute Defense — revamp tracker

> This is the live scope file and replaces TASKS.md. Work the phases in order.
> **Every session:** tick checkboxes, update **Status**, and add a **Session log** line before ending. Commit the tracker update with the work it describes.
> Commits use Conventional Commits, have no co-author trailers, are made only on explicit approval, and are never backdated.
> When a task is done, add a 2–3 line *what to understand here* note under it.

## Status

| | |
|---|---|
| **Current phase** | Phase 1 done except the repo rename (user action). Next is Phase 2 |
| **Last completed** | Phase 1 trimmed de-brand: 290 tests pass (7 skipped, DB), lint and typecheck clean, UI builds (2026-09-15) |
| **Open blocker** | Stripe test-mode account not created yet; it gates how much of Phase 6 is live. The repo rename is the user's to run |
| **Next action** | Push the CI fix plus F-031 and confirm the first green CI run and keep-warm run. The user renames the repo. Start Phase 2: Docker + LLM telemetry |

## Context

Praman was built for the Razorpay AI Buildathon (Sep 2026) and wasn't shortlisted. It is now a standalone portfolio project aimed at **backend/platform** and **AI/LLM engineering** roles.

**Kept as-is:**
- Capture-time evidence
- The deterministic contest/abstain gate
- The bounded LLM
- The one-door human-approved submit
- Record/replay evals with an out-of-distribution holdout

**Gaps being closed:**
- No real inbound integration
- Only one provider
- No auth, and a race in approve
- No one-command run
- No LLM telemetry
- An eval with a single model and no regression gate

**Decisions**
- **Phase order:** `0 → 1 → 2 (Docker+telemetry) → 3 (eval gate+matrix) → 4 (auth) → 5 (provider refactor) → 6 (Stripe) → 7 (sweep+docs) → 8 (resume deliverables)`. Stopping after any phase still leaves a defensible project.
- **Event trimmed, not erased.**
  - Git history stays as-is.
  - Event framing comes off the surfaces reviewers read.
  - The case study keeps one provenance line.
  - Internal comments are left alone.
- **DECISIONS.md, FAILURES.md and TASKS.md get deleted in Phase 1.**
  - Citations a user can see are fixed at deletion.
  - Citations in comments get cleaned when that file is next touched (Phases 5–7).
  - `docs/CASE_STUDY.md` keeps the most-cited ids.
- **Honest scope wording:** two dispute-API integrations (Razorpay, Stripe), one agentic protocol modelled (UPI Reserve Pay / UAP), and a capture schema whose `protocol` field is open.
  - Stripe card disputes are not agentic.
  - Supporting several providers is never offered as evidence of supporting several protocols.
- **Matrix wording:** it compares *model families* hosted on Groq, and the model list is pinned in a committed file.
- **Estimate:** 25–30 working days.
- **Repo:** rename to `praman-agentic-dispute-defense`.

## Invariants every phase keeps (tripwires)

- **Byte-identical report.** `eval/harness.test.ts` requires the replayed report to match `eval/results.md` byte for byte, so a refactor must not move a metric.
  - The replay key is SHA-256 of `[provider, model, promptId, promptVersion, temperature, maxOutputTokens, system, user]` (`packages/llm/src/cache.ts:45-61`). The response is not part of the key.
  - Prompt text, prompt-input serialization and `formatRupees` output must stay byte-stable. If they change, re-record deliberately and say so in the commit.
- **Eval never touches the adapter.** `packages/adapter/src/adapter.test.ts` enforces this for `eval/**`. Extend its name regex whenever a new client or factory is added.
- **Holdout guards stay green:** the `eval/holdout-guard.test.ts` allowlists and `assertNotHoldoutFamily`.
- **No `%` or `₹` in `Landing.tsx` source**, per `apps/ui/src/router.test.ts`.
- **Boundary lint:** `packages/core` has zero LLM imports.

---

## Phase 0 — Baseline, hygiene, Stripe access check (~1 day)

- [x] **Create the progress tracker:** this file, a pointer in CLAUDE.md §5, and a project memory entry.
  - *What to understand here:* this file is the single source of truth for scope and progress. A fresh session reads Status first and ends by updating it.
- [x] **Decide the uncommitted fixture.**
  1. Run `pnpm lint && pnpm typecheck && pnpm test`.
  2. Check whether the uncommitted `packages/llm/fixtures/assembly.json` (+91 recordings) is needed for the byte-identical report.
  3. If it is, commit it on its own.
  - *Result:* **not needed.** With the committed fixture, `eval/harness.test.ts` (byte-identical report) and `eval/assembly-replay.test.ts` pass 17/17. The +91 uncommitted entries were unused recordings and were discarded (user decision).
  - *Baseline:* typecheck passes; 288 tests pass, 7 skipped (DB-gated). `pnpm lint` fails only on the untracked `scripts/build-og.mjs` (see the OG card item in Phase 1).
- [x] **Fix `.github/workflows/keep-warm.yml`.**
  - Replace the placeholder URL with `https://praman-zif9.onrender.com`.
  - Remove the placeholder guard and the SUBMISSION/TASKS error text.
  - *What to understand here:* the guard made every scheduled run fail on purpose until the URL was filled in. Nobody filled it in, so the instance was never actually kept warm.
- [x] **Node 22 everywhere:** `.node-version`, `engines`, Render `NODE_VERSION`, README and CLAUDE.md (CI already on 22), later Docker. *(Plan said 20; corrected — three tests import `globSync` from `node:fs`, which is Node 22+, and Node 20 reached end-of-life in April 2026.)*
  - *What to understand here:* CI already ran 22, but Render and `engines` said 20. The tests only pass on 22, so production ran a Node version CI never tested. Render picks up `NODE_VERSION` 22 on the next deploy, and that deploy has not been verified yet.
- [x] **Make CI actually run** *(not in the plan; found after the first push)*. All 8 CI runs since 2026-09-03 failed at `pnpm/action-setup`, because the workflow's `version: 10` conflicts with `packageManager` in package.json. Lint and tests had never run on GitHub. Keep-warm failed all 75 runs on its placeholder guard. The version input is now removed, and the incident is logged as F-031.
  - *What to understand here:* a pipeline nobody looks at gives no signal. Local `pnpm test` passing said nothing about CI. The fix is only verified once a push shows green on `gh run list`.
- [ ] **Confirm Stripe test-mode access (user action).** Check each of these and record the results here:
  - An account can be created from India.
  - Test mode works.
  - A PaymentIntent with the dispute test card creates a dispute.
  - `stripe listen` forwards a signed `charge.dispute.created`.

  **Gate:** if access is blocked, Phase 6 becomes fixtures and contract tests only, and the README and resume make no live Stripe claim.

## Phase 1 — Trimmed de-brand (~0.5–1 day)

- [x] **Delete** `razorpay-buildathon-gameplan.md`, `SUBMISSION.md` and `video/`.
- [x] **README.md**
  - Title: "Praman | Agentic Dispute Defense". The first line stays the live link.
  - Remove the "Track 2 bar mapping" section, the footer (line 280) and "The rubric asks for…" (line 138).
  - Rewrite the "last day" paragraphs without the event wording.
  - Fix stale doc counts.
  - Rewrite the thesis using the honest scope wording.
  - *Also done:*
    - The D-035/D-036 citations were replaced with the reasoning they stood for.
    - The test count was corrected to 290 plus 7 DB-gated tests; it had said 233 plus 5.
    - The EVAL.md weakness count was corrected to thirteen; it had said eleven.
    - The thesis names only what is modelled today. No Stripe claim appears before Phase 6 exists.
- [x] **EVAL.md**
  - Remove "a judge" (184), "before submission" (105) and the "last day" wording.
  - Fix the dangling D-006 citation (EVAL.md:158, `packages/simulator/src/configs.ts:17`).
  - *Also done:*
    - All task ids (P1.1, P4.0 and so on) were removed.
    - `DECISIONS.md D-`/`FAILURES.md F-` became bare ids, with a line near the top pointing to the case study.
    - The D-006 sentence was removed, because that entry never existed. The same citation in `configs.ts:17` is a comment and was left for Phase 7.
- [x] **`apps/ui/src/Landing.tsx`**
  - The colophon `Submission` row (line 163) is replaced; see the deviation note below.
  - Remove the footer (line 506).
  - Section tags become "Trust" and "Boundary". *(The Boundary tag reads "The boundary", to match the section rail.)*
  - The model name (line 385) comes from the results.md header.
  - *Deviation:* the colophon row became `Scope`, not `Stack`. It answers "what is this" in the first fifteen seconds, which a stack list does not.
  - *What to understand here:*
    - `modelOfRecord()` in `Report.tsx` reads the model name out of the report's header line, so the name now has one source.
    - The report is fetched once through `loadReport()` and shared by the colophon and the Measured section.
    - `report.test.ts` checks that the parser returns the real model and returns null rather than guessing.
- [x] **OG card and favicons**
  - Remove the event text from `scripts/build-og.mjs:207`, then run `pnpm build:og`.
  - Commit the favicons, `og.png`, the `index.html` meta tags and the `build:og` script.
  - `scripts/build-og.mjs` fails `pnpm lint` today with 16 errors: no Node globals are configured for `.mjs`, and there are three unused variables. Fix them before committing it, or CI goes red.
  - *Result:*
    - `eslint.config.js` gained a `**/*.mjs` block that declares the Node globals the script uses.
    - Four unused bindings were removed: `ABSTENTION`, `abstention`, `mark` and `child`.
    - `og.png` and the favicons were regenerated. The card's lede now reads "Dispute defense for agent-initiated payments."
- [x] **`docs/CASE_STUDY.md`**
  - Sections: problem, architecture, key decisions, key incidents, eval summary, what is not claimed.
  - Provenance line: "Originally built for the Razorpay AI Buildathon (Sep 2026)."
  - Keep these ids:
    - Decisions: D-005, D-007, D-011, D-019, D-021, D-023, D-025, D-026, D-029, D-030, D-031, D-034, D-043
    - Incidents: F-011, F-013, F-014, F-015, F-024, F-028, F-029, F-030
  - *Deviation:* the case study keeps **every id still cited** by README, EVAL.md, results.md and CLAUDE.md: 19 decisions and 11 incidents. The plan had 13 and 8. Keeping them all was cheaper and more honest than rewriting about 30 citations in docs people read.
  - *What to understand here:* an id is kept exactly when a surviving document cites it. The full originals are in git history before 2026-09-15.
- [x] **Delete `DECISIONS.md`, `FAILURES.md` and `TASKS.md`.** First fix every citation a user can see:
  - `packages/core/src/domain/rubric.ts:155` ("See DECISIONS.md D-026", rendered in the console).
  - The `eval/score.ts` literals at lines 232, 250, 372, 401, 425, 481, 483-484, 520 and 577. Then regenerate `eval/results.md` in replay mode; the diff must be text only.
  - `eval/run.ts:46` and `scripts/abstentions.ts:67,74`.
  - `packages/core/src/fixtures/razorpay-test-payments.json:6`.
  - README links: line 3 and the Documents table.
  - *Result:*
    - `results.md` changed by exactly 2 text lines, with no metric moved.
    - The rubric string does reach the letter prompt (`assemble.ts:129`). The replay tests still passed, because no dispute the gate clears is missing that artifact.
    - `run.ts` and `abstentions.ts` were left alone, since they cite ids the case study keeps.
    - Also fixed: the comments in `render.yaml:1` and `ci.yml:47`.
- [x] **`CLAUDE.md`**
  - Drop the §2 rubric and the event lines in §1, §3.4, §5 and §6.
  - Keep hard rules 1–7.
  - Rule 1 becomes: each provider's live docs are the authority for that provider.
  - *Result:* §2 became a non-event "what good means" list. Decisions and incidents are now recorded in the case study, and the old §6 Track 2 wording is gone.
- [ ] **Repo rename (user runs this):** `gh repo rename praman-agentic-dispute-defense`, then update the remote and README links.

## Phase 2 — Docker + LLM telemetry (~3 days)

- [ ] **Check the replay hash on a single fixture first.**
  1. Add `usage/latencyMs/attempts` to one entry in a copy of the fixture.
  2. Confirm the loader accepts entries both with and without those fields.
  3. Confirm the keys are unchanged, and that `results.md` and the `assembly-replay.test.ts` snapshot stay byte-identical.

  Only then change all entries.
- [ ] **Docker**
  - A multi-stage `Dockerfile` on `node:22-slim`: pnpm install, prisma generate, vite build, run.
  - `docker-compose.yml` runs app and postgres with `SEED_ON_BOOT`, replay mode and no keys.
  - A plain `docker compose up` gives a working console at `localhost:3000`.
  - Optionally, switch Render to the Docker runtime.
- [ ] **Structured logs:** Fastify `genReqId`, a request id on every log line, and one pino line per pipeline stage.
- [ ] **Telemetry on `ModelResponse`:** `usage {inputTokens, outputTokens}`, `latencyMs` and `attempts`.
  - Stored in the fixture at record time and read back on replay; never measured during replay.
  - Existing qwen entries have `usage: null`, shown as "not recorded".
- [ ] **Fix dropped `attempts`:** `packages/llm/src/client.ts:157` drops it, which contradicts `provider.ts:64`.
- [ ] **LLM audit rows** record provider, model, promptId, promptVersion, attempts, usage and latencyMs.
- [ ] **Cost:** commit `packages/llm/src/pricing.ts` with its source URL and date. Cost is computed in `eval/score.ts`.
- [ ] **Console:** a per-dispute telemetry panel tagged `llm`.

## Phase 3 — CI eval gate + multi-model matrix (~5 days)

- [ ] **`eval/results.json`** next to the canonical `results.md`: `SetMetrics` for dev and holdout, the model, prompt versions and usage totals.
- [ ] **`eval/baseline.json`** stores counts, not ratios:
  - tp/fp/fn/tn and ambiguous-contested for each set
  - FP cost in subunits
  - assembly failures
  - each prompt's `{version, sha256}`
- [ ] **`eval/gate.test.ts`** runs in the CI `verify` job.
  - Fails if FP or FP cost rises, TP drops, assembly failures rise, or a prompt's hash changes without a version bump.
  - `pnpm eval --write-baseline` updates the baseline deliberately.
  - The result goes to `$GITHUB_STEP_SUMMARY`.
- [ ] **Negative tests:** a tampered baseline fails, and a prompt edit without a version bump fails.
- [ ] **Pin the models in `eval/matrix.config.json`.**
  - 3–4 model families, chosen once from Groq's catalog; record the date and ids.
  - No `gpt-oss`, because it wrote the holdout.
  - Nothing reads `/models` at runtime.
  - Document that replay survives Groq retiring a model; only live re-recording would fail.
- [ ] **Per-model fixtures** at `packages/llm/fixtures/assembly/<provider>__<slug>.json`. `buildClient` (`eval/harness.ts:314`) takes `{provider, model}`.
- [ ] **Decouple the holdout language replay from `GROQ_MODEL`** (`eval/harness.ts:139`) by reading the model from `holdout.json`.
- [ ] **Harden `assertNotHoldoutFamily`:** match the family as a substring and run it on every provider branch.
- [ ] **`pnpm eval --matrix`** writes `eval/matrix/<slug>.{json,md}` and `eval/matrix.md`.
  - One row per **model family (Groq-hosted)**: precision, recall, abstention, FP cost, drafter vetoes, tokens, p50/p95 latency (recorded), cost.
  - The qwen re-sample is reported as run-to-run variance; the model of record stays the headline (D-023).
  - Every report carries the FP=0 caveat.
  - Replays in CI with no secrets.

## Phase 4 — Safe approve + reviewer auth (~2–3 days)

- [ ] **Atomic approve claim.**
  - `prisma.dispute.updateMany({where:{id, state:'drafted'}, …})` inside a transaction; a count other than 1 returns 409.
  - Test with concurrent `app.inject` calls: exactly one 200, one 409, and one adapter call.
  - Write it up as an incident in the case study.
- [ ] **Auth**
  - Prisma models `Reviewer {handle, passwordHash}` and `Session {id, reviewerId, expiresAt}`.
  - scrypt via `node:crypto`; httpOnly signed cookie via `@fastify/cookie`.
  - Routes: `POST /auth/login|logout` and `GET /auth/me`.
- [ ] **Approve takes `approvedBy` from the session** (`human:<handle>`).
  - `ApprovalToken` remains the only way to mint an approval.
  - Remove `REVIEWERS` (`apps/ui/src/App.tsx:42`) and add a login form.
  - Seed a demo reviewer whose credentials appear on the landing page; rate-limit login.
- [ ] **Tests:** no session gets 401, an expired session gets 401, and the audit actor equals the session reviewer.

## Phase 5 — Provider abstraction, Razorpay only, no behaviour change (~5 days)

- [ ] **Prisma migration (renames only)**
  - Dispute:
    - add `provider`
    - rename `razorpayDisputeId` → `providerDisputeId` and `razorpayPaymentId` → `providerPaymentId`
    - add `@@unique([provider, providerDisputeId])`, `reasonKey`, and a nullable `network`
    - drop the `currency` default
    - make the corpus columns nullable
  - Payment: the same renames, plus `provider`.
- [ ] **Move Razorpay code into `packages/core/src/providers/razorpay/`:** `schema/*`, `reason-codes.ts` and the `ARTIFACTS` field map. Add `providers/types.ts` with `NormalizedDispute`, `ProviderFieldMap` and `materialise`.
- [ ] **`mapper.ts`:** group assignments by neutral `EvidenceArtifact`. Each provider materialises its own payload, and Razorpay's output stays identical.
- [ ] **Network and reason come from the dispute.**
  - `apps/api/src/review.ts:100` reads `dispute.reasonKey/network`.
  - `packages/core/src/capture/ingest.ts:120` validates ids per provider.
- [ ] **Rubric keys** become provider+reason (`upi:1064`).
- [ ] **`formatMoney(amountMinor, currency)`:** its INR path stays byte-identical to `formatRupees`, pinned by a test.
- [ ] **Adapter**
  - `prepare()` keeps only the token and dispute-id checks.
  - Each client builds its own payload.
  - `SubmissionResult` becomes neutral.
  - An `AdapterRegistry` keyed by `dispute.provider` is injected via `BuildServerOptions`.
- [ ] **Callers**
  - `/seed/dispute` goes through the Razorpay normaliser.
  - `CaptureClient`, `demo.ts` and the simulator use the renamed fields.
  - Envelopes are unchanged.

## Phase 6 — Real webhooks + Stripe (~7–8 days, scope set by the Phase 0 gate)

- [ ] **`apps/api/src/webhooks.ts`:** an encapsulated plugin with a scoped buffer content-type parser. It must work with the `/api/` rewrite.
- [ ] **Hand-rolled signature checks** in `packages/core/src/providers/*/signature.ts`, compared with `timingSafeEqual`.
  - Razorpay: hex HMAC-SHA256 of the raw body.
  - Stripe: `t=…,v1=…` over `` `${t}.${rawBody}` ``, with a 5-minute tolerance, checking every `v1`.
  - The `stripe` package is a devDependency only, used to generate test headers.
- [ ] **Idempotent events:** `WebhookEvent {provider, eventId, type, payloadJson, receivedAt, processedAt}` with `@@unique([provider, eventId])`.
  - Flow: verify (bad → 401) → insert (duplicate → 200 `{duplicate:true}`, nothing else happens) → normalise → upsert as `received`.
  - Processing stays on `/review/run`. There is no queue; the case study explains why.
- [ ] **Stripe provider**
  - Verify everything against the live docs first.
  - Zod schemas, a normaliser, and a field map to `evidence[...]`.
  - Rubric covers fraudulent, product_not_received, product_unacceptable, subscription_canceled, credit_not_processed and duplicate. Any other reason abstains with `unsupported_reason`.
  - Contract tests against the docs' example payloads, with PROVENANCE.
  - The letter cap stays at 1000.
- [ ] **`StripeClient`**
  - Plain `fetch`; only `sk_test_` keys are accepted.
  - Upload files with `purpose=dispute_evidence`, then `POST /v1/disputes/:id` with `submit=true`.
  - Approve stays the only path that writes anything to the provider.
- [ ] **Simulator** emits a few Stripe demo disputes. The eval corpus is untouched.
- [ ] **Real evidence upload:** `apps/api/src/review.ts:254` currently uploads a placeholder (`evidence:${ref}`); send the real artifact content.
- [ ] **`scripts/stripe-live-e2e.ts`** (only if Phase 0 passed; run manually, never in CI).
  - Flow: test card → evidence-pack → `stripe listen` → pipeline → approve → submit.
  - Record the outcome in the case study as `simulated: false, test-mode`.

## Phase 7 — Residual sweep + docs + fact-check (~2 days)

- [ ] **Remove leftover event wording** from surfaces users see.
- [ ] **Dangling citations:** `rg "DECISIONS\.md|FAILURES\.md|TASKS\.md|SUBMISSION\.md"` over the source. Replace each hit with an inline reason or a case-study id.
- [ ] **README**
  - Matrix table labelled "model families (Groq-hosted)".
  - A providers section using the honest wording.
  - Webhook, auth and Docker architecture.
  - "Run it" becomes `docker compose up`.
- [ ] **Case study:** add the new decisions and incidents (provider seam, webhook idempotency, approve race, telemetry stored in fixtures, gate design).
- [ ] **Fact-check every claim:** counts, test totals, and which providers are live vs fixture-only.
- [ ] **Render redeploy** plus a smoke test: `/health`, both providers' demo disputes, login, approve. Keep-warm is green.

## Phase 8 — Resume deliverables (~1 day)

- [ ] **Resume bullets:** two variants (backend-leaning and AI-leaning), 3 bullets each. Every number traces to a committed file.
- [ ] **Portfolio entry:** a one-liner, a 3-sentence summary, and a longer paragraph with links to the deploy, repo and case study.
- [ ] **README opening paragraph** for a reviewer skimming for 30 seconds: what it is, why it matters, what is real vs simulated, and the headline numbers.
- [ ] **Store the text** in `docs/resume.md`.

---

## Verification

**Every phase**
- `pnpm lint && pnpm typecheck && pnpm test` pass.
- The CI integration job passes.
- `eval/results.md` stays byte-identical unless report text is changed on purpose. In that case, regenerate in replay mode; the diff must be text only.

**Per phase**
- **Phase 1:** no event wording in the README, Landing page, EVAL or OG card. The landing page and console render.
- **Phase 2:**
  - The single-fixture hash check runs first.
  - A fresh clone plus `docker compose up` serves the console, and `/health` reports `assemblyMode: replay`.
  - Audit rows carry telemetry.
- **Phase 3:**
  - The gate fails on a tampered baseline and on an unbumped prompt edit.
  - Two matrix replays are byte-identical.
  - `gpt-oss` cannot be configured on any path.
- **Phase 4:** concurrent approvals submit once; approve without a session gets 401.
- **Phase 5:** `results.md` stays byte-identical, and the Razorpay contract tests are unchanged and green.
- **Phase 6:**
  - Signed-header tests pass for both providers.
  - A bad signature gets 401, and a stale Stripe timestamp is rejected.
  - A duplicate event produces one row.
  - A Stripe demo dispute reaches drafted.
  - The live e2e passes, if Phase 0 passed.
- **Phases 7/8:** the Render smoke test passes, keep-warm is green, and every resume number traces to a committed file.

## Session log

- 2026-09-15: plan approved (rev 2, after review). Created the tracker. Phase 0 started, and keep-warm URL fixed.
- 2026-09-15: Phase 0 hygiene done except the Stripe check (user action). Uncommitted `assembly.json` fixture is not needed. Node aligned to 22, not 20: `globSync` needs 22, and 20 is end-of-life. Committed locally, not pushed.
- 2026-09-15: Phase 1 done except the repo rename (user action). The case study keeps all 30 cited ids. `results.md` changed by 2 text lines and no metric. 290 tests pass. Committed as two commits (5/day cap) and pushed.
- 2026-09-15: after pushing, found that CI had never passed: pnpm version pinned twice (F-031). Fixed in `ci.yml`. Render redeploy verified: restarted 09:53Z in replay mode, and the served bundle has no event text.
