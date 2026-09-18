import { readFileSync } from 'node:fs';

import {
  SCENARIOS,
  collectEvidence,
  evaluateGate,
  evidencePackIngestSchema,
  type CollectedEvidence,
  type GateResult,
  type Rail,
  type ScenarioClass,
} from '@praman/core';
import {
  AssemblyClient,
  OpenAiCompatibleProvider,
  ResponseCache,
  assembleDispute,
  assertNotHoldoutFamily,
  providerFromEnv,
  type AbstentionClass,
  type AssembledDispute,
  type AssemblyFailureKind,
  type ModelCallTelemetry,
  type ModelProvider,
} from '@praman/llm';
import {
  DEV_CONFIG,
  OOD_CONFIG,
  OodLanguageGenerator,
  generateCorpus,
  shift,
  type GeneratedCorpus,
  type GeneratedDispute,
  type GeneratorConfig,
} from '@praman/simulator';

import { attributeAbstention, type AbstentionCause } from './abstentions.js';

/**
 * The eval harness (TASKS.md P4.1).
 *
 * It runs the whole decision pipeline -- collect, gate, draft -- over the dev
 * corpus and over the out-of-distribution held-out corpus, and scores both
 * against ground truth.
 *
 * Three properties are structural rather than promised, and they are the reason
 * this file is shaped the way it is:
 *
 * 1. **It cannot submit.** There is no `@praman/adapter` import here and a test
 *    asserts there never is one. That is hard rule #2's "eval mode never
 *    touches the submission adapter" enforced by the module graph rather than
 *    by anyone remembering. Scoring a batch is legitimate precisely because it
 *    physically cannot reach the one door.
 *
 * 2. **It replays by default.** `--live` is a deliberate flag. A replay miss
 *    throws rather than silently calling a model, so a stale fixture is a loud
 *    failure and never a quietly different number.
 *
 * 3. **It reads the holdout, and it is the only thing that may.** This file is
 *    on the `eval/holdout-guard.test.ts` allowlist. Everything else in the
 *    repository is statically prevented from importing `OOD_CONFIG`, which is
 *    what makes "the holdout was never read during development" checkable
 *    rather than asserted.
 *
 * Nothing here consults ground truth before a decision is made. Ground truth
 * enters only in `toCase`, after the dispute has already been decided, and in
 * `score`, which reads the finished cases.
 */

// ---------------------------------------------------------------------------
// What a false positive actually costs
// ---------------------------------------------------------------------------

/**
 * The cost model, with its assumptions in the open.
 *
 * TASKS.md originally specified false-positive cost as "fee + amount + fixed
 * handling time". Reading the live docs before implementing it showed that
 * definition double-counts, so the metric was corrected rather than the plan
 * quietly followed (DECISIONS.md D-034).
 *
 * Razorpay's disputes documentation, read 2026-09-03, says the disputed amount
 * "would be deducted from your account and is sent to the customer" **if you
 * lose the dispute**. Losing a contest and never contesting therefore end in
 * the same place for the amount: it is gone either way. Counting it as the
 * price of a false positive attributes to the decision a loss the decision did
 * not cause, and inflates the headline by about two orders of magnitude.
 *
 * What a bluffed contest actually costs, over and above abstaining, is the
 * representment handling: reviewer time assembling and approving evidence for a
 * case that was never defensible, plus whatever the acquirer charges to process
 * it. So that is what this measures.
 *
 * Both figures are **assumptions**, not published numbers -- the same reading
 * that produced the sentence above found no fee schedule in Razorpay's public
 * documentation. They are named here, printed in the report, and trivial to
 * change, so a reader who disagrees can recompute rather than guess.
 */
export const COST_MODEL = {
  /** Per contested-and-lost dispute. Assumption: no published Razorpay figure. */
  representmentFeeSubunits: 100_000,
  /** Reviewer time on a contest that should never have been filed. Assumption. */
  handlingCostSubunits: 50_000,
} as const;

export const FALSE_POSITIVE_UNIT_COST =
  COST_MODEL.representmentFeeSubunits + COST_MODEL.handlingCostSubunits;

// ---------------------------------------------------------------------------
// Running a set
// ---------------------------------------------------------------------------

export type EvalSetName = 'dev' | 'holdout';

export interface EvalSetSpec {
  name: EvalSetName;
  config: GeneratorConfig;
  size: number;
  /** Held-out conversation language is model-written and replayed from a fixture. */
  appliesOodLanguage: boolean;
}

export const EVAL_SETS: Record<EvalSetName, EvalSetSpec> = {
  dev: { name: 'dev', config: DEV_CONFIG, size: 100, appliesOodLanguage: false },
  holdout: { name: 'holdout', config: OOD_CONFIG, size: 30, appliesOodLanguage: true },
};

const OOD_LANGUAGE_CACHE = new URL(
  '../packages/simulator/fixtures/ood-language.json',
  import.meta.url,
);

/**
 * Rebuild the held-out corpus exactly as `scripts/generate-holdout.ts` built it.
 *
 * The structure is regenerated from the seed and the conversation language is
 * replayed from the committed cache, never re-requested -- `allowLive` is
 * hard-coded false, so scoring the holdout can never mint new held-out text and
 * quietly change what "held out" refers to.
 */
async function applyOodLanguage(corpus: GeneratedCorpus): Promise<void> {
  const generator = new OodLanguageGenerator({
    apiKey: '',
    // The holdout's own manifest names the model that wrote it. Reading it from
    // `GROQ_MODEL` (as this did) meant pointing that variable at any other model
    // -- which a matrix run does -- silently changed the replay key and missed
    // every cached held-out turn. The writer of the holdout is a property of the
    // holdout, not of whatever the assembler happens to be running on.
    model: holdoutLanguageModel(),
    cachePath: fileFromUrl(OOD_LANGUAGE_CACHE),
    allowLive: false,
  });

  for (const dispute of corpus.disputes) {
    const trace = dispute.transaction.pack.conversationTrace;
    if (!trace) continue;
    const turns = await generator.turnsFor(dispute.transaction);
    const startedAt = new Date(String(trace.startedAt));
    trace.turns = turns.map((turn, seq) => ({
      externalId: `trn_${OOD_CONFIG.name}_${dispute.scenarioClass}_${dispute.transaction.index}_${seq}`,
      seq,
      role: turn.role,
      content: turn.content,
      occurredAt: shift(startedAt, seq * 2).toISOString(),
    }));
  }
}

/** Windows-safe `file:` URL to path. `new URL(...).pathname` yields `/C:/...`. */
function fileFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

/** Which model wrote the held-out conversation language, from the holdout manifest. */
function holdoutLanguageModel(): string {
  const manifest = JSON.parse(
    readFileSync(fileFromUrl(new URL('./holdout.json', import.meta.url)), 'utf8'),
  ) as { languageModel?: string };
  if (!manifest.languageModel) {
    throw new Error('eval/holdout.json has no languageModel: cannot replay held-out language');
  }
  return manifest.languageModel;
}

export async function loadSet(spec: EvalSetSpec): Promise<GeneratedCorpus> {
  const corpus = generateCorpus(spec.config, spec.size);
  if (spec.appliesOodLanguage) await applyOodLanguage(corpus);
  return corpus;
}

/** One scored dispute. Everything the report needs, and nothing derived. */
export interface EvalCase {
  disputeId: string;
  externalId: string;
  scenarioClass: ScenarioClass;
  rail: Rail;
  network: string;
  reasonCode: string;
  groundTruth: string;
  amount: number;
  /** What the deterministic gate said, before any model ran. */
  gateDecision: 'contest' | 'abstain';
  /** What the pipeline concluded. Differs from the gate only via the drafter veto. */
  decision: 'contest' | 'abstain';
  abstentionClass?: AbstentionClass;
  failureKind?: AssemblyFailureKind;
  /**
   * The failure's own words, from the audit trail.
   *
   * Carried separately from `abstentionReason` because that one is fixed
   * verbatim by hard rule #4 and therefore says nothing about what went wrong.
   * The report needs the detail to tell an over-length letter from a timeout.
   */
  failureDetail?: string;
  abstentionReason?: string;
  /** Attributed cause, against ground truth. Only on abstentions. */
  cause?: AbstentionCause;
  requiredArtifacts: number;
  presentArtifacts: number;
  draftChars?: number;
  evidenceFields?: number;
  ambiguityFlags: number;
  /** True when a model was called at all for this dispute. */
  modelCalled: boolean;
  /**
   * The calls themselves, with the tokens and latency their recordings carry.
   * Empty when the gate declined. Reporting only: nothing here is scored.
   */
  modelCalls: ModelCallTelemetry[];
}

function failureDetail(assembled: AssembledDispute): string | undefined {
  return assembled.audit.find((entry) => entry.step === 'assembly_failed')?.detail;
}

function toCase(
  dispute: GeneratedDispute,
  collected: CollectedEvidence,
  gate: GateResult,
  assembled: AssembledDispute,
): EvalCase {
  const entity = dispute.event.payload.dispute.entity;
  const decision = assembled.outcome === 'assembled' ? 'contest' : 'abstain';

  return {
    disputeId: entity.id,
    externalId: dispute.externalId,
    scenarioClass: dispute.scenarioClass,
    rail: dispute.rail,
    network: collected.network,
    reasonCode: entity.reason_code,
    groundTruth: dispute.groundTruth,
    amount: entity.amount,
    gateDecision: gate.decision,
    decision,
    ...(assembled.abstentionClass ? { abstentionClass: assembled.abstentionClass } : {}),
    ...(assembled.failureKind ? { failureKind: assembled.failureKind } : {}),
    ...(failureDetail(assembled) ? { failureDetail: failureDetail(assembled) as string } : {}),
    ...(assembled.abstentionReason ? { abstentionReason: assembled.abstentionReason } : {}),
    // Attribution reads ground truth, so it happens here -- after the decision,
    // never before it. The pipeline itself cannot reach this function.
    //
    // `attributeAbstention` cannot see WHOSE decision it is scoring -- it only
    // reads `collected`, which is right for the gate-only score in
    // `eval/abstentions.ts`. Here, where a drafter can also decline, a
    // `drafter_disagreement` on a full-required-coverage winnable case would
    // otherwise land in `false_negative`, which means "the gate was wrong"
    // (D-030) -- and here the gate was not wrong, it cleared the dispute; the
    // drafter vetoed it, which D-025 says is a different, sanctioned thing.
    // Reassigned to `drafter_veto` so the two are never blurred (F-025).
    ...(decision === 'abstain'
      ? {
          cause:
            assembled.abstentionClass === 'drafter_disagreement' &&
            attributeAbstention(collected, dispute.groundTruth) === 'false_negative'
              ? ('drafter_veto' as const)
              : attributeAbstention(collected, dispute.groundTruth),
        }
      : {}),
    requiredArtifacts: collected.coverage.required,
    presentArtifacts: collected.coverage.present,
    ...(assembled.draft ? { draftChars: assembled.draft.summary.length } : {}),
    ...(assembled.draft ? { evidenceFields: assembled.draft.assignments.length } : {}),
    ambiguityFlags: assembled.ambiguityFlags.length,
    // The gate declining means no model was called at all (D-025). That turns
    // the LLM boundary into a measurable quantity rather than a claim.
    modelCalled: gate.decision === 'contest',
    modelCalls: assembled.modelCalls,
  };
}

export interface RunOptions {
  spec: EvalSetSpec;
  client: AssemblyClient;
  /** Called once per dispute, for progress output on a live run. */
  onCase?: (evalCase: EvalCase, index: number, total: number) => void;
}

export async function runSet(options: RunOptions): Promise<EvalCase[]> {
  const corpus = await loadSet(options.spec);
  const cases: EvalCase[] = [];

  for (const [index, dispute] of corpus.disputes.entries()) {
    const entity = dispute.event.payload.dispute.entity;
    const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
    const collected = collectEvidence(pack, {
      disputeId: entity.id,
      reasonCode: entity.reason_code,
      network: SCENARIOS[dispute.scenarioClass].network,
      amount: entity.amount,
    });
    const gate = evaluateGate(collected);
    const trace = pack.conversationTrace
      ? { turns: pack.conversationTrace.turns.map((t) => ({ role: t.role, content: t.content })) }
      : undefined;

    const assembled = await assembleDispute({
      client: options.client,
      collected,
      gate,
      ...(trace ? { trace } : {}),
      amount: entity.amount,
    });

    const evalCase = toCase(dispute, collected, gate, assembled);
    cases.push(evalCase);
    options.onCase?.(evalCase, index + 1, corpus.size);
  }

  return cases;
}

/**
 * Build the client the harness runs on.
 *
 * Replay needs no credentials at all, so the placeholder key is not a secret
 * standing in for a real one -- it is a statement that none is required. The
 * provider name and model are both part of the replay key, so they must match
 * what was recorded or every lookup misses loudly.
 */
export function buildClient(
  live: boolean,
  env: NodeJS.ProcessEnv,
  choice?: MatrixModel,
): { client: AssemblyClient; provider: ModelProvider; cache: ResponseCache } {
  const provider = choice
    ? matrixProvider(choice, live, env)
    : live
      ? providerFromEnv(env)
      : providerFromEnv({ GROQ_API_KEY: 'replay-only' });
  const cache = new ResponseCache(fixturePathFor(choice));
  const client = new AssemblyClient({
    provider,
    cache,
    mode: live ? 'live' : 'replay',
    timeoutMs: 60_000,
  });
  return { client, provider, cache };
}

/** One entry of the pinned matrix: a provider and an exact model id. */
export interface MatrixModel {
  provider: string;
  model: string;
}

/**
 * Where a model's recordings live.
 *
 * The model of record keeps the original fixture file, untouched, because the
 * committed report is replayed from it and D-023 freezes it. Every matrix model
 * -- including a fresh sample of the model of record -- gets its own file, so a
 * comparison run can never overwrite the recordings the headline numbers came
 * from.
 */
export function fixturePathFor(choice?: MatrixModel): string | undefined {
  if (!choice) return undefined;
  const slug = `${choice.provider}__${choice.model}`.replace(/[^a-z0-9.-]+/gi, '-');
  return fileFromUrl(new URL(`../packages/llm/fixtures/assembly/${slug}.json`, import.meta.url));
}

function matrixProvider(choice: MatrixModel, live: boolean, env: NodeJS.ProcessEnv): ModelProvider {
  assertNotHoldoutFamily(choice.model);
  if (choice.provider !== 'groq') {
    throw new Error(`matrix provider ${choice.provider} is not wired up; only groq is`);
  }
  const apiKey = live ? env['GROQ_API_KEY'] : 'replay-only';
  if (!apiKey) throw new Error('a live matrix run needs GROQ_API_KEY');
  return new OpenAiCompatibleProvider(
    'groq',
    choice.model,
    apiKey,
    'https://api.groq.com/openai/v1',
  );
}
