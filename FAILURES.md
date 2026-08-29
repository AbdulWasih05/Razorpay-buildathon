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
