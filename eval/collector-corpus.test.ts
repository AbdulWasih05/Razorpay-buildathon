import { describe, expect, it } from 'vitest';

import {
  SCENARIOS,
  collectEvidence,
  evidencePackIngestSchema,
  requirementsForScenario,
  unmetRequirements,
  type CollectedEvidence,
} from '@praman/core';
import { DEV_CONFIG, generateCorpus } from '@praman/simulator';

/**
 * TASKS.md P2.2 acceptance, stated exactly:
 *
 *   "for 10 dev disputes, collector output contains every artifact the rubric
 *    requires or explicitly flags each missing one."
 *
 * This lives in eval/ rather than packages/core because it needs both the
 * domain and the corpus generator, and core must not depend on the simulator.
 *
 * Dev corpus only. The holdout guard tests cover the other direction.
 */

const CORPUS_SIZE = 10;

const corpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE);

function collectFor(index: number): CollectedEvidence {
  const dispute = corpus.disputes[index];
  if (!dispute) throw new Error(`no dispute at index ${index}`);
  const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
  const entity = dispute.event.payload.dispute.entity;
  return collectEvidence(pack, {
    disputeId: entity.id,
    // The reason code rides in on the webhook, exactly as it will in production.
    reasonCode: entity.reason_code,
    // The network does not appear on the dispute entity, so it comes from the
    // payment method in production; here the scenario definition carries it.
    network: SCENARIOS[dispute.scenarioClass].network,
    amount: entity.amount,
  });
}

const collected = Array.from({ length: CORPUS_SIZE }, (_, index) => collectFor(index));

describe('the collector over 10 dev disputes', () => {
  it('produces a report for every dispute', () => {
    expect(collected).toHaveLength(CORPUS_SIZE);
  });

  it('accounts for every artifact the rubric requires -- present or flagged', () => {
    // The acceptance criterion itself. No requirement may be silently dropped.
    collected.forEach((report, index) => {
      const required = report.rubric.requires.map((requirement) => requirement.artifact);
      const reported = report.findings.map((finding) => finding.artifact);
      expect(reported, `dispute ${index}`).toEqual(required);
    });
  });

  it('gives every non-present finding a stated reason', () => {
    // "Flags each missing one" means says why, not just says no.
    for (const report of collected) {
      for (const finding of unmetRequirements(report)) {
        expect(finding.reason, `${report.disputeId}/${finding.artifact}`).toBeTruthy();
        expect((finding.reason as string).length).toBeGreaterThan(15);
      }
    }
  });

  it('references real capture-store ids for everything it says it holds', () => {
    for (const report of collected) {
      for (const finding of report.findings) {
        if (finding.state !== 'present') continue;
        expect(finding.references.length, `${report.disputeId}/${finding.artifact}`).toBeGreaterThan(
          0,
        );
        for (const reference of finding.references) {
          expect(typeof reference).toBe('string');
          expect(reference.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('covers both rails', () => {
    const rails = new Set(collected.map((report) => report.rail));
    expect(rails.has('ordinary')).toBe(true);
    expect(rails.has('agentic')).toBe(true);
  });

  it('assesses each dispute against its scenario class rubric', () => {
    collected.forEach((report, index) => {
      const dispute = corpus.disputes[index];
      expect(report.rubric).toBe(requirementsForScenario(dispute!.scenarioClass));
    });
  });
});

describe('the collector is deterministic', () => {
  it('produces byte-identical output when run twice', () => {
    // Pure functions, no clock, no I/O. If this ever fails, the eval is no
    // longer reproducible and the OOD delta stops meaning anything.
    const second = Array.from({ length: CORPUS_SIZE }, (_, index) => collectFor(index));
    expect(JSON.stringify(second)).toBe(JSON.stringify(collected));
  });
});

describe('what the collector reports about the agentic rail', () => {
  const agentic = collected.filter((report) => report.rail === 'agentic');

  it('computes mandate arithmetic for every agentic dispute', () => {
    for (const report of agentic) {
      expect(report.mandate.present, report.disputeId).toBe(true);
      expect(typeof report.mandate.withinLimit).toBe('boolean');
      expect(typeof report.mandate.withinValidityWindow).toBe('boolean');
      expect(typeof report.mandate.consentBeforePayment).toBe('boolean');
    }
  });

  it('holds authorisation evidence on the agentic rail and not on the ordinary one', () => {
    // The thesis, as a test. UPI 128 asks for "internal logs to show
    // authorisation was obtained"; an agent purchase has them, a human
    // checkout in this store does not.
    for (const report of collected) {
      const finding = report.findings.find((f) => f.artifact === 'authorisation_evidence');
      if (!finding) continue;
      if (report.rail === 'agentic') {
        expect(finding.state, report.disputeId).toBe('present');
      } else {
        expect(finding.state, report.disputeId).toBe('absent');
        expect(finding.reason).toMatch(/ordinary checkout leaves no authorisation log/);
      }
    }
  });

  it('never reads conversation text -- only its shape', () => {
    // Turn content is the LLM layer's input. If it leaked into the collector's
    // deterministic output it would end up in the audit trail and, worse, make
    // gate decisions depend on natural language.
    for (const report of agentic) {
      const finding = report.findings.find((f) => f.artifact === 'customer_communication');
      if (!finding || finding.state !== 'present') continue;
      expect(Object.keys(finding.detail).sort()).toEqual(['roles', 'startedAt', 'turnCount']);
    }
  });
});

describe('the collector distinguishes missing from unobtainable', () => {
  it('reports duplicate-payment analysis as not capturable, never as "no duplicate"', () => {
    // A confident wrong answer here would contest a real duplicate charge.
    // See FAILURES.md F-010.
    for (const report of collected) {
      const finding = report.findings.find((f) => f.artifact === 'duplicate_payment_analysis');
      if (!finding) continue;
      expect(finding.state, report.disputeId).toBe('not_capturable');
      expect(finding.detail['isDuplicate']).toBeUndefined();
    }
  });

  it('lists structurally unavailable artifacts as a subset of the missing ones', () => {
    for (const report of collected) {
      for (const artifact of report.structurallyUnavailable) {
        expect(report.missingRequired, report.disputeId).toContain(artifact);
      }
    }
  });
});
