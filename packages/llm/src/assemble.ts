import {
  buildContestDraft,
  formatRupees,
  unmetRequirements,
  withReadableMoney,
  type CollectedEvidence,
  type ContestDraft,
  type GateResult,
} from '@praman/core';

import {
  ASSEMBLY_ABSTAIN_REASON,
  AssemblyFailure,
  type AssemblyClient,
  type ModelCallTelemetry,
} from './client.js';
import type { ConfirmationSignal } from './schemas.js';

/**
 * Evidence assembly: collector output in, a reviewable draft or an abstention
 * out (TASKS.md P2.3).
 *
 * The order of operations is the argument. Deterministic code collects the
 * evidence and decides where each artifact belongs; the model is asked only to
 * read natural language and produce natural language; deterministic code then
 * assembles the payload. If the model step fails in any of its four ways, the
 * dispute abstains with a fixed reason and an audit entry.
 *
 * Nothing here submits anything. Assembly produces a draft; the single door to
 * submission is the human approve action in the review UI (hard rule #2).
 */

/**
 * Abstention reason for a dispute the evidence does not support contesting.
 *
 * Kept distinct from `ASSEMBLY_ABSTAIN_REASON` on purpose: one says the
 * pipeline broke, the other says the pipeline worked and the answer was no.
 * P4.1 counts them separately, and a reader of those numbers needs the
 * difference. See FAILURES.md F-011.
 */
export const INSUFFICIENT_EVIDENCE_REASON = 'evidence insufficient to support a contest';

/**
 * Why a dispute abstained. Three classes, counted separately by P4.1, because
 * they mean completely different things about the system:
 *
 *   gate                  -- deterministic rules said no. The normal, correct,
 *                            most common outcome. No model was ever called.
 *   drafter_disagreement  -- the gate cleared it and the drafter, reading the
 *                            same evidence, said the case is not there. Two
 *                            independent readings disagreeing is precisely when
 *                            a human should look, so it abstains conservatively.
 *   assembly_failure      -- the pipeline broke. See hard rule #4.
 */
export const ABSTENTION_CLASSES = ['gate', 'drafter_disagreement', 'assembly_failure'] as const;
export type AbstentionClass = (typeof ABSTENTION_CLASSES)[number];

export const ASSEMBLY_OUTCOMES = ['assembled', 'abstained'] as const;
export type AssemblyOutcome = (typeof ASSEMBLY_OUTCOMES)[number];

export interface AuditEntry {
  step: string;
  detail: string;
}

export interface AssembledDispute {
  disputeId: string;
  outcome: AssemblyOutcome;
  /** Present only when `outcome` is `abstained`. */
  abstentionReason?: string;
  /** Which of the four failure paths fired, when one did. */
  failureKind?: AssemblyFailure['kind'];
  /** Set when the model judged the evidence insufficient. Not a failure. */
  insufficientEvidenceReason?: string;
  /** Which class of abstention this was. Present iff `outcome` is `abstained`. */
  abstentionClass?: AbstentionClass;
  /** The deterministic gate decision this assembly was built on. */
  gate: GateResult;
  collected: CollectedEvidence;
  traceSummary?: string;
  confirmation?: ConfirmationSignal;
  ambiguityFlags: string[];
  draft?: ContestDraft;
  audit: AuditEntry[];
  /**
   * Every model call made for this dispute, in order, with what it cost. Empty
   * when the gate declined, because then no model was called at all (D-025).
   */
  modelCalls: ModelCallTelemetry[];
}

/**
 * The prompt input for the trace summariser.
 *
 * Built only from seed-derived capture fields (D-007). No server ids, no wall
 * clock -- either would change the replay key on every reseed and silently turn
 * a replayed eval into a live one.
 */
export interface TraceForSummary {
  turns: readonly { role: string; content: string }[];
}

function buildSummaryPrompt(collected: CollectedEvidence, trace: TraceForSummary): string {
  const lines = [
    `Dispute reason code: ${collected.network} ${collected.reasonCode}`,
    `Rail: ${collected.rail}`,
    '',
    'Captured conversation:',
    ...trace.turns.map((turn) => `[${turn.role}] ${turn.content}`),
  ];
  return lines.join('\n');
}

function buildLetterPrompt(
  collected: CollectedEvidence,
  traceSummary: string | undefined,
): string {
  const present = collected.findings.filter((finding) => finding.state === 'present');
  const missing = unmetRequirements(collected);

  const lines = [
    `Dispute reason code: ${collected.network} ${collected.reasonCode}`,
    `What the customer is disputing is governed by this code's published evidence requirements.`,
    '',
    'Evidence held:',
    // Money is rendered in rupees before the model sees it, never as the raw
    // subunits the payload carries. F-029: the drafter was handed `165400` and
    // wrote "INR 165,400" into a contest for a ₹1,654 dispute, on the same
    // screen as two deterministic panels saying ₹1,654. The fix belongs here,
    // at the boundary, rather than in a prompt rule asking the model to divide
    // by a hundred -- arithmetic is not what it is here to do.
    ...present.map(
      (finding) => `- ${finding.artifact}: ${JSON.stringify(withReadableMoney(finding.detail))}`,
    ),
    '',
    'Evidence NOT held (do not claim any of these):',
    ...(missing.length === 0
      ? ['- none']
      : missing.map((finding) => `- ${finding.artifact}: ${finding.reason}`)),
  ];

  if (collected.mandate.present) {
    lines.push(
      '',
      'Mandate facts (computed, authoritative -- do not restate them incorrectly):',
      `- amount charged: ${formatRupees(collected.mandate.chargedAmount)} of a ${
        collected.mandate.maxAmount === undefined
          ? 'cap that was not captured'
          : `${formatRupees(collected.mandate.maxAmount)} cap`
      }`,
      `- within limit: ${collected.mandate.withinLimit}`,
      `- within validity window: ${collected.mandate.withinValidityWindow}`,
      `- consent recorded before payment: ${collected.mandate.consentBeforePayment}`,
    );
  }

  if (traceSummary) {
    lines.push('', 'Neutral summary of the captured conversation:', traceSummary);
  }

  if (collected.anomalySignals.length > 0) {
    lines.push('', `Anomaly signals on this transaction: ${collected.anomalySignals.join(', ')}`);
  }

  return lines.join('\n');
}

function abstain(
  collected: CollectedEvidence,
  gate: GateResult,
  audit: AuditEntry[],
  ambiguityFlags: string[],
  failure: AssemblyFailure,
  modelCalls: ModelCallTelemetry[],
): AssembledDispute {
  audit.push({
    step: 'assembly_failed',
    detail: `${failure.kind} in ${failure.promptId}: ${failure.detail}`,
  });
  audit.push({ step: 'abstained', detail: ASSEMBLY_ABSTAIN_REASON });
  return {
    disputeId: collected.disputeId,
    outcome: 'abstained',
    abstentionReason: ASSEMBLY_ABSTAIN_REASON,
    abstentionClass: 'assembly_failure',
    failureKind: failure.kind,
    collected,
    gate,
    ambiguityFlags,
    audit,
    modelCalls,
  };
}

export interface AssembleOptions {
  client: AssemblyClient;
  collected: CollectedEvidence;
  /** The deterministic gate decision. Assembly never re-decides it. */
  gate: GateResult;
  /** The captured conversation, when one exists. Ordinary rail has none. */
  trace?: TraceForSummary;
  /** Amount to contest, in subunits. Defaults to the full disputed amount. */
  amount: number;
}

export async function assembleDispute(options: AssembleOptions): Promise<AssembledDispute> {
  const { client, collected, gate, trace, amount } = options;
  const audit: AuditEntry[] = [
    {
      step: 'evidence_collected',
      detail: `${collected.coverage.present}/${collected.coverage.required} required artifacts present`,
    },
    { step: 'gated', detail: `${gate.decision}: ${gate.reason ?? 'all rules passed'}` },
  ];

  // The gate decides. If it says abstain, NO MODEL IS CALLED AT ALL -- not for
  // a summary, not for flags. That is the cleanest possible statement of the
  // LLM boundary: a dispute the deterministic rules declined never touches a
  // model, so no model output can have influenced the outcome. It is also, as
  // it happens, most of the corpus, and therefore most of the cost.
  if (gate.decision === 'abstain') {
    audit.push({ step: 'abstained', detail: gate.reason ?? 'gate declined' });
    return {
      disputeId: collected.disputeId,
      outcome: 'abstained',
      abstentionReason: gate.reason ?? 'gate declined',
      abstentionClass: 'gate',
      collected,
      gate,
      ambiguityFlags: [],
      audit,
      modelCalls: [],
    };
  }
  const modelCalls: ModelCallTelemetry[] = [];
  let ambiguityFlags: string[] = [];
  let traceSummary: string | undefined;
  let confirmation: ConfirmationSignal | undefined;

  if (trace && trace.turns.length > 0) {
    try {
      const summarised = await client.summariseTrace(buildSummaryPrompt(collected, trace), modelCalls);
      traceSummary = summarised.summary;
      confirmation = summarised.confirmation;
      ambiguityFlags = summarised.ambiguityFlags;
      audit.push({
        step: 'trace_summarised',
        detail: `confirmation=${summarised.confirmation}, flags=${summarised.ambiguityFlags.length}`,
      });
    } catch (error) {
      if (error instanceof AssemblyFailure) {
        return abstain(collected, gate, audit, ambiguityFlags, error, modelCalls);
      }
      throw error;
    }
  } else {
    audit.push({ step: 'trace_summarised', detail: 'no conversation trace captured; skipped' });
  }

  let draft: ContestDraft;
  try {
    const drafted = await client.draftLetter(buildLetterPrompt(collected, traceSummary), modelCalls);

    if ('insufficientEvidence' in drafted) {
      // The gate cleared this and the drafter, reading the same evidence, says
      // the case is not there. Neither reading overrides the other: two
      // independent disagreeing judgements is exactly when a human should look,
      // so it abstains conservatively and the disagreement is on the record.
      audit.push({ step: 'drafter_disagreed_with_gate', detail: drafted.reason });
      audit.push({ step: 'abstained', detail: INSUFFICIENT_EVIDENCE_REASON });
      return {
        disputeId: collected.disputeId,
        outcome: 'abstained',
        abstentionReason: INSUFFICIENT_EVIDENCE_REASON,
        abstentionClass: 'drafter_disagreement',
        insufficientEvidenceReason: drafted.reason,
        collected,
        gate,
        ...(traceSummary ? { traceSummary } : {}),
        ...(confirmation ? { confirmation } : {}),
        ambiguityFlags,
        audit,
        modelCalls,
      };
    }

    draft = buildContestDraft(collected, drafted.letter, amount);
    audit.push({
      step: 'contest_drafted',
      detail: `${drafted.letter.length} chars, ${draft.assignments.length} evidence fields populated`,
    });
  } catch (error) {
    if (error instanceof AssemblyFailure) {
      return abstain(collected, gate, audit, ambiguityFlags, error, modelCalls);
    }
    throw error;
  }

  return {
    disputeId: collected.disputeId,
    outcome: 'assembled',
    collected,
    gate,
    ...(traceSummary ? { traceSummary } : {}),
    ...(confirmation ? { confirmation } : {}),
    ambiguityFlags,
    draft,
    audit,
    modelCalls,
  };
}
