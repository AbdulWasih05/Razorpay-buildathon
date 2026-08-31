import {
  buildContestDraft,
  unmetRequirements,
  type CollectedEvidence,
  type ContestDraft,
} from '@praman/core';

import { ASSEMBLY_ABSTAIN_REASON, AssemblyFailure, type AssemblyClient } from './client.js';
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
  collected: CollectedEvidence;
  traceSummary?: string;
  confirmation?: ConfirmationSignal;
  ambiguityFlags: string[];
  draft?: ContestDraft;
  audit: AuditEntry[];
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
    ...present.map(
      (finding) => `- ${finding.artifact}: ${JSON.stringify(finding.detail)}`,
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
      `- amount charged: ${collected.mandate.chargedAmount} of a ${collected.mandate.maxAmount} cap`,
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
  audit: AuditEntry[],
  ambiguityFlags: string[],
  failure: AssemblyFailure,
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
    failureKind: failure.kind,
    collected,
    ambiguityFlags,
    audit,
  };
}

export interface AssembleOptions {
  client: AssemblyClient;
  collected: CollectedEvidence;
  /** The captured conversation, when one exists. Ordinary rail has none. */
  trace?: TraceForSummary;
  /** Amount to contest, in subunits. Defaults to the full disputed amount. */
  amount: number;
}

export async function assembleDispute(options: AssembleOptions): Promise<AssembledDispute> {
  const { client, collected, trace, amount } = options;
  const audit: AuditEntry[] = [
    {
      step: 'evidence_collected',
      detail: `${collected.coverage.present}/${collected.coverage.required} required artifacts present`,
    },
  ];
  let ambiguityFlags: string[] = [];
  let traceSummary: string | undefined;
  let confirmation: ConfirmationSignal | undefined;

  if (trace && trace.turns.length > 0) {
    try {
      const summarised = await client.summariseTrace(buildSummaryPrompt(collected, trace));
      traceSummary = summarised.summary;
      confirmation = summarised.confirmation;
      ambiguityFlags = summarised.ambiguityFlags;
      audit.push({
        step: 'trace_summarised',
        detail: `confirmation=${summarised.confirmation}, flags=${summarised.ambiguityFlags.length}`,
      });
    } catch (error) {
      if (error instanceof AssemblyFailure) {
        return abstain(collected, audit, ambiguityFlags, error);
      }
      throw error;
    }
  } else {
    audit.push({ step: 'trace_summarised', detail: 'no conversation trace captured; skipped' });
  }

  let draft: ContestDraft;
  try {
    const drafted = await client.draftLetter(buildLetterPrompt(collected, traceSummary));

    if ('insufficientEvidence' in drafted) {
      // The pipeline worked and the answer was no. Abstention over bluffing.
      audit.push({ step: 'declined_on_merits', detail: drafted.reason });
      audit.push({ step: 'abstained', detail: INSUFFICIENT_EVIDENCE_REASON });
      return {
        disputeId: collected.disputeId,
        outcome: 'abstained',
        abstentionReason: INSUFFICIENT_EVIDENCE_REASON,
        insufficientEvidenceReason: drafted.reason,
        collected,
        ...(traceSummary ? { traceSummary } : {}),
        ...(confirmation ? { confirmation } : {}),
        ambiguityFlags,
        audit,
      };
    }

    draft = buildContestDraft(collected, drafted.letter, amount);
    audit.push({
      step: 'contest_drafted',
      detail: `${drafted.letter.length} chars, ${draft.assignments.length} evidence fields populated`,
    });
  } catch (error) {
    if (error instanceof AssemblyFailure) {
      return abstain(collected, audit, ambiguityFlags, error);
    }
    throw error;
  }

  return {
    disputeId: collected.disputeId,
    outcome: 'assembled',
    collected,
    ...(traceSummary ? { traceSummary } : {}),
    ...(confirmation ? { confirmation } : {}),
    ambiguityFlags,
    draft,
    audit,
  };
}
