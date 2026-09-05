# EVAL.md

Design and honest limitations of the Praman evaluation.

Status: measured. The corpus and the two-generator design are built (P1.1–P1.3)
and the harness that scores them has been run over both sets (P4.1). Every
number below comes from `eval/results.md`, which `pnpm eval` regenerates from
committed recordings — no network, no API key, byte-identical across runs.

---

## Corpus design

Two rails, nine scenario classes, one pipeline.

**Rail A — ordinary e-commerce** (the today-problem wedge; these disputes exist
now and merchants bleed on them today):

| Class | Scenario | Reason code |
|---|---|---|
| a1 | Service or goods not received | UPI 1064 |
| a2 | Unrecognised charge | UPI 128 |
| a3 | Duplicate charge | UPI 1084 |
| a4 | Credit not processed | UPI 1061 |

**Rail B — agent-initiated under a UPI Reserve Pay mandate** (the differentiated
module; the dispute class the agentic pilots are creating):

| Class | Scenario | Reason code |
|---|---|---|
| b1 | Valid agent purchase the customer does not remember | UPI 128 |
| b2 | Mandate limit breach | UPI 1085 |
| b3 | Expired mandate | UPI 128 |
| b4 | Wrong item selected by agent | UPI 1062 |
| b5 | Compromised-agent fraud | UPI 128 |

Note b1 and b3 share reason code 128 and have opposite correct answers. That is
deliberate. A system that classified on the reason code would get one of them
wrong every time; the correct answer comes from reading the mandate, which is
what the deterministic gate does.

### Ground truth is derived, not asserted

Each case's label — `winnable` / `unwinnable` / `ambiguous` — is computed from
the evidence the generator actually produced, not chosen alongside it. An a1 is
`winnable` **because** a delivery-proof reference exists on its fulfilment
record; if the generator did not create one, the same class comes out
`ambiguous` or `unwinnable`. A b2 is `unwinnable` because the charged amount is
arithmetically greater than the mandate cap that was written at capture time.

This matters: a label chosen independently of the data would let the corpus
disagree with itself, and the eval would then be measuring the generator's mood
rather than the system's judgement. Tests assert the agreement directly (e.g.
every b2's amount really does exceed its mandate cap; every b3's payment really
was captured after `validUntil`).

---

## Reason-code distribution and its grounding

### What is grounded

The **reason codes themselves** are transcribed verbatim, with their published
required-evidence guidance, from Razorpay's submit-evidence documentation:

> https://razorpay.com/docs/payments/disputes/submit-evidence/ (retrieved 2026-08-30)

That page carries an explicit **UPI** section alongside Visa, Mastercard, RuPay
and Amex, grouping UPI codes into Customer Dispute (1061, 1062, 1064), Fraud
(128), Authorisation Error (108, 1065, 121) and Processing Error (1063, 1084,
1085, 1081). Every reason code in the corpus is taken from that list. None were
invented. See `packages/core/src/domain/reason-codes.ts` and DECISIONS.md D-008.

The evidence guidance for UPI 128 is quoted exactly: *"Internal logs to show
authorisation was obtained, Invoicing details along with detailed price
breakdown."* This is load-bearing for the thesis — for an agent-initiated
payment, the mandate record and the orchestration log **are** those internal
logs.

### What is assumption, stated plainly

**The class frequencies are not grounded in published data, because we did not
find any usable.** A bounded search (~30 min, per TASKS.md P1.2) for a published
per-reason-code breakdown of Indian chargeback or UPI dispute volumes did not
surface one. NPCI publishes UPI ecosystem statistics, and NPCI's chargeback
rules changed during 2025, but a reason-code-level distribution suitable for
anchoring class frequencies was not located. Rather than cite something that
does not say what we need it to say, the weights are declared as an assumption:

| Class | Dev weight | Basis |
|---|---|---|
| a1 | 22 | Assumed the most common merchant-facing dispute; non-receipt is the archetypal customer dispute. **Assumption.** |
| a2 | 14 | Assumed second: unrecognised-charge claims. **Assumption.** |
| a4 | 12 | Assumed common where refunds are involved. **Assumption.** |
| a3 | 8 | Assumed less common; duplicates are usually caught upstream. **Assumption.** |
| b1–b5 | 44 combined | **Deliberately over-represented** relative to any plausible real-world agentic share, which today is near zero. This is the module under test, so the corpus over-samples it on purpose. |

**The honest reading:** the agentic rail's share reflects what we are testing,
not what the market currently looks like. Precision and recall are therefore
claimed precisely as *decision quality under our labelling on this corpus* —
never as a forecast of real-world dispute mix. This limitation is restated in
the "Known weaknesses" section rather than being left implicit.

Flagged for the P5.4 fact-check pass: if a genuine published distribution
surfaces before submission, re-weight and re-run rather than keeping an
assumption that a better source has superseded.

### Realised dev corpus (100 disputes, seed `praman-dev-2026`)

```
by rail          ordinary 56   agentic 44
by class         a1 22  a2 14  a3 8  a4 12  b1 18  b2 8  b3 6  b4 7  b5 5
by ground truth  winnable 38   unwinnable 52   ambiguous 10
by phase         chargeback 84  retrieval 9  pre_arbitration 7
unwinnable or ambiguous   62.0%
```

62% of the corpus is a case we should **not** win by bluffing — far above the
20% floor TASKS.md sets. A corpus of mostly winnable disputes is the
cherry-picking the track page explicitly calls out; this one leans the other
way, which makes abstention quality the thing under test. Phases include
`retrieval` and `pre_arbitration` so the pipeline meets the phases it will
really see (five documented phases, not three — DECISIONS.md D-002).

---

## Two-generator design (dev vs out-of-distribution held-out)

The held-out set is out-of-distribution **by construction**, not by promise.
This converts "we didn't peek" from something you have to take on trust into a
structural property of the repository.

Both generator configs are committed in `packages/simulator/src/configs.ts`.
They differ on every axis:

| Axis | Dev (`dev-v1`) | Held-out (`ood-v1`) |
|---|---|---|
| Merchant verticals | grocery, electronics, food delivery, apparel, pharmacy | travel, fitness subscription, home services, digital goods |
| Order value band | ₹320 – ₹7,999 | ₹1,499 – ₹24,000 |
| Agent platforms | ShopAgent, PantryBot, ConciergeAI | Wayfinder, HouseKeeperAI |
| Protocol versions | reserve-pay 1.0, uap 0.9 | uap 1.1, reserve-pay 1.2 |
| Class mix | a-heavy (56/44) | flatter, b-heavier (50/50) |
| Conversation length | 4–7 turns | 3–10 turns |
| **Conversation language** | **committed templates in this repo** | **written by `openai/gpt-oss-120b` via Groq** |
| Seed | `praman-dev-2026` | `praman-holdout-2026` |

The last row is the sharp edge. The structural axes could all be matched by a
carefully hand-written second config — but the natural language could not. The
dev traces come from templates that a developer can read and inadvertently tune
against; the held-out traces were written by a different lab's model, with a
different prompt and a six-persona set that exists nowhere in the dev generator.
Since the LLM assembly layer's entire job is reading that language, this is the
axis on which degradation will actually show up.

Using a different *model family* rather than the same model with different
prompts is deliberate. Same family means the holdout is not out-of-distribution,
the OOD delta measures sampling noise, and the credibility claim quietly becomes
false. See DECISIONS.md D-006.

### Exactly what moved, stated precisely

The OOD delta is only evidence if a reader knows which axis moved, so the axes
are named rather than gestured at:

- **The dev corpus makes no model call at generation time.** Its conversation
  text is static templates with slot interpolation, committed in
  `packages/simulator/src/transaction.ts`. They were written once during
  development (by the builder working through Claude Code) and then frozen. Every
  `pnpm seed` run replays the same finite set of sentences. There is no sampling,
  no temperature, and nothing to drift.
- **The held-out corpus calls `openai/gpt-oss-120b` at generation time** with a
  six-persona prompt set that appears nowhere in the dev generator, and records
  what comes back (temperature 0.9). Replay serves that recording thereafter.

So the language axis is not *Claude vs. gpt-oss*. It is **frozen,
developer-authored templates -> live sampling from a different lab's model**,
which is a wider gap, not a narrower one: the holdout differs in vocabulary,
sentence length, register, hedging, and the ways real people are vague, none of
which any template captures.

**What this costs us, said plainly.** The shift is **compound** -- verticals,
price band, platforms, protocol versions, class mix, trace length and language
provenance all move together. That is the right design for asking *"does this
system survive data it was not built against?"*, which is the question a judge
cares about. It is the wrong design for asking *"which axis broke it?"* No single
axis can be credited for the delta, and this document does not attribute it to
one. Per-axis ablation would need one holdout per axis; at 30 cases each and a
free-tier budget, it was not affordable and is not claimed.

### Realised held-out corpus (30 disputes, seed `praman-holdout-2026`)

```
by rail          ordinary 15   agentic 15
by class         a1 4  a2 5  a3 3  a4 3  b1 4  b2 4  b3 3  b4 2  b5 2
by ground truth  winnable 9   unwinnable 20   ambiguous 1
unwinnable or ambiguous   70.0%
```

### How the holdout is protected

Four mechanisms, none of which is a promise:

1. It is generated by its own command (`pnpm holdout:generate`) with its own
   config and its own model.
2. `scripts/seed.ts` does not import `OOD_CONFIG` at all and refuses any
   `--config` but `dev`. There is no flag or hurried edit that points everyday
   tooling at the holdout.
3. `assertDevOnly()` throws `HoldoutAccessError` if a held-out id reaches a dev
   code path.
4. A **static test** over the whole source tree asserts that no file outside a
   six-entry allowlist references `OOD_CONFIG` in executable code or reads
   `holdout.json`. It checks what the code *can* do, not what it happens to do.

`eval/holdout.json` deliberately contains **ids and aggregate counts only** —
never case content, never per-case labels. Reading it tells you which cases to
stay away from and nothing you could tune against. A test asserts that too.

---

## Reproducibility: record / replay

Generation is seeded and deterministic. `pnpm seed` twice with the same seed
produces logically identical data, verified by canonical serialisation that
excludes server-generated row ids and creation timestamps
(`packages/core/src/capture/canonical.ts`).

Three specific choices make that hold:

- **No `Math.random()`.** A mulberry32 generator seeded from a string, ~10 lines,
  explainable from first principles.
- **No `Date.now()`.** Every timestamp is an offset from a hard-coded corpus
  epoch (2026-06-01), so the corpus is the same next Tuesday as it is today.
- **Positionally independent streams.** Each case derives its own generator from
  `seed + class + index` rather than drawing from one shared stream, so editing
  scenario a1 changes a1 and does not silently regenerate the whole corpus.

**LLM output is reproduced by replay, not by determinism**, and the README will
say so in those words. The held-out corpus's conversation language is recorded
to a committed fixture (`packages/simulator/fixtures/ood-language.json`) keyed by
a SHA-256 hash of the request; every subsequent run replays it offline.
`--live` regenerates. Verified: two replay runs produce a byte-identical
`eval/holdout.json`.

The cache key is built only from seed-derived fields. This is subtle and
load-bearing: if a server-generated row id or a wall-clock timestamp reached a
prompt, reseeding would change the hash, every committed fixture would miss, and
the eval would silently start making live calls with nothing raised. A guard
test asserts prompt inputs are byte-identical when every server-generated id and
timestamp differs. See DECISIONS.md D-007.

---

## Abstention decomposition, and what "capture gap" is allowed to mean

An abstention rate is not a finding. "74% abstained" is equally consistent with
a gate doing its job on a corpus deliberately loaded with undefendable disputes
and with a gate too timid to contest anything, and the number cannot tell them
apart. So every abstention is attributed to a cause (`pnpm abstentions`,
`eval/abstentions.ts`, DECISIONS.md D-030). Dev corpus, 100 disputes:

| Cause | n | Meaning |
| --- | --- | --- |
| `correct_unwinnable` | 52 | corpus says unwinnable, we declined. |
| `conservative_ambiguous` | 8 | corpus says ambiguous, we declined (D-031). |
| `capture_gap` | 11 | winnable, lost to a missing capture slot. |
| `evidence_absent` | 1 | winnable, artifact capturable but absent from this pack. |
| `false_negative` | 0 | winnable, full coverage, declined anyway. |

Recall on winnable: **26/38 = 68%**. False positives on unwinnable: **0**.

### The distinction the before/after depends on

P4.0 closes two of these gaps and recall moves. That number is only meaningful
if the gap was **in the product**, and it is worth being explicit about what
would make it meaningless, because "they fixed their own corpus and recall went
up" is the obvious attack and it would be a fair one.

There are two different things that could sit behind a `capture_gap`:

1. **The capture envelope has no slot for the artifact.** No merchant using
   Praman could have supplied it, because there is nowhere to put it. Closing
   the gap means *adding a field to the product* — and the generator then emits
   it because real checkouts genuinely produce it. Recall improves because the
   product improved.
2. **The slot exists and the generator simply never filled it.** Closing the
   gap means *editing the test data*. Recall would improve because the exam got
   easier, and reporting that as a product result would be circular.

**Both P4.0 gaps are case 1, and it is checkable in one grep rather than taken
on trust.** `packages/core/src/capture/ingest.ts` is the whole capture
envelope, and it is a `.strict()` Zod schema — meaning the capture endpoint
**rejects** any key it does not declare:

- `refund_settlement_proof`: the envelope contains **no settlement, payout or
  UTR field anywhere** (`grep -c settlement packages/core/src/capture/ingest.ts`
  → `0`). `order.status` can be `refunded`, which is how `refund_record` is
  derived, but nothing records that the money actually landed. A generator
  emitting a settlement reference today would get a 400 from
  `POST /evidence-pack`.
- `duplicate_payment_analysis`: the envelope declares `payment` — **singular**.
  There is no `payments` array and no sibling-payment slot, so a second payment
  against one order cannot be represented at all. This is FAILURES.md F-010:
  the corpus knew a duplicate existed and the pack had no way to say so.

So in both cases the generator *could not* have populated the field. The repair
is a schema change to the capture layer first, and a generator change second and
only because a real merchant's data would contain it. That order of causation is
the whole argument, and it is why these are counted separately from
`evidence_absent` — which is the honest name for "this pack happens to lack
something it could have carried", and which P4.0 does not touch.

A third gap, `item_selection_confirmation`, is the same shape: the orchestration
log records what the agent *selected*, and there is no field for what the
customer *requested*, so agreement between them cannot be established from
records (D-026).

### False positives are zero, and here is what that does and does not show

Zero contests were filed against a dispute the corpus calls unwinnable, so the
false-positive cost is **₹0** rather than a small number. That is the right
result and it is also partly a statement about the corpus, not only about the
gate.

Most of the dev set's unwinnables are **structurally** unwinnable by
construction (D-011): b2's charge exceeds its mandate cap, b3's payment falls
outside the validity window. Those are caught by arithmetic — a `<=` and an
interval comparison — not by judgement. A gate that could do nothing but compare
numbers would also score ₹0 here. **FP = 0 must never be quoted without that
sentence beside it.**

The gate's discrimination is actually tested in two places, and both are
reported on their own row rather than folded into the headline:

- **The 8 ambiguous cases**, where the evidence genuinely does not settle the
  question and no arithmetic decides it.
- **The held-out set**, where unwinnables were written by a different model
  against a different persona set and may not announce themselves as cleanly.

If FP stays 0 on the held-out set, that is evidence about the gate. On the dev
set alone it is mostly evidence about D-011.

---

## Model of record

Every recording behind every number in this file was produced by
**`qwen/qwen3.8-27b` via Groq**. Fixed 2026-09-01, before the eval ran, and it
does not move (DECISIONS.md D-023).

The intended provider is the Anthropic Messages API and the code uses it
whenever `ANTHROPIC_API_KEY` is set (CLAUDE.md §4). No such key exists in this
environment, so Qwen is what shipped, and saying so is the same discipline as
naming the LLM boundary in the first place.

Deliberately **not** the model that wrote the held-out corpus:
`openai/gpt-oss-120b` generated the OOD set, and `assertNotHoldoutFamily` throws
if the assembler is ever pointed at that family, because a model grading its own
prose would flatter the distribution-shift delta (D-021).

**Not claimed:** that Qwen is the best choice, or that another model would score
the same. This eval measures this pipeline with this model. What is claimed is
that the committed report is reproducible from the committed fixtures, which is
the property a stranger can check.

---

## Metrics reported

Measured. The full report is `eval/results.md`, regenerated by `pnpm eval` —
replay mode, no network, no API key. Headline:

| metric                                   | dev           | held-out (OOD) | shift |
| ---------------------------------------- | ------------- | -------------- | ----- |
| disputes                                 | 100           | 30             | —     |
| recall on winnable                       | 31/38 = 81.6% | 6/9 = 66.7%    | −14.9% |
| precision on contests                    | 100.0%        | 100.0%         | 0.0%  |
| false positives (contested & unwinnable)  | 0/52          | 0/20           | 0     |
| false-positive cost                      | ₹0            | ₹0             | ₹0    |
| abstention rate                          | 69.0%         | 76.7%          | +7.7% |
| assembly failures                        | 0             | 0              | —     |

**Held-out moved on 2026-09-05**, closing a rubric-provenance fidelity finding
(seven UPI reason codes wrongly marked as having no published evidence
guidance). Dev is verified unchanged (`pnpm abstentions`, gate-only, byte-
identical before/after); held-out lost one case to a new drafter disagreement
on a gate-cleared, full-coverage dispute — recall −11.1pp, within the drafter's
veto-toward-safety scope (D-025) but a real, disclosed cost. Full account in
FAILURES.md F-025.

The report carries, for **both** sets: the abstention decomposition (first, not
the rate — D-030), precision and recall against ground truth with `ambiguous`
reported on its own line rather than folded into either column, false-positive
cost in ₹, evidence-completeness per drafted contest, how often a model was
called at all, the distribution-shift deltas, and every lost-recall case named
by dispute id.

**The false-positive cost definition was corrected before it was implemented.**
This document previously specified it as "dispute fee + amount + a fixed
handling-time charge". Razorpay's disputes documentation, read 2026-09-03, says
the disputed amount is deducted **if you lose the dispute** — which happens
whether or not we contested. Charging the amount to the decision attributes a
loss the decision did not cause, so it is excluded and shown on its own labelled
row instead. What is counted is a representment fee plus reviewer handling, both
**stated assumptions** (no published Razorpay fee schedule was found), both
printed in the report beside the number they produce. See D-034.

**Two commands in this repo print a contested count, and they differ on
purpose.** `pnpm abstentions` recomputes the deterministic gate over the seeded
corpus and needs no model; on dev it contests 33. `pnpm eval` runs the whole
pipeline; on dev it contests 31. The gap is the drafter veto and nothing else —
both withheld contests landed on disputes the corpus labels `ambiguous`. The
report reconciles the two counts explicitly so a reader never has to guess which
number to trust.

Phrasing discipline, fixed now so it is not negotiated later: "₹ protected" is
banned. The permitted phrasings are "₹ at stake in drafted contests" and "₹ in
correctly abstained disputes". Simulated won/lost outcomes are tagged
`simulated: true` at the data level and are demo texture only — never a headline
metric.

---

## Known weaknesses and limitations

Stated here before anyone has to ask.

1. **The corpus is self-generated.** This is the central weakness. It is
   mitigated — OOD holdout from a different model, reason codes grounded in
   published docs, unwinnable and ambiguous cases deliberately included — but
   not eliminated. The metric is claimed precisely as *decision quality under
   our labelling*, and the dev-vs-OOD delta is offered as the evidence that the
   system is not merely tuned to its own generator.

2. **Class frequencies are assumption, not data.** See above. No published
   per-reason-code distribution was found in a bounded search.

3. **The agentic rail is over-represented on purpose.** ~44% of the dev corpus
   is agent-initiated. Real-world share today is far lower. This is a test of a
   module, not a forecast of a market.

4. **Ground truth is our judgement encoded as rules.** The rules are explicit,
   inspectable and test-asserted, but they are still ours. A real dispute is
   adjudicated by an issuer applying network rules, and issuers are not perfectly
   consistent. "Winnable" here means "defensible on the evidence we hold", not
   "would have been won".

5. **Held-out size is 30 against a dev set of 100.** Small enough that per-class
   OOD figures will be noisy — b4 and b5 have 2 cases each. Class-level OOD
   numbers should be read as directional; only the aggregate carries weight.

6. **Dispute origination is simulated.** Razorpay's sandbox cannot originate a
   dispute — they are bank-originated. The simulator mirrors the documented
   entity field-for-field and every generated event is validated against the
   contract schema built from the published examples, so the *shape* is real
   even though the *origination* is not. The contest path is built against the
   real documented contract.

7. **Payment ids are synthetic, permanently, and they say so.** P0.2 was cut
   (D-032): the Disputes API exposes fetch, accept and contest only, so a
   dispute cannot be originated in test mode and `RazorpayClient.contest()` is
   unreachable against a real dispute with or without an account. Ids in
   Razorpay's namespace therefore carry the marker inside them — `pay_SIM…`,
   `disp_SIM…`, `order_SIM…`, prefix plus exactly 14 base62 characters, so no
   schema check is weakened. No live Razorpay call is made anywhere in this
   repository.

8. **The OOD shift is compound, so the delta is not attributable to one axis.**
   Seven axes move between dev and holdout at once. The aggregate delta answers
   "does it survive unfamiliar data"; it cannot answer "what specifically broke
   it". Per-axis ablation would need one holdout per axis and is out of budget.
   See "Exactly what moved, stated precisely" above.

9. **Dev conversation language is developer-authored, which is the sharpest form
   of the self-generated problem.** The dev templates were written by the same
   author-plus-model pairing that built the system that reads them. That is
   precisely why the holdout's language comes from a model with no involvement in
   this repository, and precisely why the language axis is called the sharp edge
   above -- it is the one where familiarity would flatter us most.

10. **The a3 duplicate-charge capture gap was not closed, and it costs five
    winnable disputes.** `duplicate_payment_analysis` is required for UPI 1084
    and the capture envelope holds one payment per order, so a duplicate is
    asserted in corpus metadata rather than visible in the data (F-010). Five
    of the seven dev lost-recall cases and one of the two held-out ones are
    this. It was scheduled as P4.0(b) and frozen unfinished at a pre-declared
    cutoff (D-033) because the repair perturbs the seeded stream and would have
    forced a full reseed and re-record on the last day. **Predicted, not
    measured:** closing it takes dev recall 31/38 → 36/38. The five cases are
    named individually in `eval/results.md`.

11. **The four LLM failure paths did not fire during the batch.** Error,
    timeout, refusal and schema-validation failure are each covered by unit
    tests and each route to `assembly failure, manual review required`. Across
    130 disputes and 41 model calls in the scored run, zero fired. That is
    reported as zero rather than dressed up: the paths are tested, they are not
    batch-proven, and a replayed run cannot exercise a live provider error by
    construction. The one real instance to date is F-002 — an empty HTTP 200
    from a reasoning model — which is the incident the schema path was written
    for.

12. **Seven held-out mandates exceed the Reserve Pay cap.** Reserve Pay blocks
    are reported as capped at ₹10,000 for up to 90 days. All 44 dev mandates sit
    under that ceiling (max ₹8,947); **7 of the held-out set's 15 do not** (max
    ₹19,389), because the OOD config deliberately shifts the order-value band up
    to ₹24,000 — one of the seven axes that make it out-of-distribution. Not
    fixed: regenerating the holdout would mean re-recording a corpus frozen
    precisely so it cannot be tuned, and the cap is a *pilot parameter* rather
    than a property of the protocol, so encoding ₹10,000 into ground truth would
    bake today's rollout limit into an eval meant to outlast it. What those seven
    cases test is the gate's arithmetic against the mandate it was handed, which
    is correct whatever ceiling the scheme currently sets. See D-037.
