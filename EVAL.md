# EVAL.md

Design and honest limitations of the Praman evaluation.

Status: the corpus and the two-generator design are built (P1.1–P1.3). The
harness that scores them — precision/recall, false-positive cost in rupees,
abstention rate, dev-vs-OOD shift — lands in P4.1. **No performance number
appears in this document yet, because none has been measured.**

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
   four-entry allowlist references `OOD_CONFIG` in executable code or reads
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

## Metrics reported

Not yet measured. The harness lands in P4.1 and will report, for **both** the
dev set and the held-out set:

- Precision and recall on the contest/abstain decision against ground truth.
- **False-positive cost in ₹** — for each contested-and-lost dispute: dispute
  fee + amount + a fixed handling-time charge.
- Abstention rate and per-case abstention reasons, with assembly-failure
  abstentions counted separately from evidence-insufficiency abstentions.
- Evidence-completeness per drafted contest (fields populated vs the reason
  code's published requirement).
- **A distribution-shift section**: dev vs held-out, reported plainly however
  ugly the delta is.

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

7. **Payment ids are synthetic** until P0.2 lands a Razorpay test-mode account.
   They are Razorpay-shaped (`pay_` + 14 base62 characters) and substitute
   one-for-one, but no claim that they are real test-mode ids appears anywhere
   until they are.
