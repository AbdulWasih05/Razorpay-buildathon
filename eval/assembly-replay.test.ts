import { describe, expect, it } from 'vitest';

import {
  SCENARIOS,
  collectEvidence,
  evaluateGate,
  evidencePackIngestSchema,
} from '@praman/core';
import {
  ABSTENTION_CLASSES,
  ASSEMBLY_ABSTAIN_REASON,
  AssemblyClient,
  INSUFFICIENT_EVIDENCE_REASON,
  OpenAiCompatibleProvider,
  ResponseCache,
  assembleDispute,
  type AssembledDispute,
} from '@praman/llm';
import { DEV_CONFIG, generateCorpus } from '@praman/simulator';

/**
 * TASKS.md P2.3 acceptance: "a snapshot test on one fixed dispute via replay".
 *
 * Everything here runs from the committed fixture. No API key, no network. If
 * this test ever tries to reach a model it fails with a replay miss instead of
 * quietly making a live call -- which is the property that makes the eval
 * numbers mean anything.
 */

const CORPUS_SIZE = 10;
const corpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE);

/**
 * The recorded provider identity. It is part of the replay key, so this is not
 * decoration -- change it and every lookup misses.
 */
const provider = new OpenAiCompatibleProvider(
  'groq',
  'qwen/qwen3.8-27b',
  'replay-only',
  'https://api.groq.com/openai/v1',
);

function client(): AssemblyClient {
  return new AssemblyClient({ provider, cache: new ResponseCache(), mode: 'replay' });
}

async function assemble(index: number): Promise<AssembledDispute> {
  const dispute = corpus.disputes[index]!;
  const entity = dispute.event.payload.dispute.entity;
  const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
  const collected = collectEvidence(pack, {
    disputeId: entity.id,
    reasonCode: entity.reason_code,
    network: SCENARIOS[dispute.scenarioClass].network,
    amount: entity.amount,
  });
  const trace = pack.conversationTrace
    ? { turns: pack.conversationTrace.turns.map((t) => ({ role: t.role, content: t.content })) }
    : undefined;
  return assembleDispute({
    client: client(),
    collected,
    gate: evaluateGate(collected),
    ...(trace ? { trace } : {}),
    amount: entity.amount,
  });
}

describe('one fixed dispute, assembled from the committed recording', () => {
  // b1: the flagship agentic case. Valid mandate, in limit, in window, customer
  // confirmed in the trace -- UPI 128's "internal logs to show authorisation
  // was obtained" genuinely exist for this one.
  const index = 5;

  it('is the dispute this test thinks it is', () => {
    const dispute = corpus.disputes[index]!;
    expect(dispute.scenarioClass).toBe('b1');
    expect(dispute.rail).toBe('agentic');
    expect(dispute.event.payload.dispute.entity.reason_code).toBe('128');
  });

  it('assembles a contest draft', async () => {
    const result = await assemble(index);
    expect(result.outcome).toBe('assembled');
    expect(result.draft).toBeDefined();
  });

  it('matches the recorded draft exactly', async () => {
    const result = await assemble(index);
    expect({
      outcome: result.outcome,
      confirmation: result.confirmation,
      ambiguityFlags: result.ambiguityFlags,
      summary: result.draft?.summary,
      assignments: result.draft?.assignments.map((assignment) => ({
        field: assignment.field,
        othersType: assignment.othersType,
        artifacts: assignment.artifacts,
      })),
      auditSteps: result.audit.map((entry) => entry.step),
    }).toMatchSnapshot();
  });

  it('keeps the drafted letter inside the documented 1000 characters', async () => {
    const result = await assemble(index);
    expect(result.draft!.summary.length).toBeLessThanOrEqual(1000);
  });

  it('routes evidence to real Razorpay fields, with capture-store references', async () => {
    const result = await assemble(index);
    const fields = result.draft!.assignments.map((assignment) => assignment.field);
    // UPI 128's published requirement lands in access_activity_log: the
    // orchestration log IS the authorisation log.
    expect(fields).toContain('access_activity_log');
    for (const assignment of result.draft!.assignments) {
      expect(assignment.references.length).toBeGreaterThan(0);
    }
  });

  it('is byte-identical across two replay runs', async () => {
    const [first, second] = await Promise.all([assemble(index), assemble(index)]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('all ten disputes replay without touching a model', () => {
  it('produces an outcome for each, with no assembly failures on the recorded set', async () => {
    const results: AssembledDispute[] = [];
    for (let index = 0; index < CORPUS_SIZE; index += 1) {
      results.push(await assemble(index));
    }
    expect(results).toHaveLength(CORPUS_SIZE);

    // The checkpoint condition: every dispute reaches a coherent outcome, and
    // every abstention says why in its own words.
    for (const result of results) {
      expect(['assembled', 'abstained']).toContain(result.outcome);
      if (result.outcome !== 'abstained') continue;
      expect(ABSTENTION_CLASSES).toContain(result.abstentionClass);
      expect(result.abstentionReason, result.disputeId).toBeTruthy();
      expect((result.abstentionReason as string).length).toBeGreaterThan(20);
    }
  });

  it('calls no model at all for a dispute the gate declined', async () => {
    // The strongest statement of the LLM boundary available: a dispute the
    // deterministic rules turned down never reaches a model, so no model output
    // can have influenced its outcome. Asserted by the audit trail, which would
    // carry a trace_summarised or contest_drafted step if one had been called.
    for (let index = 0; index < CORPUS_SIZE; index += 1) {
      const result = await assemble(index);
      if (result.abstentionClass !== 'gate') continue;
      const steps = result.audit.map((entry) => entry.step);
      expect(steps, result.disputeId).toEqual(['evidence_collected', 'gated', 'abstained']);
    }
  });

  it('keeps the three abstention classes apart', async () => {
    // P4.1 counts these separately and a reader of those numbers needs the
    // difference: the rules said no, two readings disagreed, or the pipeline
    // broke. Collapsing them is F-011, which nearly inverted the headline
    // metric. On the recorded dev set every abstention is a gate decision --
    // asserted rather than assumed, so a regression shows up here.
    const results: AssembledDispute[] = [];
    for (let index = 0; index < CORPUS_SIZE; index += 1) {
      results.push(await assemble(index));
    }

    for (const result of results.filter((r) => r.abstentionClass === 'gate')) {
      expect(result.failureKind, result.disputeId).toBeUndefined();
      expect(result.insufficientEvidenceReason).toBeUndefined();
      expect(result.abstentionReason).toBe(result.gate.reason);
    }
    for (const result of results.filter((r) => r.abstentionClass === 'drafter_disagreement')) {
      expect(result.failureKind).toBeUndefined();
      expect(result.insufficientEvidenceReason).toBeTruthy();
      expect(result.abstentionReason).toBe(INSUFFICIENT_EVIDENCE_REASON);
    }
    for (const result of results.filter((r) => r.abstentionClass === 'assembly_failure')) {
      expect(result.failureKind).toBeDefined();
      expect(result.abstentionReason).toBe(ASSEMBLY_ABSTAIN_REASON);
    }

    expect(results.filter((r) => r.abstentionClass === 'assembly_failure')).toHaveLength(0);
  });

  it('correctly declines the two cases that are unwinnable by arithmetic', async () => {
    // b2 breaches the mandate cap, b3 falls outside the validity window. Both
    // are decided by a `<=` and an interval comparison in the collector, and
    // both must abstain. A system that contested these would be the liability
    // the project exists not to be.
    for (let index = 0; index < CORPUS_SIZE; index += 1) {
      const dispute = corpus.disputes[index]!;
      if (dispute.scenarioClass !== 'b2' && dispute.scenarioClass !== 'b3') continue;
      const result = await assemble(index);
      expect(result.outcome, `${dispute.scenarioClass} ${dispute.disputeId}`).toBe('abstained');
    }
  });
});
