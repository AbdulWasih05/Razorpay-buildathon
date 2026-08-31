import {
  AuditTrail,
  collectEvidence,
  evaluateGate,
  type CollectedEvidence,
  type DisputeContext,
  type DisputeState,
  type EvidencePackIngest,
  type GateResult,
  type GateThresholds,
} from '@praman/core';

import { assembleDispute, type AssembledDispute } from './assemble.js';
import type { AssemblyClient } from './client.js';

/**
 * The whole loop, in one place: capture store in, a reviewable draft or a
 * reasoned abstention out, with an audit trail of every state it passed
 * through (TASKS.md P3.2).
 *
 * Reading this function top to bottom is the fastest way to understand what
 * Praman does and, more importantly, what decides what:
 *
 *   collect  -- deterministic. Reports what the store holds.
 *   gate     -- deterministic. Decides contest or abstain.
 *   assemble -- the ONLY model call, and only if the gate said contest.
 *   map      -- deterministic. Puts artifacts in typed Razorpay fields.
 *
 * Nothing here submits. `processDispute` cannot reach `submitted` -- the
 * lifecycle refuses that transition from any state but `approved`, and only a
 * human actor can produce `approved`.
 */

export interface ProcessDisputeOptions {
  client: AssemblyClient;
  pack: EvidencePackIngest;
  dispute: DisputeContext;
  /** Domain time the dispute was raised. Never a wall clock. */
  raisedAt: Date;
  thresholds?: GateThresholds;
}

export interface ProcessedDispute {
  disputeId: string;
  state: DisputeState;
  collected: CollectedEvidence;
  gate: GateResult;
  assembled: AssembledDispute;
  trail: AuditTrail;
}

/**
 * Domain time for each step.
 *
 * Steps are stamped at one-second offsets from the dispute's own `raisedAt`
 * rather than from a clock. Two runs of the same corpus therefore produce
 * byte-identical trails, which is what lets the eval diff them. Real elapsed
 * time is not information the audit trail needs; ORDER is, and the sequence
 * number already carries it.
 */
function stepTime(raisedAt: Date, step: number): Date {
  return new Date(raisedAt.getTime() + step * 1000);
}

export async function processDispute(
  options: ProcessDisputeOptions,
): Promise<ProcessedDispute> {
  const { client, pack, dispute, raisedAt, thresholds } = options;
  const trail = new AuditTrail(dispute.disputeId);

  trail.append({
    toState: 'received',
    actor: 'system',
    detail: { reasonCode: dispute.reasonCode, network: dispute.network, amount: dispute.amount },
    occurredAt: stepTime(raisedAt, 0),
  });

  const collected = collectEvidence(pack, dispute);
  trail.append({
    toState: 'triaged',
    actor: 'system',
    reason: `${collected.coverage.present} of ${collected.coverage.required} required artifacts present`,
    detail: {
      findings: collected.findings.map((finding) => ({
        artifact: finding.artifact,
        state: finding.state,
        necessity: finding.necessity,
        ...(finding.reason ? { reason: finding.reason } : {}),
      })),
    },
    occurredAt: stepTime(raisedAt, 1),
  });

  const gate = evaluateGate(collected, thresholds);
  trail.append({
    toState: 'gated',
    actor: 'gate',
    reason: gate.decision === 'contest' ? 'all rules passed' : gate.reason,
    detail: { decision: gate.decision, rules: gate.rules, thresholds: gate.thresholds },
    occurredAt: stepTime(raisedAt, 2),
  });

  const trace = pack.conversationTrace
    ? {
        turns: pack.conversationTrace.turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
      }
    : undefined;

  const assembled = await assembleDispute({
    client,
    collected,
    gate,
    ...(trace ? { trace } : {}),
    amount: dispute.amount,
  });

  if (assembled.outcome === 'assembled') {
    trail.append({
      toState: 'drafted',
      actor: 'llm',
      reason: `${assembled.draft?.summary.length ?? 0} character draft across ${assembled.draft?.assignments.length ?? 0} evidence fields`,
      detail: {
        steps: assembled.audit,
        ambiguityFlags: assembled.ambiguityFlags,
        ...(assembled.confirmation ? { confirmation: assembled.confirmation } : {}),
      },
      occurredAt: stepTime(raisedAt, 3),
    });
  } else {
    trail.append({
      toState: 'abstained',
      // A gate abstention is the gate's; the other two classes happened in the
      // model layer, and the trail says which so nobody has to guess later.
      actor: assembled.abstentionClass === 'gate' ? 'gate' : 'llm',
      reason: assembled.abstentionReason,
      detail: {
        abstentionClass: assembled.abstentionClass,
        ...(assembled.failureKind ? { failureKind: assembled.failureKind } : {}),
        steps: assembled.audit,
      },
      occurredAt: stepTime(raisedAt, 3),
    });
  }

  return { disputeId: dispute.disputeId, state: trail.state, collected, gate, assembled, trail };
}
