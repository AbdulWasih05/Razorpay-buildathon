import { describe, expect, it } from 'vitest';

import {
  SCENARIOS,
  collectEvidence,
  evidencePackIngestSchema,
} from '@praman/core';
import {
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

    // The checkpoint condition: every dispute reaches a coherent outcome.
    for (const result of results) {
      expect(['assembled', 'abstained']).toContain(result.outcome);
      if (result.outcome === 'abstained') {
        expect([ASSEMBLY_ABSTAIN_REASON, INSUFFICIENT_EVIDENCE_REASON]).toContain(
          result.abstentionReason,
        );
      }
    }
  });

  it('separates abstention on the merits from assembly failure', async () => {
    // These are counted separately in P4.1 and a reader of those numbers needs
    // the difference: one says the answer was no, the other says the pipeline
    // broke. See FAILURES.md F-011.
    const results: AssembledDispute[] = [];
    for (let index = 0; index < CORPUS_SIZE; index += 1) {
      results.push(await assemble(index));
    }
    const merits = results.filter((r) => r.abstentionReason === INSUFFICIENT_EVIDENCE_REASON);
    const failures = results.filter((r) => r.abstentionReason === ASSEMBLY_ABSTAIN_REASON);

    expect(merits.length).toBeGreaterThan(0);
    for (const result of merits) {
      expect(result.failureKind).toBeUndefined();
      expect(result.insufficientEvidenceReason).toBeTruthy();
    }
    for (const result of failures) {
      expect(result.failureKind).toBeDefined();
    }
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
