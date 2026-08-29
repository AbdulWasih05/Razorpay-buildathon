# Razorpay AI Buildathon — Sprint Gameplan
**Builder:** Abdul Wasih (solo author, solo defender) · **Advisor:** Usman (architecture challenge + daily review, zero authorship)
**Track:** 02 — AI Risk Manager · **Deadline:** Sep 5, 2026 · **Target submission:** Sep 4, EOD

---

## 1. The Thesis (verified, no stretch)

Razorpay's agentic payment pilots (Claude/NPCI with Zomato, Swiggy, Zepto; Gnani voice; in-app pilots) are creating a new dispute class: transactions where the "customer" was an AI agent operating under a Reserve Pay mandate. Razorpay's own public position is that liability rules don't change — the merchant handles the dispute. But the traditional evidence a merchant would use (click trail, device fingerprint, session behavior) doesn't exist for agent-initiated purchases. What exists instead is structured: the mandate consent record, spending limit, agent conversation trace, and orchestration audit trail.

**The product:** a defense-only dispute evidence responder that handles ordinary e-commerce disputes today, with agent-initiated disputes as its differentiated module. Core insight (from adversarial review, Aug 29): the agentic evidence — agent identifier, mandate reference, protocol metadata, conversation context — must be **captured at transaction time**, because at dispute time the trace is unrecoverable; it lives with the agent platform/TPAP, not the merchant. The transaction store is therefore the product's capture layer, not a simulated given. Praman ingests dispute events in Razorpay's exact Disputes API schema, assembles evidence from the capture store, decides contest-vs-abstain through a sufficiency gate, drafts the contest mapped to Razorpay's typed evidence fields (`access_activity_log`, `customer_communication`, `explanation_letter`, etc.), and submits only through a human-approved, deadline-aware, draft-first flow.

**Verified (Aug 29):** UPI disputes DO surface in Razorpay's merchant-facing dispute system — the submit-evidence docs contain an explicit UPI reason-code/evidence section alongside Visa/MC/Rupay/Amex, and issuing banks raise chargebacks per card-network/UPI rules through the merchant surface with evidence deadlines. Thesis stands on original rails, now with citation.

**Positioning vs. their roadmap:** Agent Studio already ships a chargeback evidence responder agent. Praman is the agentic-era specialization of a product line they already believe in — the version of their evidence agent built for the dispute class their own pilots are creating.

**The positioning sentence (use exactly this scope, nothing wider):**
> "Chargeback automation players (Chargeflow, Justt, Chargebacks911) are building agentic dispute tooling for card networks — Visa TAP, Mastercard Agent Pay, ACP. Nothing public exists for India's UPI agentic stack: Reserve Pay mandates, UPI Circle, UAP. This is the evidence layer for the rails Razorpay is laying."

Never claim "first ever." Claim "first for this stack." That claim is checked and survives a panel.

**Working name candidates:** Praman (प्रमाण, "proof/evidence") · Gawah ("witness") · pick in architecture session. Praman recommended: short, meaningful, .tech-friendly.

---

## 2. Product Definition — the Core Loop

0. **Capture** — at transaction time, a `POST /evidence-pack` ingest endpoint receives the agentic context (agent identifier, mandate reference, protocol metadata, conversation context, order linkage). All seeding flows through this API — the capture layer is a real component, not a seed script wearing a diagram box. Demo beat: one mock agent checkout emits its evidence pack live, before its dispute arrives.
1. **Ingest** — webhook-shaped dispute event lands (simulated, mirroring Razorpay's dispute entity field-for-field: `disp_` id, `payment_id`, `reason_code`, `phase`, `respond_by`, `status`).
2. **Triage** — classify by reason code; map to Razorpay's published reason-code → required-evidence guidance (this doc is the ground-truth rubric).
3. **Assemble** — pull from the agentic transaction store: mandate record (consent, limit, validity window), agent conversation trace, orchestration/audit log, order + fulfillment data. LLM synthesizes the explanation letter; deterministic code populates typed evidence fields. **Runtime failure policy:** any LLM step that fails, times out, or returns output failing schema validation routes the dispute to abstain with reason "assembly failure, manual review required" — logged, never silently retried into the money path. (This engineered fallback is also the pre-built "what broke" story.)
4. **Gate** — evidence sufficiency check. Strong evidence → draft contest. Insufficient → **abstain with stated reason** (never bluff a contest; a lost contest costs fees + time — this is the false-positive cost).
5. **Draft** — contest payload in real API shape (`action: draft`), explanation ≤1000 chars, documents via Documents API contract (`purpose: dispute_evidence`).
6. **Approve** — human-in-the-loop review UI, deadline-aware (respond_by countdown surfaced). **The invariant, precisely: the approve action is the only door to submit; nothing in eval mode ever touches the submission adapter.**
7. **Submit** — adapter targets the real Disputes API contract; in demo, hits the simulator. Full per-action audit log.
8. **Report** — batch dashboard: contested / abstained per rail, ₹ at stake in drafted contests, ₹ in correctly abstained disputes, ₹ false-positive cost, evidence completeness, exception list. Simulated won/lost outcomes are demo texture only, labeled "simulated" wherever rendered — no outcome number anywhere without provenance.

**Bounded money action story (their track bar, verbatim mapping):** draft-first ✓ · human-gated ✓ · deadline-aware ✓ · audit trail ✓ · abstention on uncertainty ✓ · defense-only ✓.

---

## 2a. The Official Rubric (from Razorpay's own video) — explicit mapping

> "We read the work, not the resume. We look at how you think, build and solve problems."

| Criterion | Their words | Where we score it |
|---|---|---|
| **Problem taste** | "did you pick something that actually matters" | Their own liability gap on their own live rails. The thesis §1 opens the video with it. |
| **Build quality** | "does it run, is it structured, **would you trust it**" | "Trust" = the gated, draft-first, deadline-aware, audit-logged design. Review UI + audit trail are trust evidence, not polish — demo them as such. One-command run + live deploy answer "does it run." |
| **AI judgment** | "the right tool in the right place, **and where you chose not to use one**" | Named artifact: `DECISIONS.md` section "Where we deliberately did NOT use AI" — deterministic schema mapping, gate thresholds, metrics computation, submission path. Reason stated: a money action must never depend on a stochastic step; evals must be reproducible. Plus a 10-second video beat saying it out loud. Almost no candidate answers the negative half of this criterion. |
| **Failure recovery** | "what broke, and what you did about it" | `FAILURES.md` from day 0; runtime failure + engineered fallback featured in video beat 5 and the form answer. |

---

## 3. The Eval — where this wins or loses Track 2

This is the differentiator. Most Track 2 entries will be a classifier with cherry-picked accuracy. Ours mirrors Razorpay's own published eval philosophy (their engineering blog: golden answers, deterministic scoring, seeded reproducible item selection — **checkable, load-bearing claim: verify the post says this and pin its URL in the §6 fact-check pass before it reaches the README**).

**Reproducibility, precisely (round-3 fix):** the pipeline contains LLM calls, and "temperature low" is not deterministic. So `packages/llm` gets a **record/replay layer**: the first eval run records responses keyed by request hash, committed as fixtures; subsequent runs replay them. README states it plainly: "eval replays recorded LLM responses for reproducibility; regenerate with `--live`." Gate decisions, precision/recall, and FP cost are then byte-reproducible; draft generation is reproducible via replay, regenerable live.

**Eval-mode invariant (round-3 fix):** eval scores gate decisions and draft outputs only — **nothing in eval mode ever touches the submission adapter**. In the product, the approve action is the sole path to submit. One door, no exceptions. This is a stronger trust story than "never auto-submit" because it names the invariant that actually matters.

**Synthetic corpus design (amended per adversarial review):**
- 100+ disputes across **two rails**: (a) ordinary e-commerce disputes — service not received, unrecognized charge, duplicate, credit not processed — the today-problem wedge; (b) agentic scenarios — valid agent purchase later disputed ("I don't remember this"), mandate-limit breach, expired mandate, wrong-item agent error, compromised-agent fraud. Same pipeline handles both; the agentic evidence pack is the differentiator module.
- **Reason-code distribution grounded in published data**, not invented: anchor class frequencies to Razorpay's documented reason codes and any published RBI/network chargeback statistics found on day 1; cite the source in EVAL.md. If no usable distribution exists, state the assumption explicitly.
- Every dispute labeled with ground truth: `winnable` / `unwinnable` / `ambiguous`. **Deliberately include unwinnable and ambiguous cases** — a corpus with only winnable disputes is the cherry-picking the track page explicitly calls out.
- Seeded generation: same seed → same corpus. Committed generator script, documented distribution assumptions in `EVAL.md`.
- **Held-out set is out-of-distribution by construction:** generated with a *different model and different prompt/persona set* than the dev corpus, at generation time, never read during development. This converts "we didn't peek" from a promise into a structural property.

**Metrics to report (all of them, including the ugly ones):**
- Precision / recall on the contest decision (did we contest winnable disputes; did we abstain on unwinnable ones).
- **False-positive cost in ₹:** each contested-and-lost dispute = dispute fee + amount + handling time. Report the actual number.
- **Distribution-shift section:** dev-set vs OOD-held-out performance, degradation reported plainly. The ugly delta IS the credibility proof.
- Abstention rate + per-case abstention reasons (the honest exception list, Track 4 discipline imported).
- Evidence-completeness score per drafted contest (fields populated vs. reason-code requirement).

**Known weakness, now mitigated rather than merely acknowledged:** the corpus is self-generated. Mitigations: OOD held-out generation (different model + prompts), grounded reason-code distribution with citation, unwinnables included, and the metric claimed precisely as *decision quality under our labeling*, with the OOD delta as evidence the system isn't tuned to its own generator. State all of this in EVAL.md before anyone asks.

---

## 4. Day-by-Day

| Day | Date | Deliverable (end of day, demoable) |
|---|---|---|
| 0 | Sat Aug 29 (tonight) | Architecture session (agenda §5). Stack locked. Repo initialized, CI, `FAILURES.md` created. Razorpay test-mode account + API keys live. **Prisma schema skeleton committed (pulled forward — Day 1 is shared with FortyGuard's deadline). Second-provider API key for OOD generation sorted.** |
| 1 | Sun Aug 30 | **Shared with FortyGuard deadline — slip rule pre-decided: P1.3 (OOD holdout) may move to Day 2 morning; Rail A trims to 2 classes before anything else slips.** Capture ingest endpoint live; generators seeding through it; dispute generator emitting exact Razorpay schema. Test-mode payments seeded so every dispute references a real `pay_` id. |
| 2 | Mon Aug 31 | Triage + evidence assembler working end-to-end on 10 disputes. Reason-code → evidence mapping table committed. |
| 3 | Tue Sep 1 | Sufficiency gate + contest drafter + submission adapter (real API contract). Minimal review UI: dispute queue, evidence view, approve/abstain. |
| 4 | Wed Sep 2 | Eval harness (replay mode) on held-out set. Metrics dashboard. Full batch run (100+). Deploy (Railway/Vercel — muscle memory) with demo banner, reset mechanism, and rate limit on the public "release next dispute" trigger. Freeze features. Form answers drafted tonight. |
| 5 | Thu Sep 3 | Hardening + polish only. Record demo takes. Architecture doc. README final. Dry-run panel defense with Usman (1 hr, adversarial). |
| 6 | Fri Sep 4 | Video final cut. Form filled. **Submit.** |
| — | Sat Sep 5 | Buffer only. Never plan to use it. |

**Daily rhythm:** Wasih posts EOD demo + `FAILURES.md` delta → Usman reviews async, 30-min sync max. SIH conflict days: cut scope per §8, never quality.

---

## 5. Architecture Session Agenda (tonight, 60–90 min)

1. **Stack call.** Decision criteria: eval credibility (metrics tooling), Wasih's velocity, demo deployability. Realistic options: (a) TS/Fastify end-to-end with metrics in TS; (b) TS service + Python eval harness. Bias to (a) unless the eval math genuinely needs Python — one language = fewer seams to defend.
2. **Claude Agent SDK question.** Razorpay built Agent Studio on it. Using it is a signal *if* it's the right tool; forcing it fails their "AI judgment" criterion. Decide honestly: agentic orchestration (SDK) vs. structured LLM calls (plain API). Whatever the answer, Wasih must be able to defend it.
3. **LLM boundary.** Deterministic code: schema handling, field mapping, gate thresholds, metrics. LLM: conversation-trace summarization, explanation-letter drafting, ambiguity flagging. Panel will probe exactly this line.
4. **Simulator honesty.** One adapter interface; simulator and real-API client both implement it. README states plainly: dispute origination isn't simulable in Razorpay's sandbox (bank-originated), so the simulator mirrors the documented entity; the contest path is built against the real contract.
5. **Name + repo structure.** Also confirm the record/replay fixture format and the demo-endpoint safety approach (banner + reset + rate limit).

---

## 6. Deliverable Specs

**Assume the first reader is a machine (adversarial-review finding).** Round 1 across a large pile is plausibly AI-screened: README, form answers, and video transcript get read; carefully sequenced demo beats and doc footnotes don't. Engineer accordingly.

**Repo (the resume, and the screener's primary document):** live deploy link in the FIRST LINE of README. Plain-text metrics table (dev + OOD held-out, including the degradation delta) near the top. An explicit "Track 2 bar mapping" section using their exact vocabulary: defense-only, held-out test set, precision/recall, false-positive cost in ₹, abstention. "Where we deliberately did NOT use AI" as a visible README section, not a DECISIONS.md footnote. One-command run. Seeded eval reproducible by a stranger. Architecture diagram in-repo. Honest commit history — no day-6 squash theater. `EVAL.md`, `FAILURES.md`, `DECISIONS.md`. **Fact-check pass before submission:** every checkable claim (pilots, competitors, docs citations) verified against a live source; anything unverifiable gets cut or scoped down.

**Video (5:00, six mandated beats — problem, solution, product, technology, decisions, working demo). Script rule: every key claim is SPOKEN so the transcript carries it — never conveyed only visually:**
- 0:00–0:40 — Hook: disputes are a today-problem merchants already bleed on; agentic pilots are creating tomorrow's harder version — customers disputing agent purchases they don't remember making. (Chargebacks911's warning paraphrased: the back end of agentic commerce is unbuilt.)
- 0:40–1:10 — The evidence gap: agent traces vanish by dispute time, so Praman captures the evidence pack at transaction time. Mandate log and agent trace *are* the new evidence. Card-network players exist; nothing public exists for UPI/Reserve Pay/UAP.
- 1:10–3:10 — Live demo: ordinary dispute handled, then an agentic dispute lands → evidence assembles → gate decision → draft → human approve → submit. **Then one abstention case, on purpose** — "here's a dispute we refuse to contest, and why." That 20 seconds is the differentiator.
- 3:10–4:10 — Metrics screen: precision/recall on dev AND OOD held-out, the degradation delta spoken aloud, ₹ false-positive cost, abstention rate, exception list. One architecture slide, ending with 10 seconds on "where we deliberately didn't use AI, and why" (rubric: AI judgment, the negative half).
- 4:10–5:00 — What broke + why this exists for Razorpay specifically (their schema, their rails, their liability position, their Agent Studio lineage).

**"What broke" (explicit form question):** never fabricated. Source from `FAILURES.md` — real failures logged daily from day 0. Best answers show a *runtime* failure and an engineered fallback (their stated criterion), e.g. LLM producing overconfident evidence summaries → countered with the sufficiency gate; or schema edge cases in dispute phases → countered with contract tests. Whatever actually breaks, log it same-day.

**Architecture doc:** 1–2 pages. Diagram, adapter/simulator honesty note, LLM boundary, eval design summary. No padding.

---

## 7. Application Form Strategy

Submit **Sep 4**, not Sep 5 (form/traffic risk; also "don't wait until the final deadline" is the universal advice for a reason). Field answers drafted **Sep 2**, refined Sep 3, reviewed by Usman. Honesty taxonomy applies: every claim in the form is measured, structural, or scoped — same discipline as the resume. The "what broke" answer is the one form field most candidates will waste; ours is pre-built from the log.

In-person availability: answer **yes** cleanly (college permits — confirmed).

---

## 8. Risks, Kill Criteria, Scope Cuts (in cut order)

1. **First cut:** review-UI polish → fall back to functional-but-plain table UI. Never cut the approve gate itself.
2. **Second cut:** dispute-class breadth → ship 3 classes per rail deeply instead of full breadth shallowly. Corpus size can drop to 60 if labeling quality is at risk.
3. **Third cut:** the agentic capture-layer demo depth (show one captured evidence pack instead of a full capture flow).
4. **Never cut:** the eval harness (incl. OOD held-out + shift report), the abstention gate, the audit log, `FAILURES.md`, **and the live deploy** — for an AI screener, a responding live link is the cheapest strong signal in the pile. These ARE the submission.
5. **Kill criterion (checkpoint at Aug 31 EOD — where its subject finishes):** if the assembler isn't producing coherent drafts on 10 disputes by end of Day 2, collapse scope to "triage + evidence assembly + gate" and drop the submission adapter to a stub — decided that night, before Day 3 builds four components on a broken foundation. Second gate, Sep 1 EOD: gate + drafter loop working end-to-end, or the UI simplifies to queue-and-approve only. A smaller honest system beats a bigger broken one — the track page says exactly this.
6. **Authorship discipline:** Usman challenges and reviews; every line and every decision is Wasih's to write and defend. If Wasih can't explain a component from first principles at the Sep 3 dry run, that component gets simplified until he can.

---

## 9. Even-on-a-Loss Value

If not shortlisted: a deployed, Razorpay-schema, agentic-payments dispute product with a seeded eval harness becomes the anchor artifact for the ongoing fintech internship outreach pipeline — strictly stronger than most of what's currently in the portfolio for fintech-facing applications. This bet pays on both branches.