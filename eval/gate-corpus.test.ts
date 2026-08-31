import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  SCENARIOS,
  blockingRules,
  collectEvidence,
  evaluateGate,
  evidencePackIngestSchema,
  type GateResult,
} from '@praman/core';
import { DEV_CONFIG, generateCorpus } from '@praman/simulator';
import type { ScenarioClass } from '@praman/core';

/**
 * TASKS.md P3.1 acceptance: "unit tests per scenario class; every abstention
 * carries a human-readable reason".
 *
 * The gate is pure and deterministic, so these are real unit tests over the
 * whole dev corpus rather than a sample.
 */

const CORPUS = 100;
const corpus = generateCorpus(DEV_CONFIG, CORPUS);

interface Evaluated {
  scenarioClass: ScenarioClass;
  groundTruth: string;
  gate: GateResult;
}

const evaluated: Evaluated[] = corpus.disputes.map((dispute) => {
  const entity = dispute.event.payload.dispute.entity;
  const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
  const collected = collectEvidence(pack, {
    disputeId: entity.id,
    reasonCode: entity.reason_code,
    network: SCENARIOS[dispute.scenarioClass].network,
    amount: entity.amount,
  });
  return {
    scenarioClass: dispute.scenarioClass,
    groundTruth: dispute.groundTruth,
    gate: evaluateGate(collected),
  };
});

function forClass(scenarioClass: ScenarioClass): Evaluated[] {
  return evaluated.filter((entry) => entry.scenarioClass === scenarioClass);
}

describe('every abstention carries a reason', () => {
  it('never abstains without saying why', () => {
    for (const { gate } of evaluated) {
      if (gate.decision !== 'abstain') continue;
      expect(gate.reason, gate.disputeId).toBeTruthy();
      expect((gate.reason as string).length).toBeGreaterThan(20);
    }
  });

  it('never contests while carrying a blocking rule', () => {
    for (const { gate } of evaluated) {
      if (gate.decision !== 'contest') continue;
      expect(blockingRules(gate), gate.disputeId).toEqual([]);
      expect(gate.reason).toBeUndefined();
    }
  });

  it('evaluates every rule, not just up to the first blocker', () => {
    // A reviewer needs all the reasons, not the earliest one.
    const multiBlocker = evaluated.find(({ gate }) => blockingRules(gate).length > 1);
    expect(multiBlocker).toBeDefined();
    expect(multiBlocker!.gate.rules.length).toBeGreaterThan(
      blockingRules(multiBlocker!.gate).length,
    );
  });
});

describe('the arithmetic classes, decided without reading a word', () => {
  it('b2 (mandate limit breach) always abstains, naming the cap', () => {
    const cases = forClass('b2');
    expect(cases.length).toBeGreaterThan(0);
    for (const { gate } of cases) {
      expect(gate.decision, gate.disputeId).toBe('abstain');
      expect(gate.reason).toMatch(/exceeds the .* mandate cap/);
    }
  });

  it('b3 (expired mandate) always abstains, naming the window', () => {
    const cases = forClass('b3');
    expect(cases.length).toBeGreaterThan(0);
    for (const { gate } of cases) {
      expect(gate.decision, gate.disputeId).toBe('abstain');
      expect(gate.reason).toMatch(/outside the mandate window/);
    }
  });

  it('b5 (compromised agent) always abstains on the anomaly signal', () => {
    // Defense-only: we do not defend genuine fraud.
    const cases = forClass('b5');
    expect(cases.length).toBeGreaterThan(0);
    for (const { gate } of cases) {
      expect(gate.decision, gate.disputeId).toBe('abstain');
      expect(gate.reason).toMatch(/anomaly signals/);
    }
  });

  it('b1 and b3 share reason code 128 and get opposite verdicts', () => {
    // The demo beat, asserted rather than hoped for. Same code, different
    // mandate facts, different answers -- the gate reads evidence, not labels.
    expect(SCENARIOS.b1.reasonCode).toBe('128');
    expect(SCENARIOS.b3.reasonCode).toBe('128');

    const b1Contested = forClass('b1').filter((e) => e.gate.decision === 'contest');
    const b3Abstained = forClass('b3').filter((e) => e.gate.decision === 'abstain');

    expect(b1Contested.length).toBeGreaterThan(0);
    expect(b3Abstained.length).toBe(forClass('b3').length);
  });
});

describe('the gate never contests a case the corpus calls unwinnable', () => {
  it('has no false positives on the dev corpus', () => {
    // The expensive error. A contested-unwinnable dispute costs the fee plus
    // handling time, and that is the false-positive cost P4.1 reports in rupees.
    const falsePositives = evaluated.filter(
      (entry) => entry.groundTruth === 'unwinnable' && entry.gate.decision === 'contest',
    );
    expect(
      falsePositives.map((entry) => `${entry.scenarioClass}/${entry.gate.disputeId}`),
    ).toEqual([]);
  });
});

describe('thresholds are configuration, not opinion baked into code', () => {
  const sample = evaluated.find((entry) => entry.gate.decision === 'abstain')!;

  it('records the thresholds it decided under', () => {
    expect(sample.gate.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('changes its mind when the coverage bar moves, and says so', () => {
    // Not a feature we ship loose -- it is how P4.1 shows sensitivity instead
    // of asserting that 1.0 was the right bar.
    const entity = corpus.disputes[0]!.event.payload.dispute.entity;
    const pack = evidencePackIngestSchema.parse(corpus.disputes[0]!.transaction.pack);
    const collected = collectEvidence(pack, {
      disputeId: entity.id,
      reasonCode: entity.reason_code,
      network: SCENARIOS[corpus.disputes[0]!.scenarioClass].network,
      amount: entity.amount,
    });
    const strict = evaluateGate(collected, { ...DEFAULT_THRESHOLDS, requiredCoverageRatio: 1.0 });
    const loose = evaluateGate(collected, { ...DEFAULT_THRESHOLDS, requiredCoverageRatio: 0 });
    expect(strict.thresholds.requiredCoverageRatio).toBe(1);
    expect(loose.thresholds.requiredCoverageRatio).toBe(0);
    expect(loose.rules.find((r) => r.id === 'required_evidence_coverage')?.passed).toBe(true);
  });

  it('is deterministic', () => {
    const first = JSON.stringify(evaluated.map((e) => e.gate.decision));
    const second = JSON.stringify(
      corpus.disputes.map((dispute) => {
        const entity = dispute.event.payload.dispute.entity;
        const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
        return evaluateGate(
          collectEvidence(pack, {
            disputeId: entity.id,
            reasonCode: entity.reason_code,
            network: SCENARIOS[dispute.scenarioClass].network,
            amount: entity.amount,
          }),
        ).decision;
      }),
    );
    expect(second).toBe(first);
  });
});

describe('what the gate does across the whole dev corpus', () => {
  it('reports its split, so a regression in behaviour is visible here first', () => {
    const contested = evaluated.filter((e) => e.gate.decision === 'contest').length;
    const abstained = evaluated.length - contested;
    // Not asserting an exact number -- asserting that it does both, materially.
    expect(contested).toBeGreaterThan(0);
    expect(abstained).toBeGreaterThan(0);
    expect(contested + abstained).toBe(CORPUS);
  });
});
