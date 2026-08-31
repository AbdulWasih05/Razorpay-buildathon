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

**Why it mattered more than a mislabel.** P4.1 reports abstention rate broken
down by reason, and the whole point of that breakdown is to separate "the system
judged correctly" from "the system broke". Shipping this would have put the
product's best behaviour -- abstention over bluffing, the thing the corpus is
built to test -- in the same bucket as a 500 from the provider. The headline
number would have read as a system that fails 60% of the time.

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
