import { describe, expect, it } from 'vitest';

import {
  ARTIFACTS,
  EVIDENCE_ARTIFACTS,
  RUBRIC,
  requirementsFor,
  requirementsForScenario,
  rubricCoverage,
  rubricKey,
  sourceableRequirements,
} from './rubric.js';
import { ALL_REASON_CODES, findReasonCode } from './reason-codes.js';
import { SCENARIOS, SCENARIO_CLASSES } from './scenarios.js';
import { CONTEST_EVIDENCE_DOCUMENT_FIELDS } from '../schema/contest.js';

describe('every scenario class has a non-empty required-evidence set', () => {
  // TASKS.md P2.1 acceptance, stated exactly.
  it.each([...SCENARIO_CLASSES])('%s maps to at least one required artifact', (scenarioClass) => {
    const entry = requirementsForScenario(scenarioClass);
    const required = entry.requires.filter((r) => r.necessity === 'required');
    expect(required.length).toBeGreaterThan(0);
  });

  it('and at least one requirement our capture layer can actually satisfy', () => {
    // A class whose every requirement is unsourceable could never be contested,
    // which would be a corpus design bug rather than a gate decision.
    for (const scenarioClass of SCENARIO_CLASSES) {
      const entry = requirementsForScenario(scenarioClass);
      expect(sourceableRequirements(entry).length, scenarioClass).toBeGreaterThan(0);
    }
  });
});

describe('provenance is honest', () => {
  it('marks a requirement `published` only where Razorpay actually published guidance', () => {
    // The guard against our opinion drifting into the docs column.
    for (const [key, entry] of Object.entries(RUBRIC)) {
      const publishedRequirements = entry.requires.filter((r) => r.provenance === 'published');
      if (!entry.hasPublishedGuidance) {
        expect(publishedRequirements, `${key} claims published guidance it does not have`).toEqual(
          [],
        );
      }
    }
  });

  it('quotes a source phrase that really appears in the published guidance', () => {
    // Not "cites the docs" -- checks the phrase is a substring of the verbatim
    // string transcribed from the page.
    for (const [key, entry] of Object.entries(RUBRIC)) {
      for (const requirement of entry.requires) {
        if (requirement.provenance !== 'published') continue;
        const reasonCode = findReasonCode(entry.network, entry.code);
        expect(reasonCode, key).toBeDefined();
        expect(requirement.sourcePhrase, `${key} published requirement has no phrase`).toBeTruthy();
        expect(
          reasonCode?.evidenceGuidance.includes(requirement.sourcePhrase as string),
          `${key}: "${requirement.sourcePhrase}" is not in the published guidance`,
        ).toBe(true);
      }
    }
  });

  it('gives every derived requirement a stated rationale', () => {
    for (const [key, entry] of Object.entries(RUBRIC)) {
      for (const requirement of entry.requires) {
        if (requirement.provenance !== 'derived') continue;
        expect(requirement.rationale, `${key}/${requirement.artifact}`).toBeTruthy();
        expect((requirement.rationale as string).length).toBeGreaterThan(20);
      }
    }
  });

  it('agrees with the reason-code table about which codes carry guidance', () => {
    for (const [key, entry] of Object.entries(RUBRIC)) {
      const reasonCode = findReasonCode(entry.network, entry.code);
      expect(reasonCode, key).toBeDefined();
      expect(entry.hasPublishedGuidance, key).toBe((reasonCode?.evidenceGuidance ?? '') !== '');
    }
  });

  it('consumes every published phrase for the four codes that have guidance', () => {
    // Razorpay lists its guidance comma-separated. If they publish a requirement
    // and we silently drop it, that is schema infidelity in the rubric.
    const guided = ALL_REASON_CODES.filter((code) => code.evidenceGuidance !== '');
    expect(guided).toHaveLength(4);
    for (const reasonCode of guided) {
      const entry = RUBRIC[rubricKey(reasonCode.network, reasonCode.code)];
      expect(entry, `${reasonCode.network}:${reasonCode.code}`).toBeDefined();
      const phrases = reasonCode.evidenceGuidance.split(', ').filter((p) => p.length > 0);
      const claimed = (entry?.requires ?? [])
        .filter((r) => r.provenance === 'published')
        .map((r) => r.sourcePhrase);
      for (const phrase of phrases) {
        expect(claimed, `${reasonCode.code} dropped "${phrase}"`).toContain(phrase);
      }
    }
  });
});

describe('artifacts map onto the real Razorpay contest fields', () => {
  it('lands every artifact in a documented typed evidence field', () => {
    const fields = new Set<string>(CONTEST_EVIDENCE_DOCUMENT_FIELDS);
    fields.add('others');
    for (const artifact of EVIDENCE_ARTIFACTS) {
      expect(fields.has(ARTIFACTS[artifact].contestField), artifact).toBe(true);
    }
  });

  it('gives every `others` artifact the type label Razorpay requires', () => {
    for (const artifact of EVIDENCE_ARTIFACTS) {
      const definition = ARTIFACTS[artifact];
      if (definition.contestField !== 'others') continue;
      expect(definition.othersType, artifact).toBeTruthy();
    }
  });

  it('states a reason for anything it cannot source', () => {
    for (const artifact of EVIDENCE_ARTIFACTS) {
      const definition = ARTIFACTS[artifact];
      if (definition.sourceable) continue;
      expect(definition.notSourceableReason, artifact).toBeTruthy();
    }
  });

  it('knows it cannot produce a bank statement for UPI 1061', () => {
    // Named explicitly because it is the one place the docs ask for something
    // a merchant transaction store structurally does not hold.
    expect(ARTIFACTS.refund_settlement_proof.sourceable).toBe(false);
    const entry = requirementsFor('upi', '1061');
    expect(entry?.requires.map((r) => r.artifact)).toContain('refund_settlement_proof');
    expect(sourceableRequirements(entry!).map((r) => r.artifact)).not.toContain(
      'refund_settlement_proof',
    );
  });
});

describe('the rubric covers the corpus', () => {
  it('has an entry for every transcribed reason code', () => {
    const { uncovered } = rubricCoverage();
    expect(uncovered).toEqual([]);
  });

  it('routes UPI 128 to authorisation evidence -- the thesis, as data', () => {
    // b1, b3 and b5 all arrive as UPI 128 with different correct answers. The
    // rubric is identical for all three; only the evidence differs. That is the
    // argument for a deterministic gate over a reason-code classifier.
    const entry = requirementsFor('upi', '128');
    const artifacts = entry?.requires.map((r) => r.artifact) ?? [];
    expect(artifacts).toContain('authorisation_evidence');
    expect(ARTIFACTS.authorisation_evidence.contestField).toBe('access_activity_log');

    const sharingCode128 = SCENARIO_CLASSES.filter(
      (c) => SCENARIOS[c].network === 'upi' && SCENARIOS[c].reasonCode === '128',
    );
    expect(sharingCode128.length).toBeGreaterThan(1);
    for (const scenarioClass of sharingCode128) {
      expect(requirementsForScenario(scenarioClass)).toBe(entry);
    }
  });

  it('returns undefined for a code it does not know, rather than guessing', () => {
    expect(requirementsFor('visa', '9999')).toBeUndefined();
  });
});
