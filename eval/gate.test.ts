import { describe, expect, it } from 'vitest';

import {
  baselineSet,
  formatRegressions,
  promptFingerprints,
  readBaseline,
  regressions,
  type Baseline,
} from './baseline.js';
import { EVAL_SETS, buildClient, runSet } from './harness.js';
import { score, type SetMetrics } from './score.js';

/**
 * The eval regression gate.
 *
 * Tested in both directions, because a gate that cannot fail is worse than no
 * gate (D-029): one test asserts the committed baseline still holds, and the
 * rest feed it inputs that must be rejected.
 *
 * Replay only, so this runs in CI with no key and no network.
 */

let cached: { dev: SetMetrics; holdout: SetMetrics } | null = null;

async function metrics(): Promise<NonNullable<typeof cached>> {
  if (cached) return cached;
  const { client } = buildClient(false, {});
  cached = {
    dev: score('dev', await runSet({ spec: EVAL_SETS.dev, client })),
    holdout: score('holdout', await runSet({ spec: EVAL_SETS.holdout, client })),
  };
  return cached;
}

describe('the committed baseline still holds', () => {
  it('finds no regression on a replay run', { timeout: 120_000 }, async () => {
    const found = regressions(readBaseline(), await metrics());
    // The formatted message rather than the array: a failure here should say
    // which number moved, not that two objects differ.
    expect(formatRegressions(found)).toBe(
      'eval gate: no regression against eval/baseline.json',
    );
  });

  it('describes the same run the baseline was written from', { timeout: 120_000 }, async () => {
    const baseline = readBaseline();
    const { dev, holdout } = await metrics();
    expect(baselineSet(dev)).toEqual(baseline.sets.dev);
    expect(baselineSet(holdout)).toEqual(baseline.sets.holdout);
  });
});

describe('the gate catches what it exists to catch', () => {
  async function against(mutate: (metrics: { dev: SetMetrics; holdout: SetMetrics }) => void) {
    const { dev, holdout } = await metrics();
    const now = {
      dev: structuredClone(dev) as SetMetrics,
      holdout: structuredClone(holdout) as SetMetrics,
    };
    mutate(now);
    return regressions(readBaseline(), now);
  }

  it('fails when a false positive appears', { timeout: 120_000 }, async () => {
    const found = await against((now) => {
      now.holdout.confusion.falsePositives += 1;
      now.holdout.falsePositiveCostSubunits += 150_000;
    });
    expect(found.map((row) => row.what)).toEqual(
      expect.arrayContaining(['false positives rose', 'false-positive cost rose (subunits)']),
    );
  });

  it('fails when recall drops', { timeout: 120_000 }, async () => {
    const found = await against((now) => {
      now.dev.confusion.truePositives -= 1;
    });
    expect(found.map((row) => row.what)).toContain('true positives dropped');
  });

  it('fails when an assembly failure appears', { timeout: 120_000 }, async () => {
    const found = await against((now) => {
      now.dev.byClass['assembly_failure'] = (now.dev.byClass['assembly_failure'] ?? 0) + 1;
    });
    expect(found.map((row) => row.what)).toContain('assembly failures rose');
  });

  it('accepts an improvement without needing the baseline rewritten first', { timeout: 120_000 }, async () => {
    const found = await against((now) => {
      now.dev.confusion.truePositives += 2;
      now.holdout.confusion.falsePositives -= 0;
    });
    expect(found).toEqual([]);
  });
});

describe('a prompt is part of the system under test', () => {
  function baselineWithPrompts(prompts: Baseline['prompts']): Baseline {
    return { ...readBaseline(), prompts };
  }

  it('fails when a prompt body changes with no version bump', { timeout: 120_000 }, async () => {
    const current = promptFingerprints();
    const tampered = Object.fromEntries(
      Object.entries(current).map(([id, fingerprint]) => [
        id,
        { version: fingerprint.version, sha256: 'a'.repeat(64) },
      ]),
    );
    const found = regressions(baselineWithPrompts(tampered), await metrics(), current);
    expect(found.some((row) => row.what.includes('body changed without a version bump'))).toBe(true);
  });

  it('fails when a prompt version moves, so the baseline must be rewritten with it', { timeout: 120_000 }, async () => {
    const current = promptFingerprints();
    const older = Object.fromEntries(
      Object.entries(current).map(([id, fingerprint]) => [
        id,
        { version: fingerprint.version - 1, sha256: fingerprint.sha256 },
      ]),
    );
    const found = regressions(baselineWithPrompts(older), await metrics(), current);
    expect(found.some((row) => row.what.includes('version changed'))).toBe(true);
  });

  it('knows about every prompt the client loads', { timeout: 120_000 }, async () => {
    // A guard over an empty set is vacuously true (D-029), so assert there is
    // something to check before trusting the checks above.
    const ids = Object.keys(promptFingerprints());
    expect(ids).toEqual(expect.arrayContaining(['trace-summary', 'letter-draft']));
    expect(Object.keys(readBaseline().prompts)).toEqual(expect.arrayContaining(ids));
  });
});
