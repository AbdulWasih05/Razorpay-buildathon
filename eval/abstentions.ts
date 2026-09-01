import {
  DEFAULT_THRESHOLDS,
  SCENARIOS,
  blockingRules,
  collectEvidence,
  evaluateGate,
  evidencePackIngestSchema,
  type CollectedEvidence,
  type EvidenceArtifact,
  type GateThresholds,
  type ScenarioClass,
} from '@praman/core';
import { DEV_CONFIG, generateCorpus, type GeneratorConfig } from '@praman/simulator';

/**
 * Abstention decomposition (TASKS.md P4.1 input).
 *
 * A single abstention rate is not a finding. "74% abstained" is equally
 * consistent with a corpus full of genuinely undefendable disputes and with a
 * gate too timid to contest anything, and the headline number cannot tell them
 * apart. Everything downstream -- the recall figure the track bar actually
 * scores, whether P4.0's capture repairs are worth doing before the freeze --
 * depends on the split, not the total.
 *
 * So every abstention is attributed to a cause, against ground truth:
 *
 *   correct_unwinnable   the corpus says this dispute cannot be won and we
 *                        declined it. The product working as designed.
 *   conservative_ambiguous
 *                        the corpus calls it genuinely ambiguous and we
 *                        declined. Defensible under hard rule #7, but counted
 *                        separately -- folding it into "correct" would flatter
 *                        the number, since a contest here is not obviously wrong.
 *   capture_gap          winnable, and every required artifact we lack is one
 *                        Praman structurally cannot produce for ANY dispute.
 *                        Recall lost to our own capture layer, not to judgement.
 *                        This is the bucket P4.0 is meant to shrink.
 *   evidence_absent      winnable, and a required artifact that IS capturable
 *                        in principle is missing from this particular pack. The
 *                        gate is reading the data correctly; the data is thin.
 *   false_negative       winnable, full required coverage, and we declined
 *                        anyway. The gate was wrong. This is the recall loss
 *                        with no excuse attached.
 *
 * `capture_gap` and `false_negative` are both recall losses, and the difference
 * matters: the first is fixable by capturing more at transaction time, which is
 * this product's whole thesis; the second is the gate misjudging evidence it
 * already holds.
 *
 * Pure and deterministic, like the gate itself: it reads the seeded corpus and
 * recomputes, so it needs no database and no model call, and two runs on one
 * seed give one answer.
 */

export const ABSTENTION_CAUSES = [
  'correct_unwinnable',
  'conservative_ambiguous',
  'capture_gap',
  'evidence_absent',
  'false_negative',
] as const;

export type AbstentionCause = (typeof ABSTENTION_CAUSES)[number];

export interface AttributedDispute {
  disputeId: string;
  externalId: string;
  scenarioClass: ScenarioClass;
  rail: 'ordinary' | 'agentic';
  groundTruth: string;
  amount: number;
  decision: 'contest' | 'abstain';
  /** Set only when `decision` is `abstain`. */
  cause?: AbstentionCause;
  /** The rule ids that blocked, in gate order. */
  blockedBy: string[];
  missingRequired: EvidenceArtifact[];
  structurallyUnavailable: EvidenceArtifact[];
  reason?: string;
}

/**
 * Attribute one abstention to a cause.
 *
 * Deliberately reads ground truth: this is eval-side analysis, never a runtime
 * input. Nothing in the pipeline may call it.
 */
export function attributeAbstention(
  collected: CollectedEvidence,
  groundTruth: string,
): AbstentionCause {
  if (groundTruth === 'unwinnable') return 'correct_unwinnable';
  if (groundTruth === 'ambiguous') return 'conservative_ambiguous';

  // Winnable from here down: every one of these is recall we did not collect.
  const missing = collected.missingRequired;
  if (missing.length === 0) return 'false_negative';

  const unavailable = new Set<EvidenceArtifact>(collected.structurallyUnavailable);
  return missing.every((artifact) => unavailable.has(artifact))
    ? 'capture_gap'
    : 'evidence_absent';
}

export function attributeCorpus(
  config: GeneratorConfig = DEV_CONFIG,
  count = 100,
  thresholds: GateThresholds = DEFAULT_THRESHOLDS,
): AttributedDispute[] {
  const corpus = generateCorpus(config, count);

  return corpus.disputes.map((dispute) => {
    const entity = dispute.event.payload.dispute.entity;
    const scenario = SCENARIOS[dispute.scenarioClass];
    const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
    const collected = collectEvidence(pack, {
      disputeId: entity.id,
      reasonCode: entity.reason_code,
      network: scenario.network,
      amount: entity.amount,
    });
    const gate = evaluateGate(collected, thresholds);

    return {
      disputeId: entity.id,
      externalId: dispute.externalId,
      scenarioClass: dispute.scenarioClass,
      rail: scenario.rail,
      groundTruth: dispute.groundTruth,
      amount: entity.amount,
      decision: gate.decision,
      ...(gate.decision === 'abstain'
        ? { cause: attributeAbstention(collected, dispute.groundTruth) }
        : {}),
      blockedBy: blockingRules(gate).map((rule) => rule.id),
      missingRequired: collected.missingRequired,
      structurallyUnavailable: collected.structurallyUnavailable,
      ...(gate.reason ? { reason: gate.reason } : {}),
    };
  });
}

export interface Breakdown {
  total: number;
  contested: number;
  abstained: number;
  byCause: Record<AbstentionCause, number>;
  /** Rupee subunits sitting in each bucket. */
  amountByCause: Record<AbstentionCause, number>;
  /** Which artifacts caused capture-gap abstentions, and how often. */
  gapArtifacts: Record<string, number>;
}

export function summarise(attributed: AttributedDispute[]): Breakdown {
  const byCause = Object.fromEntries(
    ABSTENTION_CAUSES.map((cause) => [cause, 0]),
  ) as Record<AbstentionCause, number>;
  const amountByCause = Object.fromEntries(
    ABSTENTION_CAUSES.map((cause) => [cause, 0]),
  ) as Record<AbstentionCause, number>;
  const gapArtifacts: Record<string, number> = {};

  for (const entry of attributed) {
    if (!entry.cause) continue;
    byCause[entry.cause] += 1;
    amountByCause[entry.cause] += entry.amount;
    if (entry.cause === 'capture_gap' || entry.cause === 'evidence_absent') {
      for (const artifact of entry.missingRequired) {
        gapArtifacts[artifact] = (gapArtifacts[artifact] ?? 0) + 1;
      }
    }
  }

  return {
    total: attributed.length,
    contested: attributed.filter((entry) => entry.decision === 'contest').length,
    abstained: attributed.filter((entry) => entry.decision === 'abstain').length,
    byCause,
    amountByCause,
    gapArtifacts,
  };
}

/** Recall against the winnable population: of what could be won, what did we contest. */
export function recall(attributed: AttributedDispute[]): {
  winnable: number;
  contested: number;
  ratio: number;
} {
  const winnable = attributed.filter((entry) => entry.groundTruth === 'winnable');
  const contested = winnable.filter((entry) => entry.decision === 'contest').length;
  return {
    winnable: winnable.length,
    contested,
    ratio: winnable.length === 0 ? 0 : contested / winnable.length,
  };
}
