# DECISIONS.md

Every non-obvious choice: **what** was decided, **why**, and **what was
rejected**. This file pre-writes the panel defense. Entries are append-only.

---

## Where we deliberately did NOT use AI

The rubric's AI-judgment criterion is explicitly about *"the right tool in the
right place, and where you chose not to use one."* This section is the answer to
the second half.

**The rule:** a money action must never depend on a stochastic step, and an eval
must be reproducible. Everything on the money path is deterministic code.

| Deliberately NOT AI | Why |
|---|---|
| Schema and field mapping (dispute entity, evidence fields, contest payload) | The mapping is fully specified by Razorpay's docs. A model could only introduce variance into something that has one correct answer. Encoded as Zod schemas with contract tests against verbatim doc examples. |
| Sufficiency-gate thresholds and the contest/abstain decision | This decides whether money is contested. It must be inspectable, testable, and identical on every run. A reviewer can read the threshold; they cannot read a model's mind. |
| Metrics computation (precision, recall, false-positive cost in rupees) | An eval a model participates in scoring is not an eval. |
| The submission path | One door: the human approve action. Nothing stochastic gets to press it. |
| Mandate validity, limit and amount consistency checks | Arithmetic and interval comparison. A model here would be strictly worse and strictly less explainable. |

**Where AI genuinely earns its place** (natural language in, natural language
out, no single correct answer): conversation-trace summarisation, explanation
letter drafting, ambiguity flagging. All three are behind one interface in
`packages/llm`, all three are recorded/replayed for reproducibility, and all
four of their failure modes route to abstention rather than onto the money path.

**Enforced, not merely promised.** `eslint.config.js` restricts imports so
`packages/core` -- the deterministic domain -- cannot import `@praman/llm` or
any model SDK. If the boundary is ever crossed, the build fails.

---

## Decision log

### D-001 -- TypeScript end-to-end, and no build step in development

**Decided.** Confirm the default stack (Node 20+, TS strict, pnpm workspaces,
Fastify, Prisma/Postgres, React+Vite). Packages export `./src/index.ts`
directly and are run through `tsx` / `vitest`, which transpile on the fly.

**Why.** One language means fewer seams for a solo builder to defend. Skipping a
compile step for cross-package imports removes an entire category of "stale
`dist/`" confusion during a 6-day sprint, and `pnpm typecheck` still type-checks
everything as one project.

**Rejected.** (a) A TS service with a Python eval harness -- the eval maths here
is counting and division, so a second language buys nothing and costs a seam.
(b) Turborepo/Nx -- caching infrastructure for a repo whose full test suite runs
in about a second. (c) A per-package `tsc` build with project references --
real overhead, no benefit before deploy.

**Revisit at.** P4.3 (deploy). If Railway needs a compiled artefact, add a build
step then, when the requirement is real.

---

### D-002 -- `phase` has five values, not three; the docs override CLAUDE.md

**Decided.** Implement `fraud | retrieval | chargeback | pre_arbitration |
arbitration`.

**Why.** CLAUDE.md §3 names only the three escalation phases, but
https://razorpay.com/docs/api/disputes/fetch-all/ documents five. Hard rule #1
says the docs are the authority and forbids inventing fields; it must equally
forbid *omitting* documented ones. A dispute arriving in `retrieval` phase would
otherwise fail to parse at ingest.

**Rejected.** Implementing the three from the project brief and treating the
other two as out of scope -- that is schema infidelity chosen for convenience,
in a project whose stated differentiator is schema fidelity.

---

### D-003 -- the 1000-character limit belongs to `summary`, not `explanation_letter`

**Decided.** Export `EVIDENCE_SUMMARY_MAX_CHARS = 1000` and apply it to the
`summary` string. `explanation_letter` is typed as a list of document ids.

**Why.** The docs are unambiguous: `summary` is a string, max 1000 characters;
`explanation_letter` is a list of document ids, like every other typed evidence
field. CLAUDE.md's phrasing ("explanation <=1000 chars") reads as though the
letter itself is the capped string. It is not. The LLM-drafted letter therefore
has two possible homes -- inline in `summary`, or uploaded as a document and
referenced from `explanation_letter` -- and that is a real product decision, not
a typo.

**Also decided.** The limit is *not* enforced on the read schema. We must be
able to parse whatever Razorpay returns; we constrain only what we produce. The
constant is applied on the write path in P2.0.

**Open, for P2.0.** Which home the drafted letter takes. Current lean: `summary`
inline (no Documents API round-trip needed to demo), with the Documents API path
built for `explanation_letter` because the real contract requires it.

---

### D-004 -- the dispute entity is `.strict()`; the payment entity is not

**Decided.** `disputeEntitySchema` and the webhook envelope reject unknown keys.
`paymentEntitySchema` types every documented field but allows extras through.

**Why.** These are different kinds of object to us. The dispute entity is *our
contract* -- we consume it and we produce contest payloads shaped by it -- so
drift must fail loudly and immediately. The payment entity is *context riding
along* with the webhook, and its shape legitimately varies by method: a UPI
payment populates `vpa` and leaves `card_id` null, a card payment does the
reverse, and new methods add new keys. Hard-failing dispute ingestion because
Razorpay shipped a field for an unrelated payment method would be brittleness
dressed up as rigour.

**Rejected.** Strict everywhere (brittle at the edges that do not matter) and
lenient everywhere (loses the loud-failure property exactly where it does).

---

### D-005 -- the LLM boundary is enforced by the linter, not by discipline

**Decided.** `eslint.config.js` forbids `packages/core` from importing
`@praman/llm` or any model SDK.

**Why.** "We keep the LLM off the money path" is a claim. A failing build is
evidence. The rubric asks whether the system is trustworthy; a boundary that
cannot be crossed by accident is worth more than a boundary described in a
README. It also survives the thing README claims do not survive: a tired builder
at 2am on day 4.

**Rejected.** Convention plus code review -- there is one author and no second
reviewer, so convention is the weakest available mechanism here.

---

### D-006 -- the OOD generator runs on Groq `openai/gpt-oss-120b`

**Decided.** The second provider is Groq; the held-out corpus (P1.3) is
generated with `openai/gpt-oss-120b`.

**Why.** The held-out set must be out-of-distribution *by construction*, so the
generator must differ from the dev corpus in model lineage, not just in prompt.
gpt-oss is a different family, different training run and different lab from
Claude -- about as far from the dev generator as a free tier reaches. Groq also
speaks the OpenAI-compatible wire format, so the client is a plain `fetch` with
no extra SDK to explain.

**Rejected.** (a) Google AI Studio -- workable, but Groq's model catalogue gives
a sharper family separation from Claude. (b) Signing into the Gemini CLI -- it
is a browser-OAuth interactive session, not an API key; the generator would have
to shell out to a CLI, which is fragile and cannot run in CI. (c) Reusing
Anthropic with different prompts -- this is the option that *sounds* fine and
quietly destroys the claim: same model family means the holdout is not
out-of-distribution, and the OOD delta stops being evidence of anything.

**Note.** The model id was initially written from memory and 404'd; it must be
read off the live account. See FAILURES.md F-002.

---

### D-007 -- seed-derived identity is separated from server-generated identity

**Decided.** Every capture-layer table carries both `externalId` (seed-derived,
stable) and `id` (server cuid), and both `occurredAt` (seed-derived domain time)
and `createdAt` (server wall-clock). LLM prompt inputs may be built **only** from
seed-derived fields.

**Why.** This is what makes the eval reproducible, and the reason is not
obvious. Replay fixtures are keyed by a hash of the LLM request. If a prompt
contains a server-generated cuid or a wall-clock timestamp, then reseeding the
corpus changes the request hash, every committed fixture misses, and the eval
silently starts making live calls -- reproducibility lost with no error raised.
Splitting the two kinds of identity at the schema level makes the correct thing
the easy thing, and canonical comparison excludes the server-generated columns.

**Rejected.** A single id column plus a rule to "be careful in prompts". The
failure mode is silent, so a rule is not enough.

---

### D-008 -- verified: UPI disputes surface in Razorpay's merchant dispute system

**Decided.** The thesis claim stands, and here is the receipt, recorded because
"we verified this" is itself a checkable claim (CLAUDE.md §1).

**Source.** https://razorpay.com/docs/payments/disputes/submit-evidence/,
retrieved 2026-08-30. The page carries a **`UPI` section** alongside Visa,
Mastercard, RuPay and Amex, grouping UPI reason codes by dispute type:

- *Customer Dispute* -- `1061` Credit Not Processed ("Proof of refund
  generation, Bank statement showing refund amount which should match payment
  amount"); `1062` Goods/Services Not As Described ("Product description/image
  screenshots, Proof of product/service delivery"); `1064` Goods/Services Not
  Received ("Proof of service/product delivery, Customer interaction showcasing
  product/service related enquiries").
- *Fraud* -- `128` Fraudulent Transaction ("Internal logs to show authorisation
  was obtained, Invoicing details along with detailed price breakdown").
- *Authorisation Error* -- `108`, `1065`, `121`.
- *Processing Error* -- `1063`, `1084`, `1085`, `1081`.

**Why it matters.** The whole product rests on UPI disputes reaching the
merchant with an evidence deadline. They do, and the required-evidence guidance
is published per reason code -- which is also the ground truth for the P2.1
rubric table. Note especially UPI `128`: the documented evidence is *"internal
logs to show authorisation was obtained"*. For an agent-initiated payment, the
mandate record and orchestration log **are** those internal logs. The
differentiated module is not a stretch of the schema; it is the schema's own
answer.

**Scope discipline.** This verifies "UPI disputes surface here with published
evidence requirements". It does **not** verify any claim about volumes,
agentic-dispute frequency, or pilot specifics. Those remain unverified and stay
out of the README until P5.4 says otherwise.

---

### D-009 -- P0.2 deferred; synthetic payment ids until real ones exist

**Decided.** Defer acquiring the Razorpay test-mode account (builder's call,
2026-08-30). Commit `scripts/record-test-payments.ts` and a fixture at
`packages/core/src/fixtures/razorpay-test-payments.json` explicitly marked
`"pending": true`. The simulator mints synthetic `pay_` ids meanwhile.

**Why.** Nothing downstream is blocked: generators reference payment ids
opaquely, so real ids substitute one-for-one later. The honest cost is that the
"references real test-mode payments" claim cannot be made yet -- so it is not
made anywhere, and the placeholder says so in its own body rather than looking
like real data.

**Rejected.** (a) Dropping P0.2 entirely -- real test-mode ids are a cheap,
genuine schema-fidelity signal to judges who work on this API. (b) Committing a
fixture of invented ids that *look* real -- that is the exact dishonesty the
project's own honesty taxonomy exists to prevent.

**Blocker recorded inline in TASKS.md P0.2.**

---

### D-010 -- the capture endpoint takes the whole transaction, and is idempotent

**Decided.** `POST /evidence-pack` accepts one envelope carrying merchant,
customer, order, payment, fulfilment, mandate, agent identity, protocol
metadata, conversation trace and orchestration log. Every entity carries a
caller-supplied `externalId`, and every write is an upsert on it, inside one
database transaction.

**Why.** Three reasons, in order:

1. *It is what a real capture call would carry.* The moment worth capturing is
   checkout, and at checkout all of this exists at once. Splitting it across six
   endpoints would model our database rather than the domain event.
2. *Idempotency makes reseeding safe.* Re-running `pnpm seed` updates in place
   rather than duplicating, so the corpus can be regenerated freely -- which the
   determinism story depends on.
3. *One transaction, because a half-captured pack is worse than none.* It would
   look like evidence at dispute time and then fail to support the contest.

The schema additionally **refuses** an agentic capture that arrives without a
mandate, agent identity, conversation trace or orchestration log. That is the
exact failure the product exists to prevent, so it is rejected at the door
rather than discovered to be useless months later.

**Rejected.** Per-entity endpoints (models the schema, not the event); allowing
partial agentic captures (defeats the purpose).

---

### D-011 -- ground truth is derived from the generated evidence, never asserted alongside it

**Decided.** A case's `winnable` / `unwinnable` / `ambiguous` label is computed
from the evidence the generator actually produced.

**Why.** If the label were chosen independently, the corpus could disagree with
itself -- an a1 marked `winnable` with no delivery proof anywhere in its data --
and the eval would then be measuring the generator's mood rather than the
system's judgement. Deriving the label means the data and the answer cannot
drift apart. Tests assert the agreement directly: every b2's amount really does
exceed its mandate cap, every b3's payment really was captured after
`validUntil`, and no a1 is called winnable without a delivery-proof reference.

**Rejected.** Label-then-generate, which is easier to write and quietly
unfalsifiable.

---

### D-012 -- seeding goes over HTTP, not straight into Prisma

**Decided.** `scripts/seed.ts` drives `CaptureClient`, which POSTs to the
running API. There is no direct database write path for evidence packs anywhere.

**Why.** If the seed script wrote to Postgres directly, `POST /evidence-pack`
would be a box on an architecture diagram that nothing actually exercises, and
the demo would be showing a component the product does not really use. Seeding
100 packs through the endpoint means the capture layer is exercised by the
corpus build itself. It is slower, and that is an acceptable price for the claim
being true.

**Rejected.** Direct Prisma seeding with the endpoint kept "for the demo" --
which is the version of this that gets found out at a panel.

---

### D-013 -- `/seed/dispute` is named a seeding route, not dressed up as a webhook

**Decided.** Generated disputes are recorded through `POST /seed/dispute`. Its
body is the verbatim Razorpay webhook envelope -- validated by the same contract
schema the real path will use -- plus a clearly separated `meta` block carrying
corpus bookkeeping (ground truth, scenario class, which corpus, seed).

**Why.** A real `payment.dispute.created` webhook does not carry a ground-truth
label. Accepting one on a route called `/webhooks/razorpay/disputes` would blur
evaluation scaffolding into production ingest, which is precisely the kind of
quiet dishonesty this project's own taxonomy exists to prevent. Naming it
`/seed/` keeps the distinction visible in the URL. The real webhook consumer
arrives with the pipeline in P3.

The route also **refuses a dispute whose payment was never captured** (409). A
dispute with no evidence behind it is not a test case, it is a bug.

**Rejected.** One route doing both, with the label as an optional field.

---

### D-014 -- the held-out corpus's language is recorded once and replayed

**Decided.** Conversation text for the held-out set is generated by
`openai/gpt-oss-120b`, cached to a committed fixture keyed by a SHA-256 hash of
the request, and replayed offline on every subsequent run. `--live` re-records.

**Why.** A holdout that regenerates differently on each run is not a holdout, it
is a moving target -- last week's OOD delta would not be comparable to this
week's. Recording once fixes the corpus. It also front-runs the record/replay
design `packages/llm` needs in P2.3, so that mechanism arrives already exercised
rather than untested.

Verified: two replay runs produce a byte-identical `eval/holdout.json`.

**Rejected.** Regenerating live each run (not reproducible); hand-writing a
second set of templates (defeats the point -- the language would come from the
same author as the dev templates, so the holdout would not be out of
distribution on the axis that matters).

---

### D-015 -- the holdout manifest carries ids and counts only

**Decided.** `eval/holdout.json` contains dispute ids, evidence-pack ids and
aggregate distributions. It contains no case content, no conversation text and
no per-case ground-truth labels. A test asserts this.

**Why.** The manifest has to be readable by dev tooling -- that is how the guard
knows what to refuse. So it must be safe to read. Ids and aggregates tell you
which cases to stay away from and nothing you could tune against. If it carried
the cases themselves, reading it during development would be exactly the peeking
it exists to prevent.

**Rejected.** A manifest holding the full corpus, which would have been more
convenient for P4.1 and would have quietly destroyed the property being claimed.

---

### D-016 -- class frequencies are declared as assumption, not dressed as data

**Decided.** The reason *codes* are grounded in Razorpay's published
submit-evidence documentation and transcribed verbatim. The *frequencies* are
labelled an explicit assumption in EVAL.md, because a bounded search found no
published per-reason-code distribution for Indian chargeback or UPI disputes.

**Why.** TASKS.md permits either a citation or a stated assumption. Citing a
source that does not actually say what we need it to say would be worse than
either, and is exactly the failure mode the P5.4 fact-check pass exists to
catch. The agentic rail is additionally over-represented on purpose, and EVAL.md
says so in those words rather than letting the number imply a market forecast.

**Rejected.** Anchoring to a plausible-looking statistic found in a secondary
source without verifying it says what the citation would imply.

**Open.** If a genuine published distribution surfaces before submission,
re-weight and re-run rather than keeping an assumption a better source has
superseded.

---

### D-017 -- prompt projection is an allowlist, exposed over HTTP

**Decided.** `toPromptInput()` copies fields in explicitly rather than deleting
forbidden ones, and `GET /evidence-packs/:id/prompt-input` returns exactly what
a prompt would be built from.

**Why.** Two separate reasons.

*Allowlist over denylist:* a new server-generated column added to the schema
later cannot leak into a prompt by default. With a denylist it would, silently,
and the only symptom would be replay fixtures quietly missing months later.

*Exposed over HTTP:* it makes the rule inspectable by a reviewer instead of
asserted in a document. A panel can curl it. That is a meaningfully stronger
claim than "we are careful about this".
---

### D-018 -- generated merchants sell what they actually stock

**Decided.** Item selection is constrained to the merchant's own category, so an
electronics retailer cannot sell a monthly grocery bundle.

**Why.** Caught while reading the debug endpoint output during P1.1. It is
cosmetic in the sense that no metric depends on it, and not cosmetic at all in
the sense that "would you trust it" is a stated rubric criterion. A judge who
opens one evidence pack and sees incoherent data has been given a free reason to
distrust everything behind it. The fix was ten lines and consumes the same
number of random draws, so it does not perturb the rest of the seeded stream.
