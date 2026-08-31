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
| An agentic loop anywhere in Praman's own runtime (Claude Agent SDK, tool use, autonomous multi-turn) | The three jobs we hand a model are single-shot text transforms: no decision to delegate, no tool to call, no state to carry. A loop would add nondeterminism and a hard replay problem to buy capability we deliberately do not want. Praman is agentic in its **domain**, not in its **implementation**. See D-019. |

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

**Closed 2026-08-31, ahead of P2.0.** The drafted letter's home is `summary`,
inline. `explanation_letter` stays typed as a document-id list and the Documents
API path is built for it, because the real contract requires it and a merchant
with a genuine signed letter must have somewhere to put it -- but Praman does not
manufacture a PDF to fill a field it has nothing real to put in.

Two consequences, both load-bearing:

1. *The drafter targets 1000 characters from the start.* The ceiling is stated in
   the prompt and enforced by the output schema. It is a writing constraint given
   to the model, not a post-processing step applied behind its back.
2. *There is no truncation.* An over-length draft is a schema-validation failure
   -- which is failure path (4) of hard rule #4 -- so the dispute routes to
   `abstain("assembly failure, manual review required")` and is audit-logged.
   Silently cutting a contest letter mid-sentence would ship a mangled argument
   to a card network wearing the appearance of success, which is the exact class
   of quiet failure the gates exist to prevent. No silent retry either; the same
   rule already forbids it.

**Rejected.** (a) Truncate-then-submit -- invisible damage on the money path.
(b) Draft long, then summarise down with a second model call -- a second
stochastic step and a second replay key, bought for nothing. (c) Always uploading
the letter as a document -- a Documents API round-trip on every dispute, to
populate a field whose documented purpose is a letter the merchant actually has.

**Acknowledged trade, with a data-driven revisit trigger (2026-08-31).** Routing
over-length to abstain buys purity at the cost of recall: an over-length draft on
a *winnable* dispute becomes a false negative. Unlike the other three failure
paths, this one is cheaply recoverable -- a single re-prompt stating the budget
would almost certainly fix it, and one bounded, logged, operator-visible
re-prompt would violate neither the letter nor the intent of hard rule #4, which
forbids *silent* retries onto the money path. It is not being added now: the
current design is simpler and defensible, and adding a retry on taste alone is
how exception paths multiply.

**Trigger.** P4.1 already counts abstention reasons separately. If
`over_length_draft` appears more than once or twice across the 100+ dev batch,
that is the evidence to add the single logged retry, recorded as its own
DECISIONS entry and decided from the eval numbers rather than from taste.

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

**Precision note, added 2026-08-31.** "Differs in model lineage" is loose, and
the exact shape matters, because the OOD delta is only evidence if a reader knows
which axis moved. Precisely: the **dev** corpus makes no model call at generation
time at all -- its conversation text is static templates with slot interpolation,
committed in `packages/simulator/src/transaction.ts` and written once during
development. The **held-out** corpus calls `openai/gpt-oss-120b` at generation
time and records what comes back. So the axis that actually moved is *frozen,
developer-authored templates -> live sampling from a different lab's model*,
which is a wider gap than model-vs-model, not a narrower one. This does not
weaken the claim, but it does mean the shift is **compound** -- structure and
language provenance move at once -- so no single axis can be credited for the
delta. EVAL.md states both halves.

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

**Deadline set 2026-08-31.** The original deferral said "builder's call" and
named no date, which is how a fifteen-minute task becomes a missing signal on
submission day. Hard deadline: **before P4.3 deploy, 2026-09-02**, and ideally
sooner, since it is the one remaining task that can be done while waiting on
anything else. Why it earns a deadline rather than a shrug: real test-mode
`pay_` ids are cheap, checkable schema-fidelity evidence for judges who work on
this exact API, and after P4.3 the corpus is seeded on a deployed instance, so
swapping ids costs a reseed. Why it is not worth panicking over: if the deadline
passes unmet, the fixture stays `"pending": true` and no claim is made anywhere.
The deferral stays honest either way -- it just stops being free.

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

---

### D-019 -- Praman's runtime uses plain structured Messages API calls, not the Claude Agent SDK

**Decided 2026-08-31, before P2.3 writes a line of the LLM layer.** The three
model-facing jobs -- trace summarisation, letter drafting, ambiguity flagging --
are single-shot `messages.create` calls with a structured output schema, made
through one interface in `packages/llm`. No agent loop, no tool use, no
autonomous multi-turn execution anywhere in Praman's runtime.

**Why.** Four reasons, in descending order of how much they would cost to get
wrong:

1. *There is nothing for an agent to decide.* An agentic loop earns its place
   when the model must choose what to do next -- pick a tool, read a result,
   revise a plan. Every decision in Praman is on the money path and therefore
   deterministic by hard rule #4: what evidence exists, whether it is sufficient,
   which typed field each artefact maps to, whether to contest. Adopting the SDK
   would mean either handing those decisions to the loop -- violating the rule
   the whole project is built on -- or building a loop with no decisions in it.
2. *Record/replay would get much harder for no gain.* Reproducibility depends on
   a stable request-hash -> response mapping. A single call has one key. An agent
   trajectory has a key per step and a branch structure that varies run to run,
   so byte-reproducible eval numbers -- the thing the OOD delta means anything
   only if we have -- become a research problem instead of a `fetch` with a
   cache.
3. *It is the smaller trust surface.* A loop can call tools; a loop that can call
   tools near a submission adapter is a second door, when hard rule #2 says there
   is exactly one. Not adopting it is cheaper than building the fence.
4. *Panel honesty.* "We used the SDK" is a worse answer than "we know exactly
   what the SDK is for, and this workload is deliberately not that." The
   distinction worth stating out loud: **Praman is agentic in its domain, not in
   its implementation.** The disputes it defends arise from agent-initiated
   payments; the defender itself is deterministic code with three narrow text
   transforms bolted to the side. Conflating those two would be exactly the
   category error the product exists to argue against.

**Where the Agent SDK genuinely is in use:** Claude Code built this repository.
It is in the *build loop*, not the *money path*, and that line is worth drawing
explicitly rather than letting "no agents here" read as false.

**Rejected.** (a) Building the assembly step as an SDK agent with tools for
"fetch evidence pack", "check mandate", "draft letter" -- it demos well and it
puts a stochastic step in front of every gate decision. (b) Adopting the SDK for
the drafting call alone "to have used it" -- resume-driven architecture; the
call is one turn with no tools, so the loop would be a wrapper around nothing.

**Revisit if.** A future capability genuinely needs iterative tool use off the
money path -- a research step that reads merchant policy documents, say. If that
arrives, the SDK is the right tool and this entry is the record of why it was
not needed earlier, not an argument against it.

---

### D-020 -- read and write are separate schemas, and the submit precondition lives in the type

**Decided.** `packages/core/src/schema/contest.ts` models the contest request
independently of `disputeEvidenceSchema`, rather than reusing the read schema
with fields marked optional.

**Why.** They are not the same contract, and collapsing them would break in one
direction or the other:

| | Read (`disputeEvidenceSchema`) | Write (`contestRequestSchema`) |
|---|---|---|
| Every evidence key | present, nullable | optional, omitted rather than null |
| `summary` length | uncapped | capped at 1000 |
| Unknown keys | `.strict()` (drift must fail loudly) | `.strict()` (an unknown key is *our* bug) |

Sharing one schema would mean either refusing to parse a legitimate response, or
failing to enforce a documented limit on our own output. On the money path,
neither is acceptable.

**The part worth defending at the panel.** The documented precondition -- *"You
need to provide a minimum of one document id (across any of the evidence object
attributes) for a successful submission"* -- is enforced **in the schema**, not
in a service method. `contestRequestSchema.parse({ action: 'submit' })` with no
documents throws. So "never bluff a contest" is not a policy someone has to
remember at the call site; it is a type that cannot be constructed. It composes
with hard rule #2 rather than duplicating it: the one door checks *who* may
submit, the schema checks *whether there is anything to submit with*.

`amount` is checked against the dispute separately (`contestRequestForDispute`),
because the ceiling lives on the dispute and not in the payload -- so a payload
can still be parsed in isolation, and the two rules stay separately explainable.

**Rejected.** (a) One shared evidence schema with a `mode` flag -- one object
pretending to be two contracts, and the flag would be read wrong exactly once.
(b) Enforcing the submit precondition in the adapter -- correct until someone
adds a second call site, which is the failure mode hard rule #2 already exists
to prevent.

**Noted as interpretation, not quotation.** Counting `others[].document_ids`
toward the minimum is our reading of "across any of the evidence object
attributes". It is asserted in a named test so a reviewer can disagree with it
in exactly one place.
