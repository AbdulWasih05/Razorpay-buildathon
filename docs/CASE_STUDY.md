# Praman — case study

> I originally built this solo for the Razorpay AI Buildathon in September 2026. It is now maintained as a standalone project, and the ongoing work is tracked in [`REVAMP.md`](REVAMP.md).
>
> `D-0xx` and `F-0xx` ids elsewhere in the repository (code comments, [`EVAL.md`](../EVAL.md), [`eval/results.md`](../eval/results.md)) point to entries in this document. The full original decision and failure logs live in git history, in `DECISIONS.md` and `FAILURES.md` before 2026-09-15.

## The problem

An agent-initiated payment, such as a UPI Reserve Pay mandate charged by an AI agent on a customer's behalf, can be disputed like any other payment. The evidence that would defend it is:

- which agent acted,
- under which mandate,
- over which protocol,
- after what conversation.

That evidence lives with the agent platform or the TPAP, not with the merchant. Weeks later, when the dispute arrives, the merchant has nothing to retrieve.

**The design follows from one claim: agentic evidence has to be captured at transaction time.** Praman's transaction store *is* the capture layer. Everything after that is a defense problem:

1. Read the dispute.
2. Collect what is held.
3. Decide whether a contest is defensible.
4. Draft it in the provider's exact schema.
5. Submit it only when a named human approves.

## Architecture in one pass

```
capture (POST /evidence-pack) → collector → sufficiency gate ──► abstain (no model call)
                                                 │ contest
                                                 ▼
                                  packages/llm: summary, letter, ambiguity flags
                                                 │  (any failure → abstain)
                                                 ▼
                                  field mapper → review console → human approve → adapter
```

**Deterministic code:**
- collects the evidence,
- decides whether to contest,
- assembles the payload.

**The model:**
- reads language and writes language,
- is called only for disputes the gate has already cleared.

The approve action is the only path to submission. The eval harness cannot import the submission adapter, and a test enforces this.

## Decisions

### Schema fidelity

- **D-002: `phase` has five values, not three.** The Razorpay docs list `fraud`, `retrieval`, `chargeback`, `pre_arbitration` and `arbitration`. The project brief named three. The docs win: a dispute arriving in `retrieval` would otherwise fail to parse. Implementing three "for scope" was rejected as schema infidelity chosen for convenience.
- **D-003: the 1000-character cap belongs to `summary`.**
  - `explanation_letter` is a list of document ids, like every other typed evidence field.
  - The drafted letter lives inline in `summary`.
  - An over-length draft abstains rather than being trimmed to fit.
  - The cap is enforced only on what we write, never on what we read.
- **D-008: verified that UPI disputes surface in Razorpay's merchant dispute system.**
  - Source: https://razorpay.com/docs/payments/disputes/submit-evidence/, retrieved 2026-08-30.
  - It has a UPI section grouping reason codes by dispute type (e.g. `1061` Credit Not Processed, `1062` Not As Described, `1064` Not Received, `128` Fraudulent Transaction).
  - It is recorded because "we verified this" is itself a checkable claim.
- **D-032: no Razorpay account; the simulator is the design.**
  - The Disputes API exposes fetch, accept and contest, nothing else. A dispute originates with the customer or the issuing bank, so no real dispute can be made to exist in test mode, with or without credentials.
  - Synthetic ids carry a visible marker (`pay_SIM…`, `disp_SIM…`) and keep the exact prefix-plus-14-base62 shape, so no schema check is weakened.
- **D-037: a fact-check pass over every checkable claim (2026-09-03).**
  - The UPI reason codes and their mapping were re-verified against the live docs.
  - So was the fetch/accept/contest scope.
  - NPCI's Unified Agent Protocol was scoped as announced, not shipped.
  - Claims that could not be verified were cut or scoped, not softened.

### The LLM boundary

- **D-005: the boundary is enforced by the linter, not by discipline.**
  - `eslint.config.js` forbids `packages/core` from importing `@praman/llm` or any model SDK. A failing build is evidence; a README sentence is a claim.
  - An adversarial review later showed that `no-restricted-imports` matches literal specifiers only, so a dynamic `import()` or a relative path into the llm package would pass. Neither existed in the code, but the guarantee had the gap.
  - The fix is `packages/core/src/boundary.test.ts`: a second check on the same boundary that uses a different mechanism, a regex over stripped source text. The two checks therefore don't share a blind spot.
- **D-019: single-shot structured calls, deliberately not the Claude Agent SDK.**
  - Every decision in Praman is on the money path and therefore deterministic, so an agent loop would have nothing to decide.
  - A loop would also turn one replay key per call into a branching trajectory, which breaks byte-reproducible evals.
  - *Praman is agentic in its domain, not in its implementation.*
- **D-021: the assembler runs on a different model family from the one that wrote the holdout.**
  - `openai/gpt-oss-120b` wrote the held-out conversation language. Using it to read that language would have made the OOD delta measure nothing, while everything still ran and looked fine.
  - The drafts use `qwen/qwen3.8-27b` (a different lab), and `assertNotHoldoutFamily` throws if anyone points the assembler back at gpt-oss.
- **D-023: the model of record is chosen before scoring, then frozen.**
  - Every metric is a property of the recordings behind it. Swapping models after the report exists silently invalidates it.
  - Re-recording is allowed only as a single, documented event that names its reason.
- **D-025: the gate runs before the model, and a declined dispute never reaches one.**
  - This is a correction. An early build let the letter drafter decide "the evidence does not support a contest", which let a model make the money decision. Nobody would have noticed, because its judgements were good.
  - Now the drafter holds a **veto toward safety only**. It may withhold a contest the gate cleared, recorded as a disagreement. It can never create one, raise an amount, pick an evidence field, or reach the adapter.

### Evaluation

- **D-007: seed-derived identity is kept separate from server-generated identity.**
  - Prompts may use only seed-derived ids and times.
  - A server cuid or wall-clock timestamp in a prompt would change the request hash on every reseed. Every replay fixture would then miss, and the eval would quietly go live.
- **D-011: ground truth is derived from the generated evidence, never asserted alongside it.**
  - If a label were chosen independently, the corpus could contradict itself, and the eval would measure the generator's mood.
  - Tests assert the agreement. For example, every mandate-breach case really exceeds its cap.
  - F-010 is the one place this rule was broken.
- **D-026: `provenance` and `necessity` are different questions.**
  - *Provenance* (Razorpay published this evidence as relevant) is theirs. *Necessity* (a contest cannot stand without it) is always ours.
  - Marking every published item as required turned guidance into a checklist. Every ordinary-rail "goods not received" dispute then abstained over a capture gap of ours, not anything about the dispute.
- **D-029: a named pattern — a check that reads like rigour and enforces nothing.** Three real instances:
  - a guard over a glob that could match zero files;
  - an amount ceiling that compared a field with itself;
  - an approval guard fed an input manufactured one layer up (F-013).

  Countermeasures: assert the guard has a subject, and drive both sides of every load-bearing check.
- **D-030: an abstention rate is not a finding, so every abstention is attributed to a cause.**
  - The causes are `correct_unwinnable`, `conservative_ambiguous`, `capture_gap`, `evidence_absent` and `false_negative`.
  - A flat "74 abstained" was consistent with both a good gate and a timid one, and a reader could not tell which.
- **D-031: ambiguity abstains by default, because the two errors do not cost the same.**
  - A lost contest costs the amount plus fees and handling. A missed winnable contest costs the amount.
  - On a genuinely balanced case, abstaining is the cheaper error before any judgement about the merits.
- **D-033: a known recall gap was frozen, not rushed.**
  - Duplicate-charge disputes need a sibling-payment slot the capture schema lacks (F-010).
  - Closing it was predicted to take dev recall 31/38 → 36/38. But it perturbs the seeded stream, forcing a full reseed and a re-record of every fixture.
  - A cutoff set in advance fired, and the gap ships named, with its predicted gain.
- **D-034: false-positive cost is the handling, not the disputed amount.**
  - The docs say the amount is deducted if the dispute is lost, which happens whether or not we contested. Charging it to the decision would attribute a loss the decision did not cause.
  - What is counted is an assumed representment fee (₹1,000) plus reviewer handling (₹500) per false positive. Both are stated beside the number they produce.

### Comparison and regression

- **D-045: the eval gate compares counts, and a prompt is part of what it compares.**
  - `eval/baseline.json` holds integers the report also shows. A floor copied from a rounded figure fails against the run that produced it: 31/38 prints as 81.6%, and "recall ≥ 81.6%" is false for that very run.
  - It is one-directional. Fewer false positives or more true positives need no baseline rewrite; the gate exists to catch a silent slide, not to freeze the numbers.
  - Each prompt body is fingerprinted with sha256. A changed body under an unchanged version is a regression, because the recordings and the baseline then describe a prompt that is no longer in the tree.
  - Updating it is deliberate (`pnpm eval -- --write-baseline`), so the diff shows which number moved, in a review.
- **D-046: the model matrix is pinned, and it compares model families, not providers.**
  - Membership lives in `eval/matrix.config.json`, with the date and the source of the catalogue query. A comparison whose membership follows a provider's catalogue is not a comparison.
  - Every model is Groq-hosted, so the rows are families. Saying "providers" would claim breadth the setup does not have.
  - The account served 11 models. Removing audio, classifiers and the barred `gpt-oss` family left exactly two chat models, and both are in. The file records the exclusions and why.
  - Each model records into its own fixture file. The frozen model-of-record recordings behind `eval/results.md` are never touched (D-023).
- **D-047: run-to-run variance is reported, not smoothed.**
  - Re-sampling the *same* model of record gave dev recall 29/38, against the frozen 31/38 behind the headline. Held-out stayed 7/9.
  - The headline is therefore one sample of a stochastic drafter, and the honest size of that noise is about two dev cases.
  - The fix is not to re-run until it matches. The frozen recordings stay the headline, and the variance is stated wherever the headline is.

### The provider seam

- **D-048: a provider is a field map and a normaliser, not a plugin system.**
  - The domain decides what evidence exists and whether it is enough. A provider decides what that evidence is *called* on the wire and how a contest payload is shaped.
  - Razorpay's field names used to live on the rubric, as a `contestField` on every artifact, so `packages/core`'s domain spoke one provider's vocabulary and a second had nowhere to go. They now live in `providers/razorpay/fields.ts`.
  - The neutral map is typed against `string`; Razorpay's own table is typed against the documented field union, so a typo there is a compile error rather than a payload the provider rejects.
  - `normaliseRazorpayDispute` is the one place that knows Razorpay sends seconds and calls a payment id `payment_id`.
- **D-049: the database columns went neutral; the capture envelope did not.**
  - Columns are `providerDisputeId` and `providerPaymentId` now, with a `provider` enum beside them and provider-scoped unique keys.
  - The evidence-pack envelope still says `razorpayPaymentId`, and `readPackAsIngest` maps the column back to it explicitly.
  - Two reasons, and the second is load-bearing: the envelope is the merchant-facing capture contract, and every prompt is built from it while every replay fixture is keyed by a hash of the prompt (D-007). Renaming one key would have missed all 174 recordings at once and turned a replayed eval into a live one.
- **D-050: the adapter is resolved from the dispute, not held by the process.**
  - `approveAndSubmit` looks up the client by the dispute's `provider` through an `AdapterRegistry`. A single global adapter is a dispute submitted to whichever provider the server happened to be configured for.
  - `SubmissionResult` no longer carries a Razorpay entity. It reports the provider, the payload as sent, the action, and a status string, because that is all the pipeline ever read.
  - The simulator stopped fabricating a dispute entity. Every field in it was invented to satisfy a type, which is exactly what hard rule #6 exists to stop.
- **D-051: the contest draft stays grouped by provider field, with the table injected.**
  - The tidier refactor would group assignments by artifact and let each provider fold them into fields later.
  - It was rejected because `evidenceFields` counts a draft's assignments, and regrouping changes that number — moving a published metric for an internal refactor. The seam is the injected map; the shape stays.
- **The corpus columns are nullable now.** `scenarioClass`, `corpus`, `seed` and the ground-truth columns describe a *generated* dispute. A dispute arriving from a provider has none of them, and a schema that demands them cannot store one.

### Product

- **D-043: the demo clock is part of the simulation.**
  - Seeded `respond_by` values are fixed offsets from `CORPUS_EPOCH`, so they are read against `CORPUS_NOW` (epoch + 50 days), which the server provides.
  - Moving the epoch was rejected, because timestamps reach prompts and prompts are replay keys (D-007).

## Incidents

Each incident records what broke, how it was found, and what changed.

- **F-002: the held-out provider failed twice, in two different ways.**
  - First, a model id written from memory returned 404. Fix: read the account's model list instead of guessing.
  - Second, a reasoning model spent its entire 16-token budget on hidden reasoning and returned HTTP 200 with an empty body.
  - An empty response is now a schema-validation failure with its own test, not a success.
- **F-010: duplicate-charge ground truth lived in corpus metadata the evidence pack never carries.**
  - The collector could not tell a genuine duplicate from two distinct orders, because the capture envelope holds one payment.
  - It was found by asking what data the collector would actually read. The tests would have passed either way.
  - This is the gap D-033 names.
- **F-011: the model made six correct judgements, and the pipeline filed all of them as broken plumbing.**
  - 9 of 10 disputes abstained with "assembly failure".
  - The model's actual answer was "charged amount exceeds the mandate cap; evidence does not support contesting", which is correct.
  - One JSON channel carried both "I refuse" and "the evidence is insufficient", so merits-abstention inherited failure handling.
  - The two were split, and "insufficient evidence" became a valid answer.
- **F-013: a convenience line defeated the one-door rule, and every test still passed.**
  - The route prefixed any approver with `human:`, so `{"approvedBy":"system"}` drafted, approved and submitted a contest with no human involved.
  - Every downstream guard passed correctly on a lie manufactured above it.
  - The coercion was removed and the input is now rejected. This is D-029's third instance.
- **F-014: adding an optional field broke every dispute that didn't have it.**
  - After the refund slot landed, 85 of 97 disputes failed to process. The 12 that survived were exactly the disputes that had a refund.
  - The cause: a row-flattening helper identified relations by inspecting values.
  - All pure tests had passed. That gap is why a database round-trip CI job was added. It never actually executed on GitHub before F-031's fix.
- **F-015: a feature was verified against a server I had not started.**
  - My server died with `EADDRINUSE`. A stale process in *live* mode answered every request, and `/health` said `ok`.
  - It surfaced only because fixture recordings appeared that replay mode could not have produced.
  - Health checks now report the process id and assembly mode, so this cannot pass unseen.
- **F-024: every deadline in the console read as months overdue, and 266 tests agreed.**
  - Seeded deadlines were subtracted from `Date.now()`, so the corpus aged a day per day and all 102 rows showed expired.
  - Both halves of the subtraction were individually correct.
  - Fixed by D-043.
- **F-025: fixing a schema-fidelity bug moved a headline held-out number, and the fix wasn't free.**
  - Seven UPI reason codes were missing their published evidence guidance. A guard checked one file against the other and was self-consistent, but wrong, because the omission was in the source file.
  - Filling it in cost one held-out case to a drafter veto (recall 7/9 → 6/9).
  - The cost was disclosed rather than tuned away.
- **F-028: `resetDemo` was never scoped to the demo.**
  - It deleted demo disputes correctly, then rewound *every* non-received dispute in the table, silently resetting the seeded corpus.
  - Two docblocks claimed the reset never touched the corpus, and no test ever ran it against real data.
  - The reset is now scoped to the demo prefix, with a database-gated regression test.
- **F-029: the drafted contest overstated every amount by a factor of a hundred.**
  - The letter prompt received raw paise, and the model read them as rupees ("INR 165,400" for a ₹1,654 dispute).
  - 74 of 114 recordings stated an amount, and all of them were wrong.
  - The gate's own rule trace printed raw subunits too.
  - It was found by reading one drafted case end to end in the running console, which no test does.
  - Money is now formatted before any model or reviewer reads it. Held-out recall returned to 7/9.
  - The case that this is not holdout-tuning is set out in the README.
- **F-030: the capture layer read back less evidence than it captured, and only the product noticed.**
  - A helper stripped foreign keys by suffix and dropped `trackingId` on every read-back, so the drafter never saw a tracking number on a "goods not received" dispute.
  - The eval builds packs in memory, so it always saw the tracking id. The product and the eval had been drafting from different evidence.
  - Fixed, and the two paths were verified byte-identical on a sample dispute.
- **F-031: CI never ran on GitHub, and nobody noticed for twelve days.**
  - All 8 CI runs, from the first push on 2026-09-03 to 2026-09-15, failed in about 30 seconds at `pnpm/action-setup`, before install, lint or tests.
  - The workflow pinned `version: 10`, and `package.json` pinned `packageManager: pnpm@10.33.4` (added 2026-09-03). The action refuses to run when both are set.
  - The keep-warm workflow failed all 75 of its runs over the same period. Its guard was waiting on a deploy URL that nobody ever filled in.
  - Local `pnpm test` passed the whole time, so nothing in the build loop showed red.
  - I found it during the revamp by reading `gh run list` after a push, not from any notification.
  - The fix leaves `packageManager` as the only pnpm pin and gives keep-warm the real URL.
  - The next push produced the first green CI run in the repository's history (run 34955525087, 2026-09-15), with both the `verify` and `integration` jobs passing.
  - The same false-confidence pattern as D-029, from a different angle: the integration job's own guard, which asserts that at least five tests ran, was sound, but the job never got far enough to run it. A check that never runs gives no signal, green or red.
- **F-032: the keep-warm ping most likely caused the outage it existed to prevent.**
  - On 2026-09-30 the deploy returned HTTP 503, "This service has been suspended", on every path, and every keep-warm run had been failing for days with `curl: (22) ... 503`.
  - The ping had been fixed and verified green on 2026-09-15 (F-031). Pinging every five minutes keeps a free instance awake continuously, which is about 744 hours a month against a 750-hour free allowance.
  - The workflow's own comment had the arithmetic and the caveat: it only fits "because this workspace runs exactly one service". It treated that as a standing fact rather than something to check, and the margin was six hours.
  - The other candidate is the 30-day expiry on the free Postgres, which needs the Render dashboard to tell apart. Both are stated until it is confirmed.
  - The workflow is disabled. The README no longer claims a live demo or a ping that keeps one awake.
  - **The lesson is about the shape of the mechanism, not the arithmetic.** A keep-alive that consumes a capped monthly allowance to avoid a per-request cold start trades a one-minute delay for the risk of total suspension. The cold start was the honest cost, and the README said so plainly before the ping existed.

## What is not claimed

- **The corpus is self-generated.** Metrics are decision quality under our own labelling. The held-out set, written by a different model family with a different scenario mix, is the evidence that the system is not merely tuned to its generator. See [`EVAL.md`](../EVAL.md) for the thirteen known weaknesses.
- **No live Razorpay call is made** (D-032).
- **Live model output is not reproducible.** Numbers are byte-reproducible because responses are replayed from committed recordings.
- **Supporting more dispute providers is not the same as supporting more agentic protocols.** One protocol, UPI Reserve Pay, is modelled today.
