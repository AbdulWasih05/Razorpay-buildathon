# FAILURES.md

What broke, how it was diagnosed, what the fix or fallback was. Logged the
**same session** it happened -- never backfilled from memory. A first-class
deliverable (rubric criterion #4: "what broke, and what you did about it").

Format: what broke -> how diagnosed -> fix/fallback -> what it cost.

---

## Session 1 -- 2026-08-29/30 (P0 scaffold)

### F-001 -- pnpm 10 silently refused to run install scripts, leaving binary-backed tools broken

**What broke.** `pnpm install` completed successfully and printed
`Ignored build scripts: @prisma/engines, esbuild@0.21.5, esbuild@0.28.2, prisma`.
Install "succeeded", but esbuild's platform binary and Prisma's query engine
were never downloaded, so `vitest` and `prisma` would both have failed at first
use -- and would have failed in CI too, on a fresh clone, which is exactly the
P0.1 acceptance criterion.

**How diagnosed.** Read the install output instead of skimming for the exit
code. pnpm 10 blocks lifecycle scripts by default as a supply-chain measure.

**Fix.** Declared the allowlist in the repo rather than running the interactive
`pnpm approve-builds`, so CI resolves identically to a laptop:

```json
"pnpm": { "onlyBuiltDependencies": ["esbuild", "prisma", "@prisma/engines", "@prisma/client"] }
```

**Cost.** ~5 min. Caught before it could masquerade as a mysterious CI failure.

**What it taught.** A green exit code is not a green install. The P0.1
acceptance criterion is "green in CI on a fresh clone" precisely because local
success proves less than it looks like it does.

---

### F-002 -- the OOD provider failed twice, in two different ways

**What broke, first.** `pnpm check:ood-provider` returned
`404 ... The model 'llama-3.3-70b-versatile' does not exist or you do not have
access to it`. The model id had been written from memory rather than read off
the account.

**Fix.** Queried `GET /openai/v1/models` with the live key and picked from what
the account actually serves. Chose `openai/gpt-oss-120b`.

**What broke, second.** With a valid model, the request returned HTTP 200, a
well-formed body, `finish_reason: "length"` -- and `content: ""`. A success
response carrying nothing.

**How diagnosed.** The response body included
`completion_tokens_details: { reasoning_tokens: 14 }` against `max_tokens: 16`.
gpt-oss is a *reasoning* model: hidden reasoning tokens are billed against the
same budget as output, so a 16-token cap was fully consumed before a single
visible character was emitted.

**Fix.** `max_tokens: 512` and `reasoning_effort: 'low'`, with the reason
written into the code as a comment so P1.3 does not rediscover it.

**Cost.** ~10 min.

**Why this one matters beyond itself.** It is a live rehearsal of the exact
failure mode CLAUDE.md hard rule #4 exists to contain: *a provider returning
200 OK with unusable content.* An LLM step that "succeeds" and yields nothing
must route to `abstain("assembly failure, manual review required")`, never fall
through onto the money path. That policy was written before this happened; this
is the first evidence it is not hypothetical. P2.3 tests all four paths --
error, timeout, refusal, schema-validation failure -- and this incident is the
concrete argument for the fourth.

---

### F-003 -- appending to `.env` corrupted the API key

**What broke.** `.env`, hand-pasted, had no trailing newline. A shell
`echo >> .env` appended `DATABASE_URL=...` onto the *end of the key line*,
producing one corrupt variable and silently destroying the Groq key.

**How diagnosed.** Printing the file with values masked showed a single line
where two were expected.

**Fix.** Restored from a copy taken before the write, then rewrote the file
through a parser that splits on newlines, filters blanks and re-joins with a
guaranteed trailing newline. Verified by printing key *names* and the key
*length* -- never the value.

**Cost.** ~3 min. Would have cost far more had the copy not been taken first.

**What it taught.** Text-append to a secrets file is unsafe by default. Parse,
modify, rewrite.

---

### F-004 -- `prisma migrate dev` failed at the very end, after succeeding

**What broke.** The migration applied cleanly and the database went in sync,
then the command exited 1 with
`Error: Command failed with exit code 1: pnpm add @prisma/client@6.19.3 --silent`.

**How diagnosed.** Prisma auto-installs its client when missing. In a pnpm
workspace, `pnpm add` at the repo root is refused without `-w`, so Prisma's
convenience step could not succeed.

**Fix.** `pnpm add -w @prisma/client@6.19.3` explicitly, then `pnpm db:generate`.
Being an explicit dependency is the correct end state anyway.

**Cost.** ~2 min. Worth recording because the failure was *reported after the
real work had already succeeded* -- reading only the last line would have
suggested the migration failed, when it had not.

---

### F-005 -- CLAUDE.md's own schema summary was incomplete

**What broke.** Not a runtime failure, but a spec failure caught before it
became one. CLAUDE.md §3 lists `phase` as `chargeback | pre_arbitration |
arbitration` and enumerates the evidence fields. The live docs show `phase` has
**five** values (adding `fraud` and `retrieval`) and the evidence object carries
two fields the summary omits (`cancellation_proof`, `refund_confirmation`).
CLAUDE.md also implies the 1000-character limit belongs to the explanation
letter; it belongs to `summary`, while `explanation_letter` is a list of
document ids.

**How diagnosed.** Followed hard rule #1 -- "when unsure about a field, check
the docs" -- and fetched the pages instead of typing from the summary. A
contract test now asserts the schema's evidence keys equal the doc example's
evidence keys exactly, so this class of drift fails loudly in future.

**Fix.** Implemented the documented schema; recorded the divergence in
DECISIONS.md D-002/D-003 and in `packages/core/src/fixtures/PROVENANCE.md`.

**Cost.** ~15 min of doc reading. Would have been far more expensive discovered
at P2.0, with the drafter already built on three phases.

---

## Session 2 -- 2026-08-30 (P1 synthetic layer)

### F-006 -- the API would not start the way pnpm starts it

**What broke.** `pnpm --filter @praman/api dev` crashed immediately:
`ENOENT ... open 'C:\...\Razorpay\apps\api\.env'`. Starting the same server from
the repo root worked fine.

**How diagnosed.** `process.loadEnvFile('.env')` resolves against
`process.cwd()`. pnpm sets the cwd to the *package* directory, so the API looked
for `apps/api/.env`, which does not and should not exist.

**Fix.** `apps/api/src/env.ts` walks up from `import.meta.url` until it finds a
`.env`, and returns `null` rather than throwing when there is none -- because in
a deployed environment the variables come from the platform and there is no file
at all. Resolving from the module rather than the cwd means the answer no longer
depends on how the process was launched.

**Cost.** ~5 min.

**What it taught.** "Works on my machine" and "works the way the tooling starts
it" are different claims. The second one is the one that matters for P4.3.

---

### F-007 -- the OOD language run died on a free-tier rate limit, halfway through

**What broke.** The first live holdout generation aborted on
`429 ... Limit 8000, Used 7132, Requested 2285` -- Groq's free tier allows 8000
tokens per minute, and the run needed ~15 sequential calls. Everything recorded
up to that point was lost, because the cache was only written at the end.

**How diagnosed.** The error body says exactly what the limit is and how long to
wait: *"Please try again in 10.6275s."*

**Fix.** Three changes, in order of importance:
1. **Persist the cache after every successful call**, not at the end. Losing
   recorded language to an unhandled 429 is self-inflicted.
2. Retry on 429 and 5xx with the delay the provider *itself names*, parsed out
   of its message, falling back to exponential backoff. Six attempts.
3. Reduced `max_tokens` from 2000 to 1200 -- eight short turns never needed 2000,
   and the excess was inflating the per-minute token spend that triggered the
   limit in the first place.

The rerun completed: 9 retries, 15 recordings, no data lost.

**Cost.** ~12 min.

**Why this one matters beyond itself.** It is the second live rehearsal of a
provider failing in a way that is *not* an exception -- first a 200 with empty
content (F-002), now a documented, expected, recoverable 429. Both argue the
same thing: the LLM boundary needs a policy, not a try/catch. On the money path
that policy is abstention; here, where no money is involved, it is backoff. The
distinction is deliberate and is exactly what P2.3's four failure-path tests
encode.

---

### F-008 -- Zod's `coerce` lied to TypeScript, and 14 typecheck errors followed

**What broke.** The capture schema used `z.coerce.date()` for every timestamp.
At runtime it happily accepts an ISO string; in the type system,
`z.input<typeof schema>` reports the field as `Date`. Every caller building a
JSON payload -- which is every caller, since this is an HTTP API -- failed to
typecheck with `Type 'string' is not assignable to type 'Date'`.

**How diagnosed.** The error pointed at the generator, but the generator was
right: it was building JSON, which is what the endpoint accepts. The schema was
misdescribing its own input type.

**Fix.** Replaced `z.coerce.date()` with an explicit
`z.union([z.string().datetime({ offset: true }), z.date()]).transform(...)`.
The static input type now matches what the API really accepts, and requiring an
offset additionally rejects ambiguous local-time strings.

**Cost.** ~6 min.

**What it taught.** A convenience helper that is wrong in the type system is
worse than no helper: it pushes the error to every call site. Worth the four
extra characters to say what is meant.

---

### F-009 -- the holdout guard failed on its own documentation

**What broke.** The static guard asserting "no file outside the allowlist
imports `OOD_CONFIG`" failed, naming `eval/holdout-guard.ts` and
`scripts/seed.ts` as offenders. Both were innocent: each *mentions* `OOD_CONFIG`
in a docblock explaining why it deliberately avoids it. The regex
`/import\s[^;]*\bOOD_CONFIG\b/` matched the word "import" inside a comment,
several lines above the mention.

**How diagnosed.** Read the offending files. Neither had an import statement at
all -- the match was entirely inside prose.

**Fix.** Strip block and line comments before checking, so the guard tests
executable code rather than prose. Added a test for the comment-stripper itself,
since it is now load-bearing for two other tests. Allowlisted the guard's own
test file, which necessarily names `OOD_CONFIG` in the pattern it searches for.

**Cost.** ~8 min.

**What it taught.** This failure was in the safe direction -- a false positive on
a guard, not a false negative -- but the same naivety pointed the other way would
have produced a guard that passes while checking nothing. That is why the suite
now also asserts the glob finds more than ten files: a guard that silently
matches nothing is worse than no guard, because it produces confidence.

---

### F-010 -- the corpus encodes duplicate-charge ground truth in a fact the capture pack never carries

**When.** 2026-08-31, building the P2.2 collector.

**What broke.** Scenario class a3 (duplicate charge) decides its ground truth
from `genuineDuplicate`: two captured payments against one order is unwinnable,
two distinct orders is winnable. But the capture envelope is one order and one
payment. `genuineDuplicate` is written into the corpus metadata and **never into
the evidence pack**. So the collector, looking only at what the store holds,
cannot tell the two apart.

**How it was found.** Writing the `duplicate_payment_analysis` collector and
asking what data it would actually read. There was none. It was not a failing
test -- the tests I had written would have passed either way, which is the part
worth noticing.

**Why it matters more than it looks.** This is a hole in D-011, the rule that
ground truth is derived from generated evidence rather than asserted alongside
it. For a3, the label is asserted. Any system scoring well on a3 would be
scoring on something it could not have known, and the eval would be measuring
the generator, not the product.

**The fix, and the fix not taken.** The right repair is to capture the sibling
payment so a duplicate is visible in the data. That is a capture-schema change,
a migration and a full reseed, at 23:00 on the day of a checkpoint -- and it
would perturb the seeded stream, so the whole corpus and its committed
expectations move with it. Not tonight.

What shipped instead: the collector reports `duplicate_payment_analysis` as
**`not_capturable`**, with the reason stated in the finding, and takes an
optional `relatedPayments` argument that nothing currently populates. It never
answers "no duplicate found". The distinction is the point -- returning "not a
duplicate" from a store that holds one payment per order would be a confident
wrong answer that contests a real duplicate charge, which is a false positive
with a fee attached.

**What it taught.** A ground-truth label that no evidence supports is not a hard
case, it is an unanswerable one, and it will quietly flatter or punish the
system depending on which way the gate happens to lean. The `not_capturable`
state exists because of this bug, and it turned out to be the more useful idea:
"we cannot get this" and "this is missing" are different facts about a dispute
and the gate should not confuse them.

**Consequence, stated plainly.** a3 disputes will systematically abstain. That
costs recall on a3-winnable cases and it will show in the P4.1 numbers. It ships
that way rather than being hidden, and the repair is queued as its own task
rather than rushed tonight.

---

### F-011 -- the model made six correct judgements and the pipeline filed them all as broken plumbing

**When.** 2026-08-31, first live assembly run over 10 dev disputes.

**What broke.** 9 of 10 disputes abstained. Six of those carried
`failureKind: refusal` and the reason "assembly failure, manual review
required". Reading the underlying detail showed the model had not failed at
anything:

> "Charged amount (758600) exceeds the mandate cap (481383). Evidence does not
> support contesting an over-limit charge."

That is the correct answer to a b2 mandate breach. The system reported it as a
malfunction.

**Cause, and it was mine.** The letter-draft prompt used one channel --
`{"refused": true}` -- for two entirely different things: "I decline to perform
this task" and "I performed this task and the evidence does not support a
contest". Hard rule #4 routes a refusal to abstain-with-assembly-failure, so
the second meaning inherited the first meaning's handling.

**Why it mattered more than a mislabel, and this is the part to say out loud.**
It would have **inverted the product's central claim.** Merits-abstention is not
a side effect of this system; it is the judgement the system exists to make.
Hard rule #7 is "abstention over bluffing" and the corpus is 62%
unwinnable-or-ambiguous precisely so that abstention quality is the thing under
test. Filing that judgement alongside provider 500s would have reported the
product's best behaviour as its worst -- and P4.1's headline would have read as
a system that fails 60% of the time, while the truth was a system that was right
60% of the time in exactly the way it was designed to be.

The metric would not have been merely wrong. It would have pointed the opposite
way from reality.

**Fix.** The merits judgement got its own contract: `insufficientEvidence`, a
distinct abstention reason ("evidence insufficient to support a contest"), a
distinct audit step (`declined_on_merits`), and no `failureKind`. `refused`
stays exactly what hard rule #4 means by it. Prompt version bumped 1 -> 2, which
invalidated the recordings, which is the record/replay design working as
intended. A test asserts the two abstention classes never collapse into one.

After the fix, the same 10 disputes: 4 assembled, 6 abstained on the merits,
0 assembly failures.

**What it taught.** A failure taxonomy is only as good as the channels feeding
it. The four failure paths were right and well tested; the bug was upstream, in
a prompt that overloaded one JSON key with two meanings. Tests of the failure
paths could not have caught it -- they proved a refusal abstains, which it did.
What caught it was reading the detail line of a passing-looking run, which is an
argument for printing reasons rather than counts.

---

### F-012 -- the rate-limit lesson from F-007 was fixed in one place and not carried anywhere else

**When.** 2026-08-31, same live assembly run.

**What broke.** `groq 429: Limit 8000, Used 7670, Requested 835. Please try
again in 3.7875s.` Four agentic disputes abstained with `failureKind: error`
purely because the account's tokens-per-minute ceiling was reached mid-batch.

**The part worth admitting.** This is F-007 again. F-007 was the same provider,
the same limit, the same error body naming the same wait, and its fix -- retry
using the delay the provider names -- was written into the corpus generator
five hours earlier. `packages/llm` was written afterwards and did not have it.
The lesson was recorded and not generalised.

**Fix.** `withRateLimitRetry` in the provider layer: 429 and 5xx only, bounded
at four attempts, delay taken from the provider's own message where it names
one, and `attempts` returned on the response so a retried call is visible rather
than silent.

**Why this is not a hard-rule-#4 violation, stated because it looks like one.**
The short version, because a skimming reader sees "retry" next to "rule 4" and
needs the reconciliation immediately: **retry happens at the transport layer,
abstention happens at the semantic layer, and they are different altitudes.**
Transport asks "did the request get served?" Semantics asks "was the answer
usable?" Rule #4 governs the second and says nothing about the first.

Rule #4 forbids silently retrying a *failed LLM step* onto the money path. A 429
is not a failed step -- the model never ran, no output exists, nothing is being
papered over. Retrying completes a request that was never served; it does not
re-roll a result we disliked. The three constraints that keep it inside the
rule's intent: transport statuses only, before any model output exists, bounded
and reported.

**What it taught.** Writing the failure down is not the same as fixing the
class. F-007's entry named the mechanism precisely enough that the second
occurrence took two minutes to diagnose -- and the entry did not stop the second
occurrence, because nothing generalised it into the layer written next. The
retry now lives in the provider interface, so any future provider inherits it
rather than rediscovering the limit.

---

### F-013 -- a convenience line in an API route defeated the one-door rule, and every test still passed

**When.** 2026-09-01, first end-to-end run of the approve-and-submit loop.

**What broke.** This, against the live API:

```
POST /review/disputes/dsp_dev-v1_b1_64/approve  {"approvedBy": "system"}
-> {"state":"submitted","simulated":true,"documentCount":10}
```

A contest was drafted, approved and submitted with **no human involved at any
point**. That is CLAUDE.md hard rule #2 -- "the submit path has exactly one
door" -- broken outright, on the money path.

**Cause.** One line in the route layer, written to be helpful:

```ts
const actor = approvedBy.startsWith('human:') ? approvedBy : `human:${approvedBy}`;
```

Every downstream guard then passed, correctly, on the input it was given.
`AuditTrail.append` checked `isHumanActor('human:system')` -- true.
`ApprovalToken.approve` checked the `human:` prefix -- present. Both did exactly
what they were written to do. The prefix was proof of humanity, and the layer
above manufactured the proof.

**Why the tests did not catch it.** They tested the guard, not the path. Two
tests asserted that `ApprovalToken.approve(id, 'system', ...)` throws, and it
does. Nothing exercised the guard **through the route**, which was the only
place the string got rewritten. A unit test of a check cannot see a caller that
satisfies the check dishonestly.

**Fix, at both layers.**

1. The route no longer prefixes anything. A caller that cannot produce a real
   reviewer identity does not get one manufactured for it -- it gets a 400.
2. `ApprovalToken` now validates the **name behind** the prefix against a
   reserved list (system, gate, llm, adapter, bot, automation, ...), because the
   prefix is trivially addable and therefore proves nothing on its own.
3. Four regression tests, including one asserting that `human:systems-team-anita`
   still works -- the check is on the whole name, not a substring, so tightening
   it did not make it paranoid.

Verified after the fix, against the running API: `system`, `human:system`,
`human:`, `human:bot` and `""` are all refused with distinct messages;
`human:wasih` submits.

**What it taught.** Two things, and the second is the uncomfortable one.

The mechanical lesson: a guard that reads a *format* is not a guard. `human:` is
a shape, not an identity, and any layer above can produce the shape. The check
now looks at what the string means, not what it looks like.

The lesson about my own testing: I had written the invariant into the type
system (`ApprovalToken` has a private constructor), into the state machine
(`approved` requires a human actor), and into a source-tree test (eval cannot
import the adapter) -- three independent mechanisms, all correct, all passing,
and the rule was still broken by a caller that satisfied all three. **Defence in
depth is worth nothing if every layer trusts the same string.** The bug was
found by curling the endpoint with a hostile value, which no unit test in this
repo was ever going to do. Route-level adversarial tests are now owed for
anything on the money path.

---

### F-014 -- adding an optional field broke every dispute that did not have it

**When.** 2026-09-01, first API run after P4.0(a) added the refund slot to the
capture envelope.

**What broke.** 85 of 97 disputes failed to process:

```
POST /review/run?states=drafted,abstained&limit=200
-> {"processed":97,"counts":{"error":85,"abstained":7,"drafted":5}}

  "message": "Unrecognized key(s) in object: 'refund'"   path: ["order"]
```

The 12 that succeeded were **exactly the 12 a4 disputes** -- the only ones that
actually have a refund. Everything the new feature did not touch was broken by
it, which is the opposite of the usual direction and the thing that made the
count legible: 85 + 12 = 97, and 12 is the a4 population.

**Cause.** `cleanRow` in `apps/api/src/review.ts` flattens a Prisma row into the
`.strict()` capture envelope, and it identified relation objects to drop **by
inspecting the value**:

```ts
if (value !== null && typeof value === 'object') continue;
```

The `value !== null` guard is there for a real reason: `vpa: null`,
`deliveredAt: null` and `utr: null` are captured facts, and dropping every null
would silently delete evidence. But it means a **null relation** and a **null
column** are indistinguishable. An order with no refund yields `refund: null`,
which sailed through into a schema that declares no such key.

The check had been correct only because every previously-included relation
happened to always be populated. It was never true; it was untested.

**Why the tests did not catch it.** All 203 of them are pure -- corpus in,
collector out -- and nothing round-trips through Prisma. The whole failure lives
in the gap between "the domain logic is right" and "the row the database hands
back is the shape the domain expects", and no pure test can stand in that gap.
The 203 stayed green for the entire time the API was returning errors for 88% of
the corpus.

**Fix.** `cleanRow` now takes the relation names explicitly
(`cleanRow(row, ORDER_RELATIONS)`) and drops by name, because the caller knows
what the relations are and the value never did. The value-shape check stays as a
backstop for a populated relation someone forgot to list -- it cannot catch a
null one, which is precisely why the parameter exists. `ORDER_RELATIONS` is
exported and asserted, so the next relation added has one obvious place to be
registered.

Seven regression tests in a new `apps/api/src/review.test.ts`, and the important
one is deliberately the **null** case: a test that only drops a populated
relation reproduces the original blindness exactly.

Re-run after the fix: `processed 97, errors 0`.

**Cost.** ~20 min, all of it after the feature itself worked.

**What it taught.** Twice now the same shape (D-029): a check that reads like
rigour, passes, and is deciding on the wrong evidence. Here it inferred a
structural fact -- *is this key a relation?* -- from a runtime value that cannot
carry it. Schema questions must be answered from the schema.

The sharper lesson is about test topology rather than about nulls. This repo's
suite is strong precisely where it is pure, and that purity is why it was blind:
**the API round-trip is the only place capture-layer drift is visible, and it
had no test at all.** The pure tests were never going to fail, no matter how
many I wrote. It also matters *when* this surfaced -- the day the corpus was
extended -- because a capture-layer change is exactly the kind of change that
looks finished when the domain tests pass.

---

### F-015 -- I verified a feature against a server I had not started

**When.** 2026-09-01, verifying P4.0(a) end to end.

**What broke.** Nothing in the product. What broke was the verification, which
is worse, because a wrong result is loud and a result obtained the wrong way is
not.

Every request in that session -- the reseed, three pipeline runs, twelve
per-dispute evidence checks -- was answered by **a stale API process left over
from an earlier session, running `ASSEMBLY_MODE=live`**. My own server had died
at startup:

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

I never read the log. I ran `curl /health`, got `{"status":"ok"}`, and took that
as proof my server was up. It proved only that *a* server was up.

**How it surfaced.** Not by looking. `git add -A` showed
`packages/llm/fixtures/assembly.json` modified, and I had not run
`pnpm assemble`. Five new recordings, timestamped inside my run window. Since
replay mode cannot call a model -- `ReplayMissError` is thrown before the
provider is ever reached -- either the client was broken or the server was not
mine.

**How diagnosed.** In the wrong order, which is the part worth recording. I
spent about twenty minutes reasoning about which code path could record in
replay mode: re-read the cache, re-read the client, checked `.env`, checked the
dev script, checked the shell environment, and finally wrote a probe that
constructed the client exactly as the server does and confirmed replay throws.
The code was innocent every time I looked at it. Only then did I read the log
file I had been writing since the beginning, where the answer was line 8.

`Get-CimInstance Win32_Process` then showed **five** `tsx watch src/index.ts`
trees accumulated across sessions. One held the port; the rest were idle.
Because they all watch the same directory, the stale one had hot-reloaded my
edits -- which is why the new `?states=` parameter worked, and why nothing
behaved oddly enough to give it away.

**Fix.**

1. Killed all five watcher trees, confirmed port 3000 free, started one server
   and confirmed **it** bound (`bound cleanly`, no EADDRINUSE in its log).
2. `/health` now reports `assemblyMode`, `recordings`, `startedAt` and `pid`. A
   health check that answers only "ok" answers the least useful question about
   a running process. The mode is also logged at startup, LIVE in capitals.
3. Re-ran the whole verification against the clean replay-mode server:
   **97 processed, 0 errors, and the fixture file byte-identical afterwards** --
   which is the check that actually proves replay made no call.

**Effect on the recordings, stated plainly.** The five entries are genuine live
Groq output on `qwen/qwen3.8-27b` for the five a4 letters whose evidence changed
when the settlement field landed. The diff is **65 insertions, 0 deletions** --
recordings are keyed by request hash, so new evidence mints new keys and
overwrites nothing. They were needed regardless; what is wrong is that they were
minted by accident rather than by an intended `--live` run. No report exists
yet, so the D-023 rule ("re-recording after the report exists is forbidden") is
not breached, and if D-023 chooses Anthropic every recording is regenerated
anyway.

**Cost.** ~25 min, ~20 of it spent suspecting correct code.

**What it taught.** Three things, and the third is the one that stings.

A health check should report what the process *is*, not that it is. `{"status":
"ok"}` is compatible with every version of the truth I needed to distinguish.

The functional result survived -- the same 97/0 and the same 31 contested, twice,
under both modes -- but I did not know that when I wrote it down. **I reported
"verified end-to-end through the running API" without checking whose API it
was.** The claim happened to be true. That is luck, and on the money path it is
the same mistake as F-013: trusting a condition a layer beneath me had actually
determined.

And this is the second time a stale process has cost this project real time. The
first fix was to kill that PID; the lesson was recorded as an incident rather
than as a class, so nothing changed and it recurred within a day. The
countermeasure had to be one a tired person cannot skip, which is why it is in
`/health` rather than in a note telling me to check `netstat` next time.

---

### F-016 -- I wrote a guard for an invariant that already had one, and broke the original

**When.** 2026-09-03, building the P4.1 eval harness.

**What broke.** `packages/adapter/src/adapter.test.ts` -- green since Day 3 --
started failing, reporting `eval/harness.test.ts` as a file that reaches the
submission adapter.

**What actually happened.** Hard rule #2 says eval mode never touches the
submission adapter and that a test enforces it. Building the harness, I wrote
that test. I did not check whether it existed. It did, and it was better than
mine: a static check over the whole `eval/` tree, comments stripped, covering
both the package import and the client class names.

My duplicate then failed the original in the most literal way available. The
original searches stripped source for `@praman/adapter`. My version contained
that string **in executable code** -- inside the regular expression it used to
run the same search. A guard against naming the adapter, caught naming the
adapter.

**How diagnosed.** Immediately, and only because the whole suite was run rather
than the new file alone. `vitest run eval/` was green; `vitest run` was not. The
failing assertion named the offending file.

**The fix.** Deleted the duplicate. The harness test now covers the two things
nothing else owns -- byte-reproducibility of the committed report, and that the
cost model still excludes the disputed amount -- and its docblock says in plain
words that the one-door invariant lives in the adapter test, with a pointer to
it.

**Rejected: allowlisting my test file in the original guard.** That was the
first thing I reached for and it is exactly backwards. The original guard has no
exemptions, and adding the first one to accommodate a redundant test would trade
a real invariant for a duplicate of itself.

**What it taught.** Two things, and the second is the one worth keeping.

First: before writing a test for a rule in CLAUDE.md, grep for the rule. The
hard rules are the invariants most likely to be enforced already, precisely
because they matter most.

Second, and this is D-029's shape again: a static check that searches for a
string cannot live in a file containing that string. The fix is not to exempt
the file -- it is to search for what confers the capability rather than what
names it. The check now matches an import statement rather than a mention, which
is both self-consistent and more precise. A docblock explaining why we must not
reach the adapter is not a way of reaching it.

---

### F-017 -- the demo broke on exactly the case worth demonstrating

**When.** 2026-09-03, first end-to-end run of the deploy path against a live
database.

**What broke.** `POST /demo/release-dispute` twice, then the pipeline over the
two released disputes:

```
demo-dsp_dev-v1_b3_501 -> abstained
demo-dsp_dev-v1_b1_500 -> error
```

The b3 worked. The b1 -- the winnable one, the one the demo exists to show --
threw `ReplayMissError`.

**How diagnosed.** Immediately, because the failure is loud by design. Replay
mode refuses to fall back to a live call, so a missing recording stops the run
instead of quietly producing a different answer. The error named the prompt and
the key.

**The cause is a consequence of a decision that was right.** Released disputes
are generated at indices far above the seeded corpus so a visitor pressing the
button cannot disturb the 100 disputes the eval measures. That isolation is
correct and stays. What nobody followed through is that those indices therefore
have **no recorded model responses**, and the deployed instance runs in replay
mode with no API key.

The asymmetry in which half worked is the whole lesson. b3's mandate is expired,
so the gate declines it and **no model is called at all** (D-025) -- it was
offline-safe for free. b1 clears the gate, so it needs a letter drafted, so it
needs a recording. Every dispute the product would actually contest was the
broken half, and every dispute it declines worked perfectly. A smoke test that
only checked "does the button do something" would have passed.

**The fix.** `scripts/record-demo.ts` walks the release pool on the same
generator, collector, gate and assembler the API uses, and records what the gate
clears -- 9 of 20; the other 11 are gate abstentions that need nothing. Run with
no flag it is a dry run that exits non-zero if any release would miss, so this
cannot silently regress. Recording is additive and on the frozen model of record
(D-023): no scored dispute's key is touched.

That last claim is checked rather than asserted. `eval/results.md` regenerated
after the 13 new recordings is byte-identical -- **except** that the header had
been reporting the fixture file's total size, which is incidental to the run and
made the report change whenever an unrelated recording was added. That number is
now gone from the header, which is the right fix in its own right: a report
should not vary with something none of its numbers depend on.

**What it taught.** The isolation boundary and the replay boundary were each
correct and were designed by different pieces of reasoning, and the bug lived in
the space between them -- which is where F-014 lived too, and F-013. Neither
boundary is wrong; nothing that tests either one in isolation can see it.

The practical rule: when a feature deliberately generates data outside the range
everything else covers, ask what else is indexed by that range. Recordings were.

---

### F-018 -- a blank white page, an empty console, and every check passing

**When.** 2026-09-03, the click-through of the deployed UI -- the first time
anyone had opened the review panel in a browser rather than asserting about it.

**What broke.** The page rendered nothing. White, no error banner, and the
console had **not one message in it**. `curl /` returned the index page with a
200. `curl /health` was fine. The queue endpoint returned 100 disputes. Every
test was green, including the twelve that render the panel to static markup.

**How diagnosed.** By asking what the page asks for that a `curl /` does not.
The index it served referenced `/assets/index-Ee_RABDo.js`; that file was on
disk; requesting it returned **404**.

`@fastify/static` had been registered with `wildcard: false`, which makes it
enumerate the directory and register one route per file **at boot**. The route
table is therefore a snapshot of the directory as it was when the process
started. The UI had been rebuilt after the server started, Vite hashes its
filenames, and the new names were in no route table.

Nothing misbehaved. The SPA fallback did exactly what it was written to do:
refuse to serve HTML for a path with a file extension, because returning a page
where a script was requested is the classic version of this bug and produces
`Unexpected token '<'` from somewhere unrelated. It correctly 404'd. The result
of every component behaving correctly was a blank screen.

**The fix.** Drop `wildcard: false` and let the plugin resolve each request
against the disk. A wildcard cannot go stale. Six behaviours re-verified after
the change: index, a real asset, a missing asset, an SPA route, an API route,
and an unknown API route -- 200, 200, 404, 200, 200, 404, with the right content
types.

**Why it did not bite in production, and why that is not a defence.** The build
phase runs before the start phase on any host, so a deployed instance never has
a stale snapshot. The bug was reachable only by rebuilding the UI against a
running API -- which is exactly what a person preparing a demo does, at the worst
possible moment, having changed one line of copy.

**What it taught.** This is the entry that justifies the click-through being a
task rather than a formality. The suite renders the panel to markup against real
captured payloads and it is a good suite -- it simply cannot see whether the
browser ever receives the bundle. There was no console message to find, no
failing test to chase, and no server error: the only signal this bug produced
anywhere in the system was pixels, and the only way to read pixels is to look.

Second, smaller: the same session replaced a `window.alert` on the approve path
with an inline notice. A modal blocks the page until dismissed, which makes the
one action that matters the one thing a screenshot, a screen recording or an
automated click-through cannot get past -- and it covers the state change it is
announcing. It was found for the same reason: someone finally clicked the button.

---

### F-019 -- the fact-check found a dropped clause in the docs, and the fix uncovered a second bug behind it

**When.** 2026-09-03, the P5.4 fact-check pass, re-reading every citation
against its live source.

**What broke, first.** The published evidence guidance for **UPI 128** has three
clauses. This repository's transcription carried two:

```
have:  Internal logs to show authorisation was obtained,
       Invoicing details along with detailed price breakdown
docs:  ... , Proof of service/goods delivery clearly mentioning
       customer name and address details
```

Hard rule #1 is explicit -- "never invent fields, and **never omit documented
ones**" -- so this is a violation of the rule the project treats as
non-negotiable, sitting in the reason code the entire agentic module runs on.

**How diagnosed.** By reading the page again rather than trusting the copy. The
first reading returned the third clause merged into the 128 row, which is
exactly what a careless extraction looks like, so it was checked a second time
with the rows forced apart -- 1064's evidence cell is worded differently
("Terms & Conditions on refund & fulfilment policies"), so the delivery clause
really does belong to 128 and is not bleeding across from its neighbour. Worth
recording that the check was doubted before it was acted on: a schema change on
the last day, on the strength of one summary of one page, is how a fact-check
introduces the error it was meant to catch.

**The fix, and the judgement inside it.** `delivery_proof` is added to 128 as
**`supporting`, not `required`**, and that necessity is ours rather than
Razorpay's (D-026). A fraud claim on an agent-initiated payment is answered by
proving authorisation, not delivery -- b1's whole premise is that the goods
arrived and the customer disputes having asked for them. Making delivery proof
required would abstain on cases the mandate record already settles: a worse
product for a more literal reading of the same page.

Because it is supporting, the gate's required-coverage is unchanged, and
`pnpm abstentions` produced byte-identical output before and after. That was
checked **before** any recording was re-minted, because the alternative was
discovering the blast radius after spending it.

**What it cost, exactly.** Every UPI 128 prompt changed, so every 128 recording
missed and was re-minted on the frozen model of record. Headline metrics did not
move at all -- recall 31/38, precision 100%, 0 false positives, 69% abstention.
The only number that moved is **evidence completeness: 2.19 -> 2.61 Razorpay
fields populated per draft on dev, 2.38 -> 2.75 on the held-out set**, because
`delivery_proof` now routes into the real `shipping_proof` field. Correcting the
omission did not just restore fidelity; it made the contests materially
stronger, and the snapshot shows a letter that now cites a delivery proof by id.

**The second bug, which the first one exposed.** With 128 re-recorded, the batch
reported something it never had before: **an assembly failure**, one, on the dev
set, kind `schema`. The prediction in CLAUDE.md was that a real failure would
surface during a batch run. One did. It was ours.

`dsp_dev-v1_b1_66` returned a perfectly well-formed
`{"insufficientEvidence": true, "reason": "..."}` -- the documented alternate
contract, a correct judgement on the merits -- with a reason **532 characters**
long against a `max(500)` bound. The alternate schema rejected it, the payload
fell through to the letter schema, and a correct abstention was filed as
`assembly failure, manual review required` **in a committed eval report**.

That is F-011 exactly, thirty-two characters wide. F-011 was: the model made six
correct judgements and the pipeline filed them all as broken plumbing. The fix
then was to model declining as a legitimate outcome. The bound on the reason
string was never revisited, so the same failure came back through the one part
of the contract that had not been thought about.

The diagnosis also cost twenty minutes to an unrelated cause: the error read
`letter: Required; Unrecognized key(s) in object: 'insufficientEvidence'`, which
describes a model that ignored the contract, when it had followed it exactly.
When the alternate parse fails, the message came from the *other* schema.

**Both fixed.** `reason` is capped at 2000 rather than 500 -- it is our own free
text for a human reviewer, no Razorpay field, nothing downstream parses it, and
no documented limit applies, so the tight bound bought nothing and cost a
misfiled outcome; the guard is kept, generously, well outside the range a real
answer occupies. And when a payload was clearly aimed at the alternate shape,
the failure now reports the alternate's error. Three regression tests: a
900-character decline is a judgement, a 5000-character one is still refused, and
the message names the schema the model was aiming at.

**What it taught.** Two things.

A bound with no external source is a bound nobody will re-derive when it starts
lying. `max(1000)` on the letter is Razorpay's number and belongs in the schema;
`max(500)` on our own explanation was a number someone typed once, and the only
thing it ever did was misfile a correct answer.

And a fixed bug does not stay fixed by having been fixed. F-011's lesson was
recorded in a docblock directly above the schema that caused F-019 -- the
sentence was right there, and it did not extend to the field two lines below it.
The lesson generalises further than the fix did, which is an argument for
reading old FAILURES entries as constraints on new code rather than as history.

### F-020 -- a fixed-row grid handed its growing row to the wrong child

**When.** 2026-09-03, first browser check of the redesigned console (D-040).

**What broke.** The decision bar -- the region that carries the approve door --
did not appear at all, and the evidence workbench started immediately under the
top bar. Every test passed, `typecheck` and `lint` were clean, and the
components each rendered correctly in isolation.

**How it was diagnosed.** Looking at the screenshot rather than the DOM first,
I misread it as horizontal clipping and nearly went hunting for an overflowing
child. Measuring instead of guessing settled it in one call:
`document.documentElement.scrollWidth === window.innerWidth`, no element with a
`right` beyond the viewport, and `devicePixelRatio: 1.25` -- Windows display
scaling, not browser zoom. Nothing was clipped. The bar was being sized wrong.

The shell was `display: grid` with `grid-template-rows: auto auto minmax(0, 1fr)`
-- three rows, written when the queue view had three children. It has four: the
simulated strip, the top bar, the decision bar and the workspace. React
fragments do not create a box, so the fragment's children became grid items in
their own right. The decision bar landed on row three and took the `1fr`, and
the workspace fell into an implicit auto row below the fold, where
`overflow: hidden` on the shell removed it from view.

**The fix.** A column flex, with every fixed region `flex: 0 0 auto` and only
the scrolling region `flex: 1 1 auto`. Flex sizes by role; a counted
`grid-template-rows` sizes by position, and position is exactly what varies here
-- the strip is present only in demo mode and the decision bar only on the queue
view, so the same template describes four different child counts.

**What it taught.** Row counts in a grid template are an assumption about how
many children there are, and nothing in the type system, the tests or the linter
knows that assumption exists. I had three tests asserting the decision bar
renders its contents, and all three passed while it was invisible on screen --
they render the component, and the bug was in the parent that sizes it. A
component test cannot see a layout bug, and I should stop treating a green suite
as evidence that a page looks right.

### F-021 -- the demo's one submitted dispute is approved by `human:system`

**When.** 2026-09-03, reading the redesigned audit trail in the browser.

**What broke.** Nothing in the running product -- this is a stale test fixture,
but it is a stale test fixture that renders in the demo.

`apps/ui/src/__fixtures__/disputes.json` and `queue.json` carry
`approvedBy: "human:system"`, and the audit trail's `approved` row names the
same actor. These are captured API responses, taken on 2026-08-31 -- **before
F-013 was fixed**. F-013 is the failure where `approveAndSubmit` prefixed
whatever it was handed, so `approvedBy: "system"` became `human:system` and
passed every downstream check. The fixture is a recording of that bug.

**Why the redesign surfaced it.** The old UI rendered the trail into a `<pre>`
and the actor was one column of text in a blob. The new trail gives the actor
its own column and marks the single human in it with the accent colour --
specifically so a reviewer can read down and confirm a human appears exactly
once. That change made the one value that should never appear there the most
prominent thing in the panel.

**Status: open, and deliberately not hand-edited.** Editing a captured response
by hand would make it a hand-written fixture that claims to be a capture, and
`render.test.ts` rests on that provenance -- the fixtures are trusted precisely
because nobody typed them. The honest fix is a recapture against a running API
with a real reviewer identity, which needs Postgres up. Logged here rather than
quietly patched, and flagged for the demo: **the submitted sample dispute shows
an approver that the current code would reject.**

**What it taught.** A fixture captured before a fix keeps the bug alive
somewhere the tests do not look. F-013 was closed in the product and stayed open
in the demo data for three days, and it took a redesign that made the actor
prominent for anyone to notice.

### F-022 -- the address bar and the page disagreed after a back button

**When.** 2026-09-03, first navigation test of the new `/` landing page and the
`/app` and `/eval` routes.

**What broke.** Pressing back from `/eval` put `/app` in the address bar and
left the eval report on screen. Pressing back again did not reach `/` at all.
Both symptoms, one cause.

**How it was diagnosed.** Not by looking -- the page still rendered something
plausible, which is why this class of bug survives a visual check. It was found
by scripting the navigation and asserting on three things at once at each step:
the path, the document title, and which of the three pages had actually
rendered. The row that gave it away read `path: "/app"` with `queue: false` and
`report: true`.

The console took `initialView` as a prop and did `useState(initialView)`.
`useState` uses its argument only on the first render, so once mounted the
component ignored every later value. React does not remount `App` when the route
changes from `eval` to `console` -- it is the same component in the same
position -- so the prop changed, the state did not, and the two sources of truth
for "which page is open" drifted apart. The second symptom followed from the
first: with the view stuck, the eval tab stayed visually active and the next
interaction pushed another history entry.

**The fix.** Delete the state. `view` is a prop and `onView` calls `navigate`;
`Root` derives the view from the route and hands it down. There is now exactly
one thing that knows which page is open, and it is the URL. Five tests pin the
route mapping as total and reversible.

**What it taught.** `useState(someProp)` is a copy, not a binding, and it is
worth reading as "seed once, then ignore" every time it appears. The real lesson
is about how I checked: I had clicked through these routes by hand and they
looked fine, because a page that renders the wrong thing still renders. Asserting
the URL and the rendered page together in one script found in seconds what
looking had missed twice.

---

### F-023 -- the honesty rule was broken in the decision log, under the first link a reader follows

**When.** 2026-09-04, reviewing what was left before the deploy.

**What broke.** D-036, the entry that argues for stating the free plan's costs
out loud, contained a claim that was itself false. It said the free plan
"includes 750 instance-hours a month against 744 in the longest month, so
keeping the one service warm is inside the published allowance rather than a
trick played on it." No mechanism existed for keeping anything warm. The
sentence described a mitigation that had never been built.

This is a hard-rule-#6 violation, and its location is what makes it worth an
entry rather than a quiet edit. It sat two paragraphs below a bullet explaining
that a reader who waits sixty seconds for a blank page and was told nothing has
been misled by omission -- inside the entry governing the link the README opens
with, which is the first thing a screener follows.

**How it was diagnosed.** By re-reading Render's own free-plan page instead of
the note taken from it a day earlier. The arithmetic was right and the inference
was backwards: the page states that spun-down services do not consume Free
instance hours at all, so an hours allowance can never be what keeps a service
awake. It is a budget for running, not a mechanism for staying up. Two correct
facts had been joined by a "so" that did not hold, and the join is the part that
made a claim out of them.

**The fix.** Build the mechanism the sentence assumed, then rewrite the sentence
to point at it. `.github/workflows/keep-warm.yml` pings `/health` every five
minutes against a fifteen-minute idle threshold, so two consecutive scheduled
runs can be dropped and the service still never goes idle -- GitHub documents
its schedules as best-effort, so the interval is chosen for slack rather than
frequency. D-042 states the arithmetic that makes running continuously
defensible, including its precondition: 744 hours fits inside 750 only because
this workspace runs exactly one service. The old sentence is quoted verbatim in
D-036 above its correction rather than overwritten, because a decision log that
edits its own mistakes out is worth less than one that shows them. The README's
first line and SUBMISSION.md now say a ping keeps it awake *and* that a missed
ping still costs about a minute, since the mitigation is best-effort and a
promise of uptime would be the same error again in a better disguise.

**What it taught.** The dishonest sentence was not written to deceive; it was
written to close a bullet that felt unfinished. Two verified facts and a
connective are enough to manufacture a claim nobody checked, because the facts
survive fact-checking individually and the "so" between them is not a fact and
does not get checked at all. P5.4's pass verified every citation in this
repository and walked straight past this, which says the pass was aimed at
sources rather than at inferences. The other half: the claim was in the entry
about being honest concerning deploy costs. The document most likely to be read
as already handled is the one that argues it has handled it.

---

### F-024 -- every deadline in the console read as months overdue, and 266 tests agreed

**When.** 2026-09-04, running the console locally to look at the redesign.

**What broke.** All 102 disputes in the review queue showed a red expired
deadline -- `57d over`, `60d over`, `61d over`. Not one row had time left. The
deadline meter, which exists so a reviewer can see which dispute to answer
first, was a solid column of red that said nothing about any of them.

Deadline-awareness is in the product's own one-line description. The queue is
sorted by `respond_by` ascending specifically so the most urgent dispute is
first, and there is a comment in `Queue.tsx` explaining that this ordering is a
property of the queue rather than a view preference. Sorting 102 equally blown
deadlines ranks nothing.

**How it was diagnosed.** By reading the two ends of the subtraction. `respondBy`
came from `generateDispute`, which offsets from `CORPUS_EPOCH` -- a hard-coded
`2026-06-01`, deliberately fixed so the corpus is reproducible, with a test
asserting no generated instant comes from `Date.now()`. The other end came from
`daysUntil`, which read `Date.now()`. The corpus's clock stopped and the real one
did not, so the gap between them widened by one day per day. On 2026-09-04 the
whole corpus had aged 25 to 100 days past its response windows.

Both halves are individually correct, which is why this survived. The fixed epoch
is load-bearing for eval reproducibility -- a wall-clock base would change every
prompt hash and silently invalidate the committed replay fixtures (D-007), and a
test guards it. `Date.now()` is the right clock for a real dispute. The defect is
only visible where they meet, and nothing looked there.

**The tests were no help, and that is the interesting part.** 266 of them passed
while this was on screen. The deadline test computed its own fixtures with
`Date.now() + 2 days` and asserted `daysUntil` returned 2 -- true, and true no
matter how stale the corpus got, because the test never used corpus data. It
tested the subtraction and not the pairing. This is the same shape as F-022: a
component that renders the wrong thing still renders, and an assertion that
manufactures both of its inputs can only confirm arithmetic.

**The fix.** The data is simulated, so the clock it is read against is simulated
too, and labelled the same way (hard rule #6).

- `CORPUS_NOW` sits beside `CORPUS_EPOCH` in the simulator: epoch + 50 days,
  which lands inside the corpus's own `respond_by` spread of 35 to 147 days.
  Fourteen disputes are genuinely overdue, seven sit inside the urgent window,
  eighty-one have room. That is the shape of a real response queue.
- The server reports it on `/health` as `simulatedNow`, for the same reason it
  reports `demoMode` rather than letting the UI infer it: the front end cannot
  know whether the rows it was handed are seeded, and a banner the client
  switches on for itself is a banner that can be wrong.
- `daysUntil(iso, now)` takes the instant as a **required** parameter. A default
  would have let every existing call site keep the bug; `null` still means real
  time, but it has to be written out on purpose.
- The console labels the clock in the top bar next to `assembly: replay`, and
  every deadline's tooltip names the instant it counted from.

**Four tests, aimed at the pairing rather than the arithmetic.** Three in
`corpus.test.ts` assert the shape of the queue a reviewer sees -- that both
overdue and open disputes exist, that the clear majority are still answerable,
and that at least one sits in the urgent window the meter colours. They fail if
the generator's timeline moves, which is exactly when `CORPUS_NOW` needs
re-deriving. One in `render.test.ts` renders a real corpus dispute and asserts
the bar says `d left` and not `d over`.

**What it taught.** Two correct decisions can produce a broken screen at the
seam between them, and the seam is where nobody writes tests, because each side
already has its own. The specific trap: a test that constructs its inputs from
the same clock it is checking cannot fail. `Date.now() + 2 days` was always going
to be two days away.

And the reason it went unnoticed for a week is that it never looked broken. Red
overdue badges look like urgent work, not like a bug -- there is no error, no
blank space, nothing missing. It took someone opening the console to *look
around* rather than to check something specific. That is an argument for the P5.6
dry-run, not against the test suite.

---

### F-025 -- fixing a schema-fidelity bug moved a headline OOD number, and the fix wasn't free

**When.** 2026-09-05, closing an adversarial review's rubric-provenance finding
(seven UPI codes wrongly marked `hasPublishedGuidance: false`, plus omitted
published items on 1061/1062/1064/128 -- see below and DECISIONS.md's
amendment to D-023).

**What broke.** Not code. `reason-codes.ts`'s own docblock claimed "transcribes
the UPI section in full" while `evidenceGuidance` sat `''` for seven of eleven
UPI codes, and rubric.ts's `hasPublishedGuidance: false` for those seven
correctly mirrored that gap -- so the guard checking rubric.ts against
reason-codes.ts was self-consistent and still wrong, because reason-codes.ts
was the file with the omission. Exactly D-029's pattern, in a file whose whole
job is to prevent it, caught by a reviewer checking the live page directly
instead of trusting either file.

**The fix.** Filled in the missing `evidenceGuidance` (as a verbatim string
*array*, not a comma-joined string -- 1085's own published text contains an
internal comma, which the old join-then-split test logic would have silently
mis-parsed had it ever been asked to carry it). Added the missing published
items across five UPI codes, all `supporting` unless a requirement already
`required` covered the identical fact, in which case only its provenance
changed. Added the reverse-direction test D-029 had never gotten around to for
this file: a code marked `hasPublishedGuidance: false` must have no guidance in
the source-of-truth table, not just no `published` requirement in the rubric.

**Verified stable, one set:** `pnpm abstentions` (gate only, no model) on the
dev corpus before and after: 33 contested, 31/38 recall, the same seven named
lost-recall cases, byte-identical. Necessity for every `required` item was
untouched, so gate coverage could not move and did not.

**Verified NOT stable, the other set.** `pnpm eval -- --live` (needed because
the changed rubric changes the prompt hash for every code it touches) re-minted
recordings for the newly-published codes. Dev headline numbers came back
unchanged. **Held-out did not:** recall dropped 7/9 (77.8%) -> 6/9 (66.7%),
abstention rose 73.3% -> 76.7%. One case flipped -- `dsp_ood-v1_a4_14`, UPI
1061, ground truth `winnable` -- from contested to a new `drafter_disagreement`.
The model's own recorded reason:

> "Missing customer_communication and merchant_refund_policy. Evidence only
> proves a refund was processed, not that the original transaction was valid
> or that the dispute reason (upi 1061) is resolved by the refund."

**Why this happened.** Adding `customer_communication` and
`merchant_refund_policy` to 1061 as `supporting` (never `required`) put two new
`not_capturable` findings in front of the drafter for this case that were not
there before the fix. The drafter treated their absence as disqualifying --
which is precisely the confusion D-026 exists to prevent ("necessity is our
judgement, not Razorpay's, and `supporting` means a contest can stand without
it"). The gate agreed the case was sufficient; the model, reading a longer list
of gaps, second-guessed it anyway.

**Why it is reported rather than absorbed.** This is not F-019's shape. F-019's
re-recording moved a sub-metric (evidence completeness) and left every headline
number untouched, which is what made "verified byte-identical, headline
numbers unmoved" a true sentence to write. This one does not get to make that
claim, and saying otherwise -- or quietly re-running until a case landed the
old way -- would be the exact dishonesty hard rule #6 exists to catch. The
direction is the safe one (D-025: the drafter's worst case is excess caution,
never excess claim, and this case only ever lost a contest, never gained one),
but "safe direction" is not "no cost," and a −11.1-point OOD recall swing from
a one-line rubric fix is a real number, reported as it reads.

**Not fixed today, named instead.** The deeper issue is a prompt-level one --
the drafter should weigh a `supporting`-and-absent finding differently from a
`required`-and-absent one, and right now it does not, because necessity is a
rubric-level concept the drafter's prompt never receives. Patching that is a
prompt-version bump, a re-verification of every recorded letter and flag on
both sets, and its own review -- not a same-session fix bolted onto a
provenance correction. Recorded here as the concrete argument for doing it,
rather than fixed under time pressure the way P4.0(b) was correctly *not*
fixed under time pressure (D-033).

**What it taught.** A fix scoped as "add missing published items, all
`supporting`, so necessity cannot move" is true about the **gate** and was
verified true about the gate. It is not automatically true about the
**drafter**, which reads the same findings without the gate's required/
supporting distinction attached to them. "Cannot change gate coverage" and
"cannot change the pipeline's output" are different claims, and this file
exists because the difference between them cost a real number.

**Addendum, same session: fixing the number exposed a taxonomy bug underneath
it.** `eval/abstentions.ts`'s `attributeAbstention` labels any winnable,
full-required-coverage abstention `false_negative` -- correct when it is the
gate that declined, because it means "the gate was wrong" (D-030). It cannot
see whether the abstention actually came from the gate or from the drafter,
because it is only ever given `collected` evidence, not the pipeline's
`abstentionClass`. Running the pinned regression tests after this fix caught
it immediately: `dsp_ood-v1_a4_14` is a `drafter_disagreement` (the gate
cleared it), and it was about to be reported as `false_negative` (the gate
did not). That is exactly the D-025 distinction this project has already
paid for once (F-011: a merits decline filed as broken plumbing) --
here it would have been the opposite direction, a sanctioned drafter veto
filed as a gate defect, in the metric whose entire job is to say the gate is
never wrong when it demonstrably held. Fixed by adding a sixth cause,
`drafter_veto`, and reassigning at the one call site (`eval/harness.ts`)
that actually knows which component decided -- `eval/abstentions.ts`'s
gate-only score is untouched, and cannot ever produce the new cause, because
no drafter runs there to blame. The floor test
(`false_negative` pinned at 0 on both sets) stays true, and now means what
its own name says, rather than meaning it by coincidence.

---

### F-026 -- a reset-and-replay against the live demo desynced the audit trail, and blamed the actor for it

**When.** 2026-09-05, an adversarial review's live pass against the deployed
instance (`https://praman-zif9.onrender.com`): reset the demo, released a
batch of demo disputes, reprocessed the queue, then attempted to approve a
freshly-drafted seeded dispute.

**What broke.** `POST /demo/reset` correctly appended a `demo_reset` row and
put `dsp_dev-v1_b1_64` back at `received` -- verified append-only, exactly as
designed. `POST /review/run?states=received` then correctly reprocessed it:
the DB row came back `state: "drafted"`, `gateDecision: "contest"`, a real
draft attached. But its audit trail, fetched right after, was still **five
rows long, ending at the reset**. Approving it -- with a real actor,
`human:wasih`, not a spoofed one -- was refused:

> `{"error":"approval_refused","detail":"illegal transition received -> approved by human:wasih"}`

The message blames the actor. The actor was never the problem: the persisted
trail genuinely still said `received`, because nothing after the reset had
ever been written to it, even though the dispute had visibly gone through
triaged -> gated -> drafted a second time.

**Cause.** `packages/llm/src/pipeline.ts`'s `processDispute` always builds
`new AuditTrail(...)` and hardcodes its first step as `toState: 'received'`
at seq 0 -- it has no way to know whether this dispute has ever been through
the pipeline before, by design (it is also called from scripts with no
database at all). `apps/api/src/review.ts`'s old `persistTrail` then wrote
only `trail.list().slice(existingRowCount)`. The first time a dispute is
processed, `existingRowCount` is 0 and the slice is everything -- correct,
by coincidence. The moment a dispute gets a **second** cycle -- a demo reset,
or the documented `?states=drafted,abstained` reprocessing `/review/run`
already supports for exactly this reason (P4.0(a) used it) --
`existingRowCount` (5) exceeds the fresh trail's own length (4), the slice is
empty, and every subsequent write silently vanishes while `dispute.state`
keeps moving. No error, anywhere, at any point -- the shape F-018/F-020/F-022/
F-024 all share: everything that could throw stayed silent, and the only
symptom was a fact about the world (the trail) disagreeing with a fact in the
database (`state`).

**Why the demo's own reset button is what surfaces it.** Every one of the 100
seeded disputes is normally processed exactly once, so `existingRowCount` is
always 0 in the ordinary run and the bug has no way to appear. The reset
button exists specifically to invite a second cycle -- reset, then show the
pipeline running again -- which makes it, structurally, the single feature
most likely to trigger this, on the one surface a judge is invited to click.

**Fix.** `AuditTrail` gets a new operation, `rewindToReceived(actor, reason,
occurredAt)`: not a legal forward transition (there is no path back to
`received` in `TRANSITIONS`, on purpose), but an honestly-recorded fact that
a new cycle is starting -- the same shape of row `resetDemo` already writes
for its own `demo_reset` entry, now available as a first-class trail
operation rather than a raw insert one caller happened to get right.
`runPipeline` now rebuilds the trail from whatever is actually persisted,
rewinds it explicitly if the dispute is not already at `received`, and
replays the fresh cycle's steps on top with seq numbers continuing from where
the real trail left off -- never restarting at 0. `rewindToReceived` refuses
from `approved` or `submitted`, and `runPipeline` refuses to even start
processing either state, so a reprocessing run can never silently overwrite
the one record of a human's real decision or a real submission.

**Verified.** `packages/core/src/domain/lifecycle.test.ts` reproduces the
exact live sequence -- full cycle, rewind, second full cycle, then a real
human approval -- and asserts it now succeeds with correct seq numbering
(19 tests, lifecycle.test.ts). `pnpm typecheck`, `pnpm lint` and the full
suite pass. Not yet re-verified against the live instance itself, because the
fix has not been deployed; the live reproduction above is the record that the
bug was real, not a claim that the fix has been.

**What it taught.** The docblock directly above `runPipeline`'s call site
already said, correctly, that reprocessing a `submitted` dispute would "walk
its state backwards while its audit trail still says submitted" -- the risk
was named in a comment before this fix existed, and the comment did not
prevent it, because naming a risk is not the same as guarding it. And this is
D-029's shape again, in yet another mechanism: `persistTrail`'s
count-based diffing read like a correct incremental-append pattern and
*was* correct, for the one case anyone had tested. It had never been asked
what happens on a second cycle, so nothing had ever made it fail -- exactly
the question D-029 says to ask of any guard before trusting it.
