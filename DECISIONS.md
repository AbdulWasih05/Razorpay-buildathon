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
| **Any model influence that could ADD a contest, raise an amount, or submit** | The drafter can change an outcome, but in one direction only: it may withhold a contest the gate approved (recorded as `drafter_disagreement`), and it can never create one the gate declined -- a declined dispute makes no model call at all. It cannot touch the amount, choose an evidence field, attach a document, or reach the adapter. Every path it can take leads to less money being claimed, never more; a component whose worst case is excess caution is not a stochastic step a money action depends on. See D-025. |
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

**Amended 2026-09-05: the claim was stronger than the mechanism, and an
adversarial review found the gap empirically.** `no-restricted-imports`
matches the literal import-specifier string, which two probes confirmed does
not cover: a dynamic `await import('@praman/llm')`, and a relative-path
import of the same module (`'../../llm/src/index.js'`) -- both produced zero
lint errors, while the equivalent static specifier import correctly failed.
Neither was ever present in the shipped codebase; the gap was in the
guarantee, not in an actual violation.

**Fix.** `packages/core/src/boundary.test.ts`: a second, structurally
different check on the same boundary -- a regex scan over stripped source
text, not an import-specifier matcher, so it does not share ESLint's blind
spot. Verified against both confirmed bypasses directly: a probe file
containing exactly the dynamic-import and relative-path forms failed both new
tests, then passed once removed. Mirrors the eval-cannot-import-adapter guard
and the holdout guard -- this project's established pattern for a boundary no
single tool fully expresses.

**The honest framing, stated because D-029 says to ask it of every guard:**
"enforced by the linter, not by discipline" is still true and still the
common case -- every static import is still caught the moment it is typed.
What was not true, until this amendment, was "enforced, full stop" -- two
specific paths existed that the enforcement mechanism, by its own documented
design, does not check. Two independently-mechanised guards is the actual
claim this project can now make.

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

---

### D-021 -- the assembler runs on a different model family from the one that wrote the holdout

**Decided.** The assembly layer is provider-agnostic behind one interface.
Anthropic is used whenever `ANTHROPIC_API_KEY` is present. No such key exists in
this environment, so the committed recordings were produced by
`qwen/qwen3.8-27b` via Groq -- and the choice of *which* non-Anthropic model is
the load-bearing part.

**Why not the obvious fallback.** The project already has a working Groq client
and a proven model in `openai/gpt-oss-120b`. Using it would have been one line.
It would also have been quietly fatal: gpt-oss-120b **wrote the held-out
corpus's conversation language**. An assembler running on that model would be
reading text its own family generated, the holdout would stop being
out-of-distribution for the system under test, and the OOD delta -- the single
number offered as evidence that this is not tuned to its own generator -- would
measure nothing. Everything would still run. The numbers would still look fine.

So the assembler runs on Qwen (Alibaba) and the holdout was written by gpt-oss
(OpenAI): different labs, different training runs, separation preserved.
`assertNotHoldoutFamily()` throws if anyone points the assembler at the holdout's
family, and a test covers it. Enforced in code rather than remembered, because
this is exactly the kind of contamination that never announces itself.

**The honest cost.** CLAUDE.md §4 names Anthropic and the recordings are not
Anthropic's. That is a real deviation and it is written into §4 rather than left
for a reader to discover. It is cheap to undo: provider name and model id are
both part of the replay key, so setting `ANTHROPIC_API_KEY` and running
`pnpm assemble --live` re-records everything rather than silently serving output
from the wrong model. No claim that Praman "uses Claude" appears anywhere.

**Rejected.** (a) `openai/gpt-oss-120b` -- see above; the convenient option was
the one that destroys the eval. (b) Waiting for an Anthropic key before building
the layer -- the checkpoint is tonight and the provider is a swappable detail.
(c) A hand-written stub assembler to demo with -- that is not the assembler, and
demoing one while describing the other is the kind of thing that gets found at a
panel.

---

### D-022 -- ambiguity flagging shares the summarisation call

**Decided.** TASKS.md P2.3 names three LLM jobs: trace summary, letter draft,
ambiguity flags. There are two calls, not three. `summariseTrace` returns the
summary, a `confirmation` classification and `ambiguityFlags` together.

**Why.** All three outputs come from one reading of the same text. A second call
to re-read the same trace and emit flags would double the cost, double the
latency, add a second replay key per dispute, and give two chances to disagree
about what the trace says. Splitting work across calls is worth it when the
calls need different context; these need identical context.

`confirmation` (`explicit` / `implied` / `absent` / `contradicted`) is included
deliberately, and is deliberately NOT a decision: the prompt forbids the model
from concluding anything about authorisation, because whether consent was valid
is decided from the mandate record by arithmetic in the collector. The model
reports what the customer said; code decides what it means.

**Rejected.** Three separate calls for symmetry with the task list -- the task
list names jobs, not HTTP requests.

---

### D-023 -- model of record, and the deadline for choosing it

> Numbered D-023, not D-022: D-022 was already taken by the summarisation-call
> decision in the same session. Same decision, next free number.

**The problem.** Every committed recording in `packages/llm/fixtures/` was
produced by `qwen/qwen3.8-27b` (D-021). Every number P4.1 computes will
therefore be a Qwen number. If an Anthropic key appears on Sep 2 and the
fixtures are regenerated, **every metric changes and the eval report is
invalidated** -- silently, because the report is a committed markdown file that
does not know which model produced the recordings behind it.

**Decided.** The model of record is chosen **before P4.1 starts**, not after.
Exactly two acceptable paths:

1. **Qwen ships as the model of record.** Perfectly acceptable. The README says
   which model produced the drafts, in plain words, next to the metrics table.
   The "where we deliberately did NOT use AI" section's honesty extends to
   *which* AI -- naming the model is the same discipline as naming the boundary.
2. **The Anthropic key is set and everything is re-recorded ONCE, before the
   batch run.** `pnpm assemble -- --live` plus a holdout pass; provider and model
   are both in the replay key, so nothing stale survives the swap.

**Forbidden.** Re-recording after `eval/results.md` exists. That produces a
report whose numbers no committed fixture can reproduce, which is the precise
opposite of the property the whole record/replay design exists to provide. If
the key arrives late, the answer is "we shipped Qwen and said so", not "we
re-ran it quickly".

**Amended 2026-09-05, after the rule was broken once and needed a name for
why.** Commit `4b0e077` (the UPI 128 clause fix, F-019) re-minted recordings
and changed `eval/results.md` after the file already existed from a prior
commit -- the letter of this rule, broken, honestly (headline metrics verified
unmoved via `pnpm abstentions` before re-minting) but never reconciled against
this entry's own text. An adversarial review caught the gap between the two. A
second instance followed immediately: closing the rubric-provenance finding
behind F-025 re-minted recordings again, and that time a headline number
**did** move (held-out recall, 77.8% -> 66.7%) -- disclosed in full in F-025
rather than quietly re-run until a case landed the old way.

**The carve-out, stated instead of left implicit a third time.** Re-recording
after `eval/results.md` exists is permitted for exactly one reason: a
correction mandated by hard rule #1 (schema fidelity -- an invented, omitted,
or misattributed field or requirement). It is not permitted for a better
number, a nicer letter, a different persona, or any reason that is not "the
docs said something else and the code was wrong." Three conditions, every time:

1. The model of record does not change (still `qwen/qwen3.8-27b` via Groq --
   this carve-out is about *when* fixtures may be re-minted, never about
   *which model* mints them).
2. `pnpm abstentions` (gate-only) is run before and after; any change to
   *required*-coverage decisions on the dev set is itself grounds to stop and
   investigate before proceeding, since a fidelity fix is not supposed to move
   the gate.
3. The change and its full effect -- including on headline numbers, not only
   on the sub-metric the fix targeted -- is logged in FAILURES.md the same
   session, whether or not the headline numbers actually moved. "Unmoved" is a
   measured outcome to report, not an assumption to skip reporting under.

**What this does not weaken.** The rule still forbids re-recording to chase a
better number, to swap providers, or to "clean up" a run after the fact for any
reason short of hard rule #1. Two uses of the carve-out exist as of this
writing (F-019, F-025) and both are logged with their full before/after,
including the one that did not stay flat.

**Deadline: P4.1 start (Sep 2).** Whichever path is taken, this entry gets a
one-line amendment naming the model of record and the date it was fixed, and
`eval/results.md` carries the model id in its header.

**CLOSED 2026-09-01, path 1: `qwen/qwen3.8-27b` via Groq is the model of
record.** Fixed before P4.1 starts, as required, and it does not move again.

Why path 1 and not path 2: no `ANTHROPIC_API_KEY` exists in this environment and
none is expected before the deadline, so path 2 was never actually available --
choosing it would have meant hoping for a key and re-recording late, which is
the forbidden thing wearing an optimistic face. Deciding it now costs a README
sentence; discovering it on Sep 2 would have cost the report.

State of the recordings at the moment of freezing, so the claim is checkable:

```
56 recordings, all groq / qwen/qwen3.8-27b
   36  letter-draft   v2
   20  trace-summary  v1
```

**What this obliges.**

- The README names the model in plain words **next to the metrics table**, not
  in a footnote. The "where we deliberately did NOT use AI" section's honesty
  extends to *which* AI; naming the boundary and hiding the model would be a
  strange pair of choices.
- `eval/results.md` carries `qwen/qwen3.8-27b` in its header.
- No re-recording after `eval/results.md` exists, whatever arrives later. If a
  key appears on Sep 3, the answer is "we shipped Qwen and said so."

**One wrinkle recorded rather than tidied away.** Five of the 56 recordings were
minted accidentally on 2026-09-01 by a stale live-mode server (F-015), not by an
intended `--live` run. They are genuine output for the five a4 letters whose
evidence changed when the settlement field landed, the diff was purely additive
(65 insertions, 0 deletions -- recordings are keyed by request hash, so new
evidence mints new keys and overwrites nothing), and no report existed at the
time. So the rule holds. It is written down here because a reader comparing
timestamps in the fixture file will notice the gap, and finding it explained is
different from finding it.

**Not claimed:** that Qwen is the right model, or that Anthropic would score the
same. The eval measures this pipeline with this model, and a different model
would need its own run. What *is* claimed is that the committed report is
reproducible from the committed fixtures, which is the property that matters and
the one a stranger can check.

**Why this needs deciding rather than drifting.** The failure mode is not a bad
number, it is an unreproducible one. A stranger cloning the repo and running
`pnpm eval` must get the report that is committed. That is the claim; a late
re-record breaks it without any test going red.

---

### D-024 -- two known recall holes: deferred repairs, not accepted limitations

**Context.** Two gaps cost real recall and are visible in the collector today:
`refund_settlement_proof` is unobtainable for UPI 1061 (D-016 area, rubric
`sourceable: false`), and a3's duplicate-charge ground truth rests on a fact the
capture pack never carries (F-010).

**Decided.** Both are **deferred repairs, not structural limitations**, and both
land before P4.1 freezes numbers. The distinction matters because the honest
move differs: a structural gap ships with the ugly number and an explanation, a
deferred repair gets repaired.

- **`refund_settlement_proof` -- roughly one hour.** The reasoning in the rubric
  ("a merchant transaction store holds no bank statement") is true of a *bare*
  transaction store and false of a Razorpay-integrated merchant, which does hold
  settlement and payout records. We did not model one. Adding a settlement
  reference to the capture schema is a field, a migration, a generator line and
  a collector branch. It can be derived from the existing `refundIssued` fact
  without consuming a new random draw, so the seeded stream is unperturbed.
- **a3 duplicate payment -- roughly two to three hours.** Capturing a sibling
  payment adds RNG draws, which perturbs the dev stream: full reseed, and a
  holdout re-record because a3 prompts change. Bigger, still not structural.

**Why not today.** Day 3's gate is tonight and it comes first. Corpus surgery on
the morning of a gate is how both get done badly.

**Why not "ship it honestly" either.** Showing a known recall hole is the right
call when the hole is expensive to close. Neither of these is. "We found it,
fixed it, and here is the before and after" is a strictly better artifact than
"we found it and shipped it" -- and the before/after is itself the eval-integrity
story, since it demonstrates the harness detecting its own corpus bug.

**Scheduled as TASKS.md P4.0, ahead of P4.1.** If either slips past that point,
it converts to an accepted limitation, is written up as one in EVAL.md's known
weaknesses, and the recall cost is reported rather than hidden.

---

### D-025 -- the gate runs before the model, and a declined dispute never reaches one

**Decided.** Pipeline order is: collect (deterministic) -> **gate** (deterministic)
-> draft (model, only if the gate said contest) -> map to fields
(deterministic). A dispute the gate declines makes **no model call at all** --
not for a summary, not for ambiguity flags.

**Why, and this is a correction rather than a design.** The P2.4 checkpoint build
called the model first and let the letter drafter return "the evidence does not
support a contest". That worked, and it was wrong: a model was effectively
making the contest/abstain call, which is exactly what hard rule #4 forbids
("LLM is NEVER used for ... submission decisions, anything on the money path").
Nobody would have noticed from the output, because the model's judgements were
good. Good outputs from a boundary violation are worse than bad ones, because
nothing prompts you to look.

**What the model's judgement became instead.** A second opinion. If the gate
clears a dispute and the drafter, reading the same evidence, says the case is
not there, that is recorded as \`drafter_disagreement\` and the dispute abstains
conservatively. Neither reading overrides the other -- two independent
judgements disagreeing is precisely when a human should look, which is what the
review queue is for.

**The asymmetry that keeps this inside hard rule #4, stated because it is the
obvious challenge.** On the dev corpus the drafter changed the outcome of two
disputes: the gate said contest, the drafter disagreed, and both abstained. A
reader of the "where we deliberately did NOT use AI" table is entitled to say
*that is a model changing a contest/abstain decision, which is the money path.*

The answer is that the drafter holds a **veto toward safety only**, and the
direction is enforced by the pipeline's shape rather than promised in prose:

| The drafter CAN | The drafter CANNOT |
| --- | --- |
| withhold a contest the gate approved | create a contest the gate declined -- a declined dispute makes no model call at all |
| cause a `drafter_disagreement` abstention | raise, lower or otherwise touch the contested amount |
| decline to write a letter | choose an evidence field, attach a document, or map an artifact |
| | reach the submission adapter, which requires a human `ApprovalToken` |

Every path the model can take leads to **less** money being claimed, never more
and never faster. A money action still requires two independent approvals it
cannot supply: deterministic gate clearance, and a named human pressing approve.

That is what makes it not a stochastic step the money action depends on. The
rule exists because a payment must not hinge on a model returning something
useful -- and if this model fails, times out, refuses or emits garbage, the
dispute abstains (the four failure paths). **Every failure mode of the model,
including "it was wrong", costs at most a contest we did not file.** A component
whose worst case is excess caution is not on the money path in the sense hard
rule #4 means; a component that could file, raise, or submit would be, and this
one structurally cannot.

Worth being blunt about the cost: this trades recall for safety, and the two
cases in question were both labelled `ambiguous` by the corpus, so a contest on
either would not have been obviously wrong. We paid two disputes of recall for
the property. D-031 is the argument for why that trade is the cheap direction.

**Three abstention classes, counted separately** (P4.1 reports each):
\`gate\` (rules said no; no model involved), \`drafter_disagreement\` (two readings
disagreed), \`assembly_failure\` (the pipeline broke, hard rule #4). Collapsing
any two of these is F-011 repeating itself.

**Side effect worth naming.** Most of the corpus abstains at the gate, so most
disputes cost nothing in tokens. The cheap path and the correct path turned out
to be the same path, which is not always true and is pleasant when it is.

---

### D-026 -- \`necessity\` is our judgement even on published evidence, and saying so fixed the gate

**Decided.** In the rubric, \`provenance\` and \`necessity\` answer different
questions and are never conflated:

- **provenance** -- who says this evidence is relevant. \`published\` means
  Razorpay listed it and the exact phrase is quoted. Not our opinion.
- **necessity** -- whether a contest can stand without it. **Always ours**,
  including on published items.

**Why it needed deciding.** The first version of the table marked every
published item \`required\`, which read as fidelity and was actually the
opposite: Razorpay publishes evidence *guidance*, not a mandatory checklist, and
the only precondition their API enforces is "a minimum of one document id across
any of the evidence attributes". Marking their whole list mandatory turned our
strictness into their rule.

**How it showed up.** With coverage at 1.0, UPI 1064 required *both* delivery
proof and customer correspondence -- and the ordinary rail captures no customer
correspondence at all. Every ordinary-rail "goods not received" dispute
abstained, on a gap in our capture layer rather than on anything about the
dispute, while the summary line read like a considered judgement. The number
would have been reported as evidence-sufficiency behaviour and been nothing of
the kind.

**Fix.** Necessity assigned per code by which fact actually decides the claim:
delivery proof decides "not received"; authorisation evidence decides "I never
authorised this"; agreement between what was asked for and what was ordered
decides "not as described". Everything else Razorpay lists stays \`published\` and
becomes \`supporting\` -- it corroborates a contest without being load-bearing.

**What it taught.** "Be maximally strict" is not the same as "be faithful", and
it is the more dangerous of the two, because strictness looks like rigour in a
diff and only reveals itself as an artefact when you read what the system
actually declined and why.

---

### D-027 -- the review UI shows the reviewer everything except the answer

**Decided.** `GET /review/disputes/:id` returns the gate decision, every
evidence finding with its reason, the drafted letter, and the full audit
timeline. It does **not** return `groundTruth` or `groundTruthRationale`, and a
test asserts their absence.

**Why.** Ground truth is corpus bookkeeping. A reviewer who can see the label is
not reviewing, they are confirming, and a demo of that is theatre. It would also
quietly contaminate any human-in-the-loop measurement we might want later. The
field exists in the database because the eval needs it; the review surface is
simply not where it belongs.

**Two more omissions, for the same family of reason.** No bulk approve -- an
approval authorises one dispute, and a "select all" is how one click becomes
fifty submissions. No simulated won/lost anywhere in the UI, per hard rule #6:
the simulator does not even produce one, so there is nothing for a renderer to
leak.

**What the reviewer does see, deliberately:** the gate's reason in its own
words, every artifact with `present` / `absent` / `not_capturable` and why, and
the letter with its character count against the 1000 limit. The intent is that
a reviewer can disagree with the system on the evidence, which requires seeing
the evidence rather than a score.

### D-028 -- the demo has no auth, so reviewer identity is client-asserted and says so

**Decided.** `POST /review/disputes/:id/approve` takes `approvedBy` in the
request body. There is no authentication in front of it. The client asserts its
own identity, the server validates the shape and the name, and that is the whole
story in the demo.

This is a scope decision, not an oversight, and the distinction only survives if
it is written down.

**What production would do instead.** The approving actor derives from the
authenticated session -- whoever the request is authenticated as IS the actor --
and the request body is **never consulted for identity at all**. `approvedBy`
would not exist as an input field. That is the first layer, and it is the one
that actually makes the one-door rule true: a caller cannot claim to be someone
because a caller cannot claim anything.

**What the reserved-name validation is, then.** Defence in depth *behind* that
first layer, not a substitute for it. `ApprovalToken` refuses `human:system`,
`human:bot` and the rest because a session-derived actor can still be a service
account, and a service account approving a contest is the same violation of
hard rule #2 by a slower route. The check earns its place in a real deployment;
it just is not the thing standing between an anonymous caller and a submission.

**Why say this out loud rather than let the fix speak.** After F-013 the honest
reading of the repository is *"the prefix bug is fixed, and we know the request
body should not be the source of truth for identity"*. Without this entry the
reading available to a panelist is only the first half, which invites exactly
the follow-up question the second half answers. F-013's whole lesson was that a
guard reading a **format** is not a guard; leaving identity in the body is the
same shape of mistake one layer further out, and pretending otherwise would be
a strange thing to do in the same repository.

**Rejected: building auth for the demo.** A login, a session store and a user
table would consume most of a remaining day to demonstrate a property nobody
doubts we could implement, on a submission whose scarce resource is time. The
gap is cheap to state and expensive to close, so it gets stated. What is NOT
acceptable is a deploy that reads as production-shaped while quietly accepting
any identity, so the deployed demo carries a banner saying it is a demo (P4.3)
and this entry carries the rest.

**What this does not excuse.** The route still validates. An unauthenticated
demo is a reason to have no session, not a reason to accept `{"approvedBy":
"system"}` -- which is precisely what it did accept until F-013.

### D-029 -- naming the pattern: a check that reads like rigour and enforces nothing

**The pattern.** A guard whose *code* asserts a real property, whose test passes,
whose reviewer nods -- and which cannot fail, because of something outside the
assertion itself. Not a wrong check. An empty one, wearing the costume of a
right one.

Three instances so far, in three different mechanisms:

| Where | Why it could not fail |
| --- | --- |
| F-009, the holdout import guard | The glob could match zero files and the test would still pass. A guard over an empty set is vacuously true. |
| The adapter's amount ceiling (P3.4) | `prepare()` compared the contest amount against `draft.amount` -- the same field. `x > x` is never true, so "may not exceed the disputed amount" enforced nothing. |
| F-013, the approval guard | The check was real and the input was manufactured one layer above it. `isHumanActor('human:system')` is correctly true; the string was a lie before it arrived. |

**Decided: three countermeasures, applied wherever a guard is load-bearing.**

1. **Assert the guard has a subject.** F-009's suite now asserts the glob finds
   more than ten files; the eval-cannot-import-adapter test asserts it found
   more than two eval sources first. A guard over an empty set is worse than no
   guard, because it produces confidence.
2. **Drive both sides.** The amount test now asserts that
   `disputedAmount + 1` is refused *and* that `disputedAmount - 1` is accepted.
   One-sided tests cannot distinguish a working check from a dead one; the
   passing case is what proves the guard has a boundary rather than a floor at
   infinity.
3. **Give the check its own inputs.** `ContestDraft` carries `disputedAmount`
   separately from `amount` for exactly this reason. A comparison whose two
   operands come from one field is not a comparison, and no amount of careful
   reading catches that as reliably as making the second operand exist.

**Why this is a decision and not just three fixes.** The three instances share
no code and were found three different ways -- one by a false positive, one by
reading, one by curling an endpoint with a hostile value. What they share is a
failure mode: **the confidence a guard produces is not proportional to the work
it does**, and passing tests measure the first. On a money path that asymmetry
is the whole risk, because every one of these read as evidence of safety in a
review.

**The uncomfortable generalisation.** All three were written by me, in files
whose docblocks argue at length for why the guard matters. Fluency about a
safety property is not the same as enforcing it, and this repository is full of
fluency. Where a guard defends a hard rule, the question worth asking is not
"is this check correct?" but **"what would have to be true for this check to
fail, and has anything ever made it true?"** If nothing in the suite has ever
made it fail, it is decoration until proven otherwise.

### D-030 -- an abstention rate is not a finding, so every abstention is attributed to a cause

**The problem with the headline.** The first full run reported **74 abstained,
26 drafted**. That number is equally consistent with two opposite products: a
gate doing its job on a corpus deliberately loaded with undefendable disputes,
and a gate too timid to contest anything. It cannot distinguish them, and
neither can a reader. Shipping it as a headline would have been a number
pretending to be a result.

**Decided.** Every abstention is attributed to one of five causes, against
ground truth, by `eval/abstentions.ts` (`pnpm abstentions`):

| Cause | Meaning |
| --- | --- |
| `correct_unwinnable` | corpus says unwinnable, we declined. The product working. |
| `conservative_ambiguous` | corpus says ambiguous, we declined. Defensible under hard rule #7 -- counted **separately**, because a contest here would not have been obviously wrong and folding it into "correct" would flatter the number. |
| `capture_gap` | winnable, and every required artifact we lack is one Praman structurally cannot produce for **any** dispute. Recall lost to our capture layer. |
| `evidence_absent` | winnable, and a capturable artifact is missing from this particular pack. |
| `false_negative` | winnable, **full required coverage**, declined anyway. The gate was wrong, with no excuse attached. |

The dev corpus, 100 disputes:

```
contested  28 (gate)  ->  26 drafted, after 2 drafter disagreements
abstained  72 (gate)  +   2 drafter  =  74

  52  72%  correct: corpus says unwinnable
   8  11%  conservative: corpus says ambiguous
  11  15%  RECALL LOST -- capture gap
   1   1%  RECALL LOST -- evidence absent from this pack
   0   0%  RECALL LOST -- gate declined with full coverage

recall on winnable: 26/38 = 68%      false positives on unwinnable: 0
```

**What the split says, which the total could not.** Seventy-two percent of the
abstentions are correct on cases the corpus calls unwinnable, and **zero**
contests were filed against an unwinnable dispute -- so the false-positive cost
is ₹0, not a small number. Of the twelve winnable disputes we lost, **every one
is attributable to a named capture gap**, and none to the gate misjudging
evidence it already held. The lost recall is four artifacts, countable:

```
  5  duplicate_payment_analysis   (a3 -- F-010, P4.0b)
  5  refund_settlement_proof      (a4 -- P4.0a)
  2  item_selection_confirmation  (b4)
  1  delivery_proof               (b4_91, genuinely absent from that pack)
```

**Result of P4.0(a), measured the same way.** Closing `refund_settlement_proof`
moved recall from **26/38 (68%) to 31/38 (81.6%)** with false positives still at
zero. The prediction was +5 and the outcome was +5, on the same seed and the
same 100 disputes -- the generator change consumed no new randomness, so the
corpus is byte-identical apart from the new field and the comparison isolates
the repair. The a4 split afterwards is 5/5 winnable contested and 7/7 unwinnable
abstained, which is the number that mattered: the repair won the cases where the
merchant genuinely paid without starting to contest the ones where the customer
never got their money. A test pins both halves.

**Consequence, and this is why the decomposition was worth a morning.** P4.0
stops being hygiene and becomes the highest-value work left: closing the two
scheduled gaps moves recall from **68% to ~95%** (36/38), and the third
(`item_selection_confirmation`, not previously scheduled) takes it to 37/38.
One case, `b4_91`, stays abstained honestly -- its pack has no delivery proof,
so declining it is the system reading the data correctly.

The rule this sets for P4.1: **the report leads with the decomposition, not the
abstention rate.** A single percentage is not evidence about a system whose
entire claim is that it knows when not to act.

**Rejected: reporting abstention rate with a paragraph of explanation.** Prose
around a number does not survive being quoted, and the number is what gets
quoted. The buckets travel with it.

**One honesty constraint on the P4.0 repair, stated precisely enough to be
attacked.** Closing a capture gap makes evidence exist that did not exist
before. That is a change to the corpus as well as to the product, and whether
the before/after means anything depends entirely on which one came first.

Two different things could sit behind a `capture_gap`:

1. **The capture envelope has no slot for the artifact.** No merchant using
   Praman could have supplied it, because there is nowhere to put it. The fix
   adds a field to the **product**, and the generator then emits it because
   real checkouts genuinely produce it. Recall improves because the product
   improved.
2. **The slot exists and the generator never filled it.** The fix edits the
   **test data**. Recall improves because the exam got easier, and quoting that
   as a product result is circular.

**Both P4.0 gaps are case 1, and it is checkable in one grep rather than taken
on trust.** `packages/core/src/capture/ingest.ts` is the entire capture
envelope and it is a `.strict()` Zod schema, so the capture endpoint rejects
any key it does not declare:

- `refund_settlement_proof` -- the envelope contains **no settlement, payout or
  UTR field anywhere**; `grep -c settlement packages/core/src/capture/ingest.ts`
  returns `0`. `order.status` can be `refunded`, which is how `refund_record`
  is derived, but nothing records that the money actually landed. A generator
  emitting a settlement reference today gets a 400 from `POST /evidence-pack`.
- `duplicate_payment_analysis` -- the envelope declares `payment`, **singular**.
  No `payments` array, no sibling-payment slot, so a second payment against one
  order cannot be represented at all. That is F-010 exactly: the corpus knew a
  duplicate existed and the pack had no way to say so.

The generator therefore *could not* have populated either field. The repair is a
capture-schema change first and a generator change second, and only because a
real merchant's records would contain it. **That order of causation is the whole
argument**, and it is why these are counted separately from `evidence_absent` --
the honest name for "this pack happens to lack something it could have carried",
which P4.0 does not touch.

Beyond that: report **before/after on both sets**, and re-record the holdout so
the repair is not fitted to dev alone. Fixing a gap and reporting only the
after-number would be indistinguishable from tuning to the eval.

**And the caveat that travels with FP = 0.** Zero contests were filed against an
unwinnable dispute, so false-positive cost is ₹0. That is the right result and
it is also partly a statement about the corpus. Most of the dev set's
unwinnables are **structurally** unwinnable by construction (D-011) -- b2's
charge exceeds its mandate cap, b3's payment falls outside its validity window
-- and those are caught by arithmetic, not judgement. A gate that could do
nothing but compare numbers would also score ₹0 here. FP = 0 is never quoted
without that sentence beside it. The gate's actual discrimination is tested on
the 8 ambiguous cases and on the held-out set, and both get their own row rather
than being folded into the headline.

### D-031 -- ambiguity abstains by default, because the two errors do not cost the same

**Decided.** Where the evidence genuinely does not settle the question, Praman
abstains. Not as a fallback when nothing else fires -- as the stated policy for
the ambiguous case, with the reason attached.

**Why: the errors are asymmetric, and the asymmetry is arithmetic rather than
taste.**

| | outcome | cost |
| --- | --- | --- |
| Contest a dispute we lose | false positive | the disputed **amount** + the dispute **fee** + handling time |
| Abstain on a dispute we could have won | false negative | the disputed **amount** |

A bluffed contest that loses costs strictly more than not contesting at all --
the amount is gone either way, and the fee and the handling time are the
premium paid for guessing. So on a case where the evidence is genuinely
balanced, abstaining is the cheaper error **before** any judgement about which
way the case would have gone. That is the false-positive cost the track bar
asks about, stated as a design rule rather than discovered as an outcome.

It is also the honest reading of what a merchant is buying. A dispute responder
that contests marginal cases produces a number that looks like activity and a
bill that looks like fees. Abstention with a stated reason routes the case to a
person, who can do the thing the system cannot: look outside the capture store.

**What this does NOT mean.** It is not "abstain when unsure" applied to every
uncertainty, which would be a system that never acts. The gate contests
whenever required coverage is met and no rule blocks; ambiguity here means the
specific case where the captured evidence supports both readings. On the dev
corpus that is 8 disputes, and they are reported on their own row precisely
because they are where the policy costs something -- a contest on those would
not have been obviously wrong, so counting them as "correct abstentions" would
flatter the result (D-030).

**Where the policy is actually enforced, which is not only the gate.** The gate
contests 8 of the 10 dev ambiguous cases correctly and lets 2 through -- and
**both** of those were then caught by the drafter's second opinion and abstained
as `drafter_disagreement` (D-025). That is worth stating because it was not
designed as an ambiguity backstop; it was designed as "two independent readings
that disagree is when a human should look", and the cases it caught turned out
to be exactly the ambiguous ones. End to end, all 10 abstain.

**Rejected: a confidence score with a tunable threshold.** It would let the
same evidence produce a contest or an abstention depending on a number nobody
can defend at a panel, and it would put a knob on the money path that could be
turned until the metrics looked better. The gate's rules are individually
explainable; a threshold on an aggregate score is not.

**Rejected: contesting ambiguous cases to raise recall.** Recall would improve
and the product would get worse. It is the specific trade this decision exists
to refuse, and the reason the eval reports false-positive cost in rupees beside
recall rather than recall alone -- so that making this trade would be visible
in the numbers rather than hidden by them.

### D-032 -- no Razorpay account: the simulator is the design, and the ids say so

**Decided (2026-09-01).** P0.2 is **cut**, not deferred again. Praman ships with
no Razorpay account, no live API call, and synthetic payment ids -- and every
one of those ids now announces itself.

**The fact that settled it, checked rather than assumed.** Against
https://razorpay.com/docs/api/disputes/ : the Disputes API exposes **fetch,
accept and contest, and nothing else**. A dispute arises when "your customer or
the issuing bank questions the validity of a payment" -- it originates outside
the merchant, and there is no endpoint to create or simulate one.

That collapses the case for the account. The implicit assumption behind P0.2 was
that real credentials would let us exercise the real path; they would not.
`RazorpayClient.contest()` is unreachable against a real dispute **with or
without an account**, because no real dispute can be made to exist. What an
account would have bought is five `pay_` ids nobody can verify, and optionally
one live Documents API upload. Neither is worth a signup on the last build day.

**Why this is a design and not a shortfall.** The adapter was always two
implementations behind one interface, and the honest version of the story is
better than a half-wired live account would have been:

- `RazorpayClient` exists, mirrors the documented request shapes, and is
  contract-tested against examples transcribed verbatim from the docs. It
  refuses any key without the `rzp_test_` prefix, so it cannot touch a live
  account even by accident.
- `SimulatorClient` is what runs, and `adapterFromEnv` **defaults to it**, so
  the demo cannot reach Razorpay by mistake.
- It does not decide won or lost. A contested dispute goes to `under_review`,
  because inventing an outcome is how a simulated number becomes the thing
  everyone quotes.

"We built the real client, verified its shapes against the documentation, and
run the simulator" is a claim that survives a panel. "We have a test account"
would have invited *"so show us a contest going through"* -- which nobody can
do, and which would then need explaining.

**The consequence that needed engineering, not prose.** Until today these ids
were synthetic *temporarily*. Cutting P0.2 makes them synthetic *permanently*,
and that changes what honesty requires of them. `pay_LkvKHWZCvw7WFk` is
indistinguishable from a real Razorpay payment id, and the judges are the
engineers who own that namespace. Hard rule #6 says a simulated thing is
labelled **wherever it is rendered** -- and the only way to guarantee that for
an id is to put the label inside the id, where no renderer has to remember:

```
pay_SIMzSR4DUVsdOB      disp_SIMzSR4DUVsdOB      order_SIMzSR4DUVsdOB
```

Prefix plus exactly 14 base62 characters, so every schema, every
`startsWith('pay_')` and every `payment_id` match is unchanged; a test pins both
the marker and the shape. Only Razorpay's namespace is marked -- `ord_`, `ful_`,
`mdt_`, `rfd_` are the merchant store's own and cannot be mistaken for theirs,
and marking everything would train a reader to stop seeing the marker. Same
device as `SimulatorClient`'s `doc_SIM...`, which was already doing this for
document ids.

**Rejected: keeping the ids realistic for a better-looking demo.** A queue full
of `pay_SIM...` is visibly a simulation, which is the point. An id that looks
real, in a submission whose entire argument is that it does not overclaim, is a
small lie sitting on top of a large honesty.

**Rejected: deferring P0.2 a third time.** It had already been deferred twice
with a hard deadline attached. A task that keeps not happening is a decision
that has not been written down, and the cost of writing it down is one README
sentence, which is now owed: payment ids are synthetic and shape-valid, no live
Razorpay call is ever made, and the contest path is verified against documented
examples rather than a live dispute.

---

### D-033 -- P4.0(b) is not done, and 31/38 is the number that ships

**Context.** P4.0(b) captures a sibling payment for the a3 duplicate-charge
class, so a duplicate is visible in the data instead of asserted in corpus
metadata (F-010). It is worth five winnable disputes: recall 31/38 -> 36/38, or
82% -> 95%. It was the highest-value item left on the board.

**Decided: it does not happen. The eval freezes at 31/38 and the gap is named.**

**Why, and why the reasoning is not new.** A cutoff for this was written down on
2026-09-01, deliberately in advance: *if it is not green and re-verified against
a pid-checked server by early afternoon, freeze at 31/38, record it as a known
gap with the predicted gain, and move to batch. Deploy does not move. Thirty-one
honest is worth more than thirty-six at 11pm with the live link untested.* It is
now the afternoon of 2026-09-03, one day from submission, with the deploy still
unshipped. The rule fires. The whole value of a pre-decided trim is that it is
not re-litigated on the day it costs something, so it was not.

**What doing it anyway would have cost.** Unlike P4.0(a), this repair consumes
new random draws, so it perturbs the seeded stream. That means a full dev
reseed, a holdout re-record against a model D-023 has since frozen, every
assembly recording re-minted, `apps/ui/src/__fixtures__/` recaptured, and every
pinned number in EVAL.md and in the tests re-derived -- with the deploy, the
README, the form and the dry-run all still ahead. The failure mode is not "it
does not work"; it is finishing at midnight with a bigger number and an untested
live link, which is the trade the cutoff exists to refuse.

**What is claimed about the five cases, precisely.** That they exist and are
attributable is **measured**: the decomposition names them by artifact
(`duplicate_payment_analysis` x5) and `eval/results.md` lists every one of them
by dispute id. That closing the gap would move recall to 36/38 is a
**prediction**, and it is labelled as one wherever it appears. The held-out set
shows the same gap independently -- one a3 case, same artifact -- which is weak
evidence that the estimate is not a dev-set artefact.

**Consequence, recorded rather than absorbed.** D-024 called both recall holes
"deferred repairs, not accepted limitations", and said explicitly that either
one slipping past P4.0 "converts to an accepted limitation, is written up as one
in EVAL.md's known weaknesses, and the recall cost is reported rather than
hidden". That conversion is hereby made for a3. Half of D-024 was right --
`refund_settlement_proof` was repaired and its before/after is in the eval. The
other half was optimistic, and saying so is cheaper than a report that quietly
never mentions it again.

**Rejected: shipping without naming the predicted gain.** A reader who sees
seven lost-recall cases with `duplicate_payment_analysis` against five of them
can do the arithmetic. Making them do it buys nothing and costs the benefit of
having named the number first.

---

### D-034 -- the false-positive cost is the handling, not the disputed amount

**Context.** TASKS.md P4.1 specified false-positive cost as "dispute fee +
amount + a fixed handling-time charge for each contested-unwinnable", and
EVAL.md's "Metrics reported" section repeated it. That definition was written
early, from intuition, and never checked against anything.

**What the docs actually say.** Read 2026-09-03 at
https://razorpay.com/docs/payments/disputes/: the disputed amount "would be
deducted from your account and is sent to the customer" **if you lose the
dispute**. No fee schedule appears anywhere in the public disputes
documentation.

**Decided.** The disputed amount is **excluded** from false-positive cost. What
is counted is a representment fee plus reviewer handling, both declared as
assumptions and both printed in `eval/results.md` beside the number they
produce.

**Why.** Losing a contest and never contesting end in the same place for the
amount: it is deducted either way. Charging it to the decision attributes a loss
the decision did not cause. On this corpus it would have inflated the figure by
roughly two orders of magnitude -- one false positive would "cost" the full
disputed value rather than the handling on a case that should never have been
filed. The marginal cost of the wrong decision is the only thing the decision is
answerable for, and it is the only thing a merchant would actually save.

This is the third time the live docs have corrected this repository's own
planning documents rather than the other way round (D-002, D-003, F-005), which
is exactly what CLAUDE.md hard rule #1 says must happen. TASKS.md and EVAL.md
are the files that get amended.

**Why the assumptions are stated rather than sourced.** No published Razorpay
fee figure was found. Rs 1,000 representment plus Rs 500 handling gives Rs 1,500
per false positive. Both are named in the report, not buried in code, so a
reader who disagrees can recompute rather than guess what was assumed.

**Honest footnote, and it is in the report too.** False positives are zero on
both the dev and the held-out set, so on today's numbers the cost is Rs 0 under
any cost model and neither assumption is load-bearing. The metric still has to
mean something before it happens to be zero -- otherwise the first non-zero run
would be measured with a definition nobody had ever examined.

**Rejected: reporting both a "gross" and a "marginal" figure as headlines.** Two
headline numbers two orders of magnitude apart is an invitation to quote the
bigger one. The gross figure is still in the report, on its own row, labelled as
not counted and why.

---

### D-035 -- one origin, not two: the UI ships from the API process

**Context.** TASKS.md P4.3 named Railway for the api and database and Vercel for
the ui. That split is the normal shape and it was written down weeks ago, when
the deploy was a week away rather than a day.

**Decided.** One Railway service. The Fastify process serves the API and the
built Vite bundle from the same origin, with `/api/...` stripped at the router
so the browser sends identical URLs in development and production.

**Why.** Count what the two-deploy version has to get right on the last
afternoon: a Vercel project, a Railway project, a rewrite rule or a CORS
allowlist holding a hostname that does not exist until one of them has already
deployed, an environment variable in each, and a first-line README link that is
correct only if both are up. Count what this version has to get right: one
service, one URL. The UI has no server-side rendering and no framework runtime
-- it is static files -- so nothing is bought by hosting it separately except
a CDN this demo does not need.

The deadline is the argument. On a Tuesday with a week to spare, two deploys is
the better architecture and the split is worth having. The day before
submission, with a live link in the first line of the README, the right question
is not "which is better designed" but "which has fewer ways to be broken at
9pm", and one origin has strictly fewer.

**What it costs, stated.** No CDN for the bundle, and the UI restarts whenever
the API does. Both are irrelevant for a demo instance and would matter for a
product. If this were real, the split comes back.

**Consequences the deploy inherits.**

- `rewriteUrl` strips a leading `/api`, so there is no build-time base-URL
  switch that could be right in dev and wrong in production. The original URL
  is kept on the request, because the 404 handler needs to tell an API route
  that does not exist from a client-side route the SPA will handle -- after the
  rewrite those two look identical.
- The SPA fallback refuses anything with a file extension. Returning the index
  page for a missing hashed asset is the classic version of this bug: the
  browser asks for a script, receives HTML, and reports `Unexpected token '<'`
  from somewhere unrelated. A 404 is worth more than a 200 that lies.
- `SEED_ON_BOOT` seeds the corpus **through `POST /evidence-pack`** against the
  process that just started, exactly as `pnpm seed` does locally (D-012). There
  is deliberately no direct-to-Prisma path for the deployed case: if the capture
  endpoint were broken, a boot seed that bypassed it would hide that behind a
  full queue, which is the one thing the capture layer must never be able to do.
  It runs only when the store is empty, so a container restart cannot silently
  undo what a visitor did.

**Rejected: keeping the plan because it was the plan.** The plan was written to
be executed, not obeyed. What it was actually protecting -- a live link in the
first line of the README -- is better served by this.

---

### D-036 -- Render, not Railway, and the cold start is stated rather than hidden

**Context.** D-035 settled the shape of the deploy -- one origin, one service --
and named Railway because TASKS.md did. Railway's free tier is now trial credit
rather than a standing free allowance, so the host was reconsidered on cost.
Three candidates, all checked against their own documentation on 2026-09-03
rather than from memory.

**Rejected: InsForge.** It is a backend-as-a-service -- Postgres, auth, storage,
Deno edge functions, a model gateway -- not a host for an arbitrary Node
process. Praman is a Fastify server with a Prisma client and a pnpm workspace;
running it there means rewriting the API as edge functions the day before
submission. Ruled out on fit, not on quality.

**Rejected: AWS, despite having credits.** App Runner plus RDS, or an EC2 box
running the same compose file, both work and both avoid every free-tier
limitation below. They also cost an afternoon: a VPC, a security group, a
managed database, and TLS, which App Runner gives free and a bare EC2 instance
does not. This is D-035's argument applied a second time -- the question the day
before a deadline is not which is better designed but which has fewer ways to be
broken at 9pm -- and it points the same way. **If the demo has to outlive the
judging window, this is the migration**, and it is a `render.yaml` swapped for a
task definition, not a rewrite.

**Decided: Render, on the free plan, declared in a committed `render.yaml`.**
One web service and one Postgres, in one blueprint, in the repository. A
reviewer can read how it is deployed instead of taking a screenshot of a
dashboard on trust, and a redeploy is not a sequence of clicks anybody has to
remember.

**What the free plan actually costs us, from Render's own docs (read
2026-09-03).**

- **The service spins down after 15 minutes without traffic, and takes about a
  minute to wake.** This is the real cost and it lands on the worst possible
  reader: the README's first line is a live link and the first person to follow
  it is plausibly an automated screener with a timeout. Three responses, in
  order: the link is labelled with the wake-up delay so a slow first load reads
  as documented rather than broken; a scheduled ping keeps the instance awake
  through the judging window, with the arithmetic that makes that defensible
  written out in **D-042** rather than waved at here; and if the cold start ever
  costs us a reader anyway, the fix is $7, not an architecture change.

  **This bullet said something false until 2026-09-04**, and the correction is
  left visible rather than quietly overwritten. It read: *"the free plan
  includes 750 instance-hours a month against 744 in the longest month, so
  keeping the one service warm is inside the published allowance rather than a
  trick played on it."* The arithmetic is right and the inference is backwards.
  An hours allowance is a budget for running, not a mechanism for staying awake;
  Render's own free-plan page says spun-down services do not consume Free
  instance hours at all, so the allowance is never what wakes anything. Written
  that way, the sentence implied a mitigation that did not exist and left the
  one dishonest-by-mechanism claim in this log sitting under the link a screener
  hits first -- which is the failure mode hard rule #6 exists to prevent, in the
  worst available location. **D-042** supplies the mechanism the sentence
  assumed; **F-023** logs how two verified facts and a "so" manufactured a claim
  that P5.4's fact-check walked straight past.
- **A free Postgres expires 30 days after creation**, with a 14-day grace
  period. Judging is inside that window and the database is seeded from a
  deterministic corpus on boot, so expiry costs one command, not any data. It is
  written down here so that in October it reads as a known end-date rather than
  as an outage.
- 1 GB of storage, which the corpus does not approach.

**Why say all of this out loud.** The honesty taxonomy applies to the deploy as
much as to the metrics. "Live demo" on a plan that sleeps is a claim with a
condition attached, and a reader who waits sixty seconds for a blank page and
was told nothing has been misled by omission -- which is the same failure mode
as an unlabelled simulated outcome, in a different place.

**Consequence.** `nixpacks.toml` and `railway.json` are deleted rather than left
beside `render.yaml`. Configuration for a host nobody deploys to is an invitation
to ask which one is real.

---

### D-037 -- the fact-check pass, and what it changed

**What this is.** TASKS.md P5.4: every checkable claim in the shipped docs
verified against a live source on 2026-09-03, with unverifiable claims cut or
scoped rather than softened. Logged here because "we fact-checked it" is itself
a checkable claim.

**Verified, unchanged.**

- **The UPI reason codes are real and correctly mapped.** Re-read
  https://razorpay.com/docs/payments/disputes/submit-evidence/. The page has an
  explicit UPI section; 1061 Credit Not Processed, 1062 Goods/Services Not As
  Described, 1064 Goods/Services Not Received, 128 Fraudulent Transaction, 1084
  Duplicate Processing and 1085 Charge Amount Exceeds Authorisation Amount all
  appear, and each maps to the scenario class that claims it. 1085 for the
  mandate-limit breach is a particularly exact fit.
- **The Disputes API exposes fetch, accept and contest only** (D-032), so a
  dispute cannot be originated in test mode. Unchanged.
- **The disputed amount is deducted if you lose** (D-034), which is why it is
  excluded from false-positive cost. Unchanged.

**Corrected: a documented evidence clause was missing.** The published guidance
for UPI 128 has three clauses and this repository carried two. Fixed, re-recorded
and written up as **F-019**, which also exposed a second bug behind it. Headline
metrics unmoved; evidence completeness improved.

**Scoped down: "India's UPI agentic stack" was stated as if it were all
shipped.** It is not one thing at one stage, and the difference is checkable by
anyone who follows it:

- **UPI Reserve Pay is live and Razorpay is on it.** Razorpay's own engineering
  blog, 2026-02-20, https://razorpay.com/blog/agentic-payments-and-npci/ :
  "Built on UPI Reserve Pay, the system allows users to give a one-time,
  consent-based authorization by setting spending limits for a merchant."
- **UPI Circle is a live delegated-payments feature.**
- **The Unified Agent Protocol (UAP) is announced, not shipped** -- reported as
  expected to be unveiled at Global Fintech Fest 2026. The docs now say
  "announced" where they said nothing, because a panelist who works there knows
  precisely which of these three they can use today.

**The best thing the pass found, and it is a positioning finding rather than a
correction.** That Razorpay post announces agentic payments on UPI Reserve Pay
and **says nothing about disputes, chargebacks, evidence or merchant recourse**.
It is entirely about the consent model going in. The gap Praman addresses is
therefore not asserted by us about someone else's roadmap -- it is visible in the
judges' own announcement, and the README now says so with the link, in one
sentence, without editorialising.

**Recorded as a limitation rather than fixed: the held-out set exceeds the
Reserve Pay cap.** Reserve Pay blocks are reported as capped at Rs 10,000 for up
to 90 days. All 44 dev mandates sit under that ceiling (max Rs 8,947). **Seven
of the held-out set's 15 mandates do not** (max Rs 19,389), because the OOD
config deliberately shifts the order-value band upward to Rs 24,000 -- one of the
seven axes that make it out-of-distribution.

Not fixed, for two reasons. Regenerating the holdout on the last day would mean
re-recording a corpus that is frozen precisely so it cannot be tuned, which is a
worse trade than the inaccuracy. And the cap is a **pilot parameter**, not a
property of the protocol: encoding Rs 10,000 into ground truth would bake
today's rollout limit into an eval meant to outlast it. What those seven cases
test is the gate's arithmetic against the mandate it was given, which is correct
regardless of the ceiling the scheme currently sets. Stated in EVAL.md as
weakness 12.

**Claims that were never made, so nothing to check.** TASKS.md flagged two
positioning claims as high-risk: an Agent Studio lineage claim ("already ships a
chargeback evidence responder") and a "mirrors Razorpay's published eval
philosophy" claim. Neither appears in README, EVAL, DECISIONS or FAILURES --
they were positioning ideas that never made it into a shipped document. **They
are not to be introduced into the form answers or the video script without being
verified first**, which is the only reason they are mentioned here at all: the
fact-check gates them in advance rather than catching them afterwards.

**Cut: an unsourced number.** The README said the agentic trace is unrecoverable
"ninety days later". Ninety was never sourced -- it was a plausible-sounding
figure, and it collides confusingly with the 90-day Reserve Pay block window,
which is a different thing entirely. Replaced with "weeks or months after the
payment", which is what is actually known and is enough for the argument.

---

### D-038 -- Fastify over Express, written down late and honestly

**Why this entry exists at all.** It was asked, and the honest first answer is
uncomfortable: **it was not decided, it was inherited.** CLAUDE.md §4 named
Fastify before any code existed, and D-001 "confirmed the default stack" in one
clause without arguing the framework. Express is named nowhere as a rejected
alternative, because it was never actually considered. Every other non-obvious
choice in this repository has an entry; this one did not, and a panelist asking
"why Fastify?" would have got "it was in the plan", which is not an answer.

So the entry is written now, and it separates two things that are easy to blur:
what the reason *was* (there wasn't one) and whether the choice is *defensible*
(it is, and three things now depend on it).

**What actually turned out to depend on it.**

1. **`app.inject()`, which shaped the integration test.** FAILURES.md F-014 is
   the bug where `cleanRow` let a null relation through into a `.strict()`
   schema, 85 of 97 disputes failed ingest, and **all 203 tests stayed green**,
   because every one of them was pure. The fix was one round-trip test that
   pushes a real envelope through the real HTTP route into Postgres and reads it
   back. Fastify's `inject` does that with no port, no listener and no teardown
   race. On Express the equivalent is `supertest` -- another dependency, binding
   an ephemeral port -- and the test that closes this project's worst blind spot
   would have been marginally more annoying to write on the day I was least
   inclined to write it. That is not a small difference; it is the difference
   between the test existing and not.

2. **Async error handling.** All fifteen route handlers are `async` and touch
   Prisma. Fastify awaits handlers and routes a rejection to the error handler.
   Express 4 does not: an unhandled rejection in a route is a request that hangs
   until it times out, which on a money path is the worst failure shape
   available -- no error, no response, no log line. Express 5 fixes this, so on
   Express 5 the point is moot; on Express 4, which is what most people still
   reach for, it is a real hazard this project never had to think about.

3. **`rewriteUrl`.** The single-origin deploy (D-035) strips a leading `/api` at
   the router so the browser sends identical URLs in development and production.
   Fastify takes that as a constructor option. On Express it is middleware --
   perfectly possible, and one more ordering-sensitive thing to get right.

Structured logging is built in too, which is how `/health` reports assembly mode
and pid after F-015, but that one is a convenience rather than a dependency.

**What Express would have been better at.** Familiarity, and nothing else that
matters here. It is the framework more reviewers can read without thinking, and
for a project judged partly on whether a stranger can follow the code that is a
real cost, not a nostalgic one. The plugin ecosystem is larger, though this
service uses exactly one plugin (`@fastify/static`).

**Rejected: switching now to make the entry moot.** Obviously. The point of
writing this down late is not to relitigate the choice; it is that an
undocumented choice is indistinguishable from an unconsidered one, and this one
was genuinely unconsidered until it was questioned.

**What it taught.** The discipline of "every non-obvious choice gets an entry"
has a blind spot: **choices made before the log existed do not feel like
choices.** They arrive as part of the furniture, and the entry never gets
written because there was no moment that felt like deciding. The scaffold is
exactly where that happens -- the framework, the ORM, the test runner -- and it
is also where a panel's first questions land.

---

### D-039 -- same-day commits are folded to at most five, and the fold is not squash theater

**Decided.** Work continues in small increments, and before pushing, a day's
commits are folded down to at most five. Applied 2026-09-03: Sep 1 went from
twelve to five, Sep 3 from nine to five. Aug 30 (two) and Aug 31 (four) were
already inside the limit and were **not touched at all**, so those six commits
keep their original hashes.

**The objection, stated first, because it is the honest one.** CLAUDE.md §5 said
"small commits, honest history. **No squash theater**", and this is, on its
face, squashing. Git history is part of what a Razorpay panel reads, and a
history that shows a tidy five commits a day when the work happened in twelve is
a history that has been dressed up. Raised before doing it; the call was made to
fold anyway, at five rather than the two first proposed.

**Why it is defensible anyway, and what makes the difference.** "Squash theater"
means a history that misrepresents how the work happened. Four rules keep this
fold on the right side of that line, and all four are checkable by anyone
reading the log:

1. **Only adjacent commits are folded.** No reordering, ever. The sequence of
   work is exactly what it was.
2. **Every original message survives verbatim**, under its own original subject,
   inside the folded commit. Nothing written at the time is lost or rewritten --
   the messages carry the reasoning, and the reasoning is the part being judged.
3. **Original author dates are kept**, taken from the last commit in each group.
   Nothing is backdated and nothing moves between days.
4. **The tree is byte-identical.** Verified: `34c12eba...` before and after, and
   `git diff backup-before-squash HEAD` is empty. This changed how the work is
   packaged, not what it is.

The original history is on `backup-before-squash`, alongside
`backup-before-trailer-strip` from the earlier rewrite, so the unfolded sequence
remains recoverable rather than destroyed.

**Rejected: folding to two a day**, which was the first request. Twelve commits
into two would have put unrelated work in one blob -- the gate, the adapter, the
UI, the eval decomposition and a capture repair -- and a commit that contains
five unrelated things is genuinely less honest than five commits, whatever its
message says. Five per day keeps each fold thematically coherent, which is the
property that made rule 2 possible: the messages inside a folded commit read as
one piece of work because they *are* one piece of work.

**Rejected: leaving CLAUDE.md alone.** A rule in the project's own instructions
that the visible history contradicts is worse than either policy on its own,
because it is the kind of thing a panelist finds in thirty seconds and cannot
un-see. §5 now states the amended policy and the four constraints, so the file
and the log agree.

**What it taught.** A rule written as a slogan -- "no squash theater" -- is hard
to apply, because it names a vice rather than a property. Restating it as
constraints (adjacent only, messages preserved, dates kept, tree identical)
turned an argument about whether this counted as theater into four things that
can just be checked.

### D-040 -- the review UI is redesigned as an ops console, and §4 changes to say so

**Decided.** The review UI is rebuilt as a dense, single-viewport risk-ops
console: a permanent simulated-data strip, a decision bar carrying the dispute's
identity, the gate verdict and the one door that submits, and below it a narrow
queue spine beside a six-panel evidence workbench. Committed to a light register
(`color-scheme: light`, no dark block). CLAUDE.md §4 is amended in the same
change, from "plain functional table UI -- clarity over polish" to the rule the
new UI actually follows.

**The objection, stated first.** §4 said plain, and `App.tsx` said in its own
doc comment that anything beyond a plain table is "decoration on a screen whose
whole job is making a money decision legible". Redesigning it the day before
submission is exactly the kind of late polish that discipline existed to
prevent, and a panelist who reads CLAUDE.md and then looks at the screen would
find the file and the product disagreeing -- which is the same failure D-039
fixed for the commit log.

**Why it was worth doing anyway.** The plain table was not neutral; it was
actively hiding the work. Three things were on the screen at the same visual
weight as the page header, and two things were not on the screen at all:

- **`GateRule[]` was computed and thrown away.** `evaluateGate` returns a
  rule-by-rule trace and `runPipeline` persisted only the decision and the
  reason. The most reviewable artifact the deterministic core produces was
  never shown. It is now replayed by `readDispute` -- not migrated into a
  column, because `evaluateGate` is pure and takes only `collected`, which is
  already persisted, so there is no second implementation to drift.
- **The mandate arithmetic was a boolean.** `withinLimit: true` is a claim;
  `₹1,654 ≤ ₹2,456.35` is a check a reviewer can redo. The capture store held
  every term and the UI rendered none of them.
- **The approve button was at the bottom of a scroll.** Hard rule #2 says the
  submit path has exactly one door, and the door was the least prominent
  element in the product. It is now in a bar that cannot scroll away.
- **`structurallyUnavailable` was an unstyled table row.** A required artifact
  that could never have been held is the entire argument for capturing at
  transaction time, and it looked like any other gap.
- **The LLM boundary was prose-only.** Every panel now carries a `deterministic`
  or `llm` mark. Five of six are deterministic, and that ratio is the AI-judgment
  claim made visible instead of asserted.

**What the amended §4 rule is.** Dense ops console, not a product page. Colour
encodes state and is never decoration. Hairlines and background steps, never
shadows. Sans for language, mono for identity. No motion. The point of the
original rule -- that nothing on this screen exists to look impressive -- is
kept; what changed is that "plain" was being read as "unstyled", and unstyled
was costing legibility rather than buying honesty.

**Rejected: charts on the eval page.** P4.2 renders `eval/results.md` verbatim
so the page cannot disagree with the committed report, and every caveat travels
next to its number. The page got a typography pass and nothing else: no parsing,
no stat tiles, no computation. A chart would have reintroduced exactly the
second computation that design exists to avoid.

**Rejected: a dark register, and rejected `prefers-color-scheme`.** The old
stylesheet defined both and committed to neither, which is why it read as
unstyled in each. Dark is also the crowded lane at a hackathon; a light console
reads as an internal financial tool rather than a demo.

**Three bugs the redesign surfaced, all logged.** The shell's fixed-row grid
silently handed its growing row to whichever child landed on it (FAILURES.md
F-020), the committed UI fixtures carry `approvedBy: "human:system"` -- a
capture taken before F-013 was fixed (FAILURES.md F-021), and the console held its own copy of which page was open (FAILURES.md F-022).

**What it taught.** "Clarity over polish" was the right instinct written as the
wrong rule. Stated as a preference for plainness it licensed leaving computed
evidence unrendered, which is not clarity -- it is the same information loss the
rule was trying to prevent, arriving from the other direction.

### D-041 -- a landing page at `/`, and the console moves to `/app`

**Decided.** `/` is an overview page, `/app` is the review console, `/eval` is
the console opened on its eval page. Hand-rolled routing, about twenty lines, no
router dependency. Two variable typefaces (Inter, JetBrains Mono) are vendored
into `apps/ui/src/fonts/` as latin-subset woff2, 88KB for the pair, both SIL
OFL 1.1.

**The objection, stated first.** The definition of done says the README's first
line is a live link because a responding link is the cheapest strong signal to
an AI screener — and this change means that link no longer opens the working
product. A screener that bounces off a marketing page has been given *less*
evidence than one dropped straight into a queue of real disputes.

**Why it is worth it anyway, and what pays the objection off.** The console
alone proves the thing runs and says nothing about what it is or why the problem
matters — a reviewer landing cold on a dispute table has to reverse-engineer the
thesis from a UI. The overview states it in about fifteen seconds and puts
"Open the review console" as the first and most prominent control on the page,
above the fold, in the accent colour. The bounce risk is mitigated by never
making the reader hunt for the product.

**The rule that makes the page honest: no number on it is written by hand.** The
metrics table is the `Headline` section of the committed `eval/results.md`,
located by heading and rendered verbatim by the same parser the eval page uses.
Selecting a section is not computing one, so P4.2's invariant holds — there is
still exactly one place a number can be wrong, and it is the report. A test
asserts the landing source contains no `%` and no `₹`, which are the units every
headline metric is reported in; either character appearing there means someone
typed a number.

**Rejected: a hero band above the live console on one page.** It would have
proved the pitch and the product at one URL, but the console is a fixed-viewport
tool whose whole layout depends on owning the screen, and a hero above it either
pushes the workspace below the fold or collapses on selection into a jump.

**Rejected: `react-router`.** Three routes, no parameters, no nesting. The
server side already works — the API's SPA fallback returns `index.html` for any
extensionless GET that is not under `/api/`, so `/app` and `/eval` needed no
server change at all.

**Rejected: Google Fonts.** The demo runs on a free Render instance that cold
starts; a third-party font request is one more thing that can be slow or blocked
while a judge is looking. Self-hosted means the page depends on nothing but the
origin already serving it. Rejected the `@fontsource` packages too, after
installing them: they ship every subset, and an explicit `@font-face` block over
two vendored files is both smaller and easier to defend line by line.

**Rejected: Razorpay's own brand blue** as the accent, in favour of an
ink-indigo. Borrowing the brand colour of the API you submit to reads as either
confusion or flattery in front of the people who own it.

**What it taught.** The bug this shook out (F-022) was not in the routing but in
the console: `useState(initialView)` copies a prop once and then ignores it, so
the URL and the page could disagree. Adding a second address for an existing
screen is a good way to discover that the screen was holding state the address
should have owned.

---

### D-042 -- the free instance is kept awake by a scheduled ping, and the arithmetic is stated

**Context.** D-036 accepted a documented cost -- Render spins a free web service
down after 15 minutes without inbound traffic and takes about a minute to wake
it -- and then claimed a mitigation it did not have. The claim is corrected in
place there; this entry is the mitigation.

The cost is not evenly distributed. It lands entirely on the *first* request
after a quiet period, and the README's first line is a live link whose first
follower is plausibly an automated screener with a timeout. Every later visitor
gets a warm instance. So the whole problem is one request, and one request is a
cheap thing to spend.

**Decided: a GitHub Actions schedule pings `/health` every five minutes,
committed at `.github/workflows/keep-warm.yml`.** A ping is inbound traffic and
inbound traffic is exactly what the idle timer measures, so the mechanism is the
documented one rather than a workaround of it.

**The interval is chosen for headroom, not for frequency.** GitHub states that
scheduled workflows are best-effort and can be delayed during periods of high
load, and five minutes is the shortest interval its cron syntax accepts. At five
minutes against a fifteen-minute threshold, two consecutive runs can be dropped
and the service still never goes idle. Choosing fourteen minutes would have been
arithmetically sufficient and operationally fragile, because it assumes a
scheduler whose own documentation says not to.

**Why this is defensible rather than free-tier abuse, said precisely.** Render's
free-plan page (read 2026-09-04) says nothing about pinging in either direction
-- it neither blesses nor forbids it -- so no endorsement is claimed. What it
does state is the budget: **750 Free instance hours per workspace per calendar
month**, and that spun-down services do not consume them. A service kept awake
continuously consumes 744 hours in the longest month. That fits inside 750, and
it fits *only* because this workspace runs exactly one service; a second free
service in the same workspace would put the pair over the allowance well before
month end. The arithmetic is the whole argument, so it is written down with its
precondition attached rather than asserted as a general fact about the plan.

**Why `/health` and not `/`.** It is an in-memory handler -- no Prisma call, no
render -- so waking the process costs one cheap request rather than a database
round trip every five minutes for a month. It also answers a more useful
question than "is it up". The job asserts the JSON body rather than the status
code, because a platform loading page or a proxy error page arrives with a 200
and would otherwise be logged as a healthy service; and it fails if the
deployed instance reports `assemblyMode: live`, since the demo must replay the
committed recordings the eval scored. F-015 was a stale process answering on the
right port in the wrong mode, and a check that only asserts `ok` cannot see
that. This makes the run log a standing uptime-and-configuration record for the
judging window at no extra cost.

**Rejected: an external uptime service** (UptimeRobot, cron-job.org). They are
free, more reliable schedulers than GitHub Actions, and invisible. D-036 chose a
committed `render.yaml` over a dashboard screenshot precisely so a reviewer can
read how this is deployed instead of taking it on trust; keeping the instance
alive from an account nobody can see would reintroduce the thing that argument
rejected. The less reliable scheduler that ships in the repository is worth more
than the better one that does not, at a five-minute interval where reliability
has three-fold slack anyway.

**Rejected: Render Cron Jobs.** Not available on the free plan, and a service
pinging itself from the same host does not survive the moment it is asleep.

**Known limits, because a mitigation with unstated failure modes is the thing
this entry is correcting.** The workflow only runs once the repository is pushed
to GitHub, which is still open (P5.3 flagged that this repo has no remote);
scheduled workflows run from the default branch only; and GitHub disables them
automatically after 60 days of repository inactivity, which is after the judging
window and after the free Postgres expires anyway. The README's first line
therefore keeps its cold-start note. The ping makes a slow first load unlikely,
not impossible, and the labelled claim stays true either way -- which is the
point of having labelled it rather than promised uptime.

**Consequence.** The deploy URL now appears in three files -- `README.md`,
`SUBMISSION.md` and this workflow -- as the same placeholder token,
`PRAMAN-DEPLOY-URL-PENDING`, so a single grep finds every place P4.3 has to
fill in. The workflow fails with an explicit message while the placeholder is
still there rather than emitting a DNS error that would read as a flaky network.

---

### D-043 -- the demo clock is part of the simulation, and the server owns it

**Context.** F-024: the console rendered every seeded `respond_by` against
`Date.now()` and showed 102 expired deadlines. Two fixes were available and only
one of them is honest.

**Rejected: move the corpus epoch forward, or make it relative to now.** This is
the obvious fix and it is the wrong one. `CORPUS_EPOCH` being a hard-coded
`2026-06-01` is what makes the corpus reproducible: every timestamp is an offset
from it, timestamps reach prompts, prompts are hashed, and the hash is the replay
key for the committed LLM fixtures (D-007). A wall-clock base means every reseed
produces different prompts, every fixture misses, and `pnpm eval` silently goes
live -- trading a cosmetic defect for the loss of the property the eval rests on.
A guard test already forbids it. Rebasing the epoch to a later fixed date would
work today and rot again on exactly the same schedule.

**Decided: the clock is simulated, like the data.** The corpus has no now, so one
is defined for it -- `CORPUS_NOW`, exported beside `CORPUS_EPOCH`, at epoch + 50
days. Deadlines are read against that instead of against real time. This is not a
workaround for the epoch; it is the same decision applied to the other end of the
subtraction. A seeded corpus read against a real clock is a mixed frame of
reference, and mixing them is what produced the bug.

**Why fifty.** `respond_by` across the dev corpus runs from 35 to 147 days after
the epoch. Fifty puts the reader inside that spread: 14 of 102 disputes overdue,
7 inside the three-day urgent window, 81 with room. A queue with nothing overdue
would be a demo with the urgency removed; one where everything is overdue is what
we had. The number is a constant rather than a percentile computed from the
store, because a clock derived from the rows would shift whenever a dispute is
released or approved -- and a demo clock that jumps when you use the demo is
worse than one that is merely fixed. Three tests in `corpus.test.ts` assert the
*shape* rather than the number, so the constant fails loudly if the generator's
timeline ever moves.

**Why the server reports it rather than the UI assuming it.** `/health` already
carries `demoMode` for exactly this reason: the front end cannot know whether the
rows it was handed are seeded, and a label the client switches on for itself is a
label that can be wrong. `simulatedNow` joins it. Today it is always set --
`seed`, `corpus`, `scenarioClass` and `groundTruth` are non-nullable columns on
`Dispute`, so the schema has no shape a real dispute could occupy. The field is
typed `string | null` and the UI falls back to wall-clock time on null, which is
the seam a real rail would arrive through; no branch was built for a mode that
does not exist.

**Why `daysUntil(iso, now)` has no default.** A defaulted parameter would have
compiled every existing call site unchanged and kept the bug in both of them. The
required argument is the mechanism: `null` still means real time, but it has to
be typed on purpose. This is the same lesson as F-013 -- the fix that holds is
the one that makes the wrong thing impossible to write by accident, not the one
that corrects the current caller.

**Consequence for the honesty taxonomy.** The clock is now a labelled part of the
simulation: `clock: simulated` sits beside `assembly: replay` in the console's top
bar, and every deadline's tooltip names the instant it counted from, so a reviewer
can check the arithmetic rather than trust the badge. A simulated corpus shown
against a real clock was, strictly, unlabelled simulated data -- the rule was
being applied to the rows and not to the axis they were measured on.
