import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PROMPTS } from '@praman/llm';

import type { SetMetrics } from './score.js';

/**
 * The committed baseline, and the regression rules read against it.
 *
 * Two decisions shape this file.
 *
 * **Counts, never ratios.** A floor copied from a rounded figure fails against
 * the number it came from: 31/38 prints as 81.6%, and "recall >= 81.6%" is
 * false for the very run that produced it. Everything stored here is an integer
 * the report also shows.
 *
 * **A prompt is part of the system under test.** Editing a prompt body changes
 * what the model is asked and therefore what the numbers mean, so each prompt's
 * body is fingerprinted. A changed body with an unchanged version is a
 * regression -- not because the edit is wrong, but because the recordings and
 * the baseline no longer describe the prompt in the tree.
 *
 * Updating the baseline is deliberate: `pnpm eval -- --write-baseline`. The
 * diff then shows exactly which number moved, in a review, rather than a test
 * quietly agreeing with whatever today's run produced.
 */

export const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url));

export interface PromptFingerprint {
  version: number;
  sha256: string;
}

export interface BaselineSet {
  size: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  ambiguousContested: number;
  abstained: number;
  assemblyFailures: number;
  falsePositiveCostSubunits: number;
}

export interface Baseline {
  schema: 1;
  provider: string;
  model: string;
  prompts: Record<string, PromptFingerprint>;
  sets: Record<'dev' | 'holdout', BaselineSet>;
}

/** Each prompt's version and a hash of its body, as the tree has them now. */
export function promptFingerprints(): Record<string, PromptFingerprint> {
  const out: Record<string, PromptFingerprint> = {};
  for (const prompt of Object.values(PROMPTS)) {
    out[prompt.id] = {
      version: prompt.version,
      sha256: createHash('sha256').update(prompt.body).digest('hex'),
    };
  }
  return out;
}

export function baselineSet(metrics: SetMetrics): BaselineSet {
  return {
    size: metrics.size,
    truePositives: metrics.confusion.truePositives,
    falsePositives: metrics.confusion.falsePositives,
    falseNegatives: metrics.confusion.falseNegatives,
    trueNegatives: metrics.confusion.trueNegatives,
    ambiguousContested: metrics.confusion.ambiguousContested,
    abstained: metrics.abstained,
    assemblyFailures: metrics.byClass['assembly_failure'] ?? 0,
    falsePositiveCostSubunits: metrics.falsePositiveCostSubunits,
  };
}

export function buildBaseline(input: {
  provider: string;
  model: string;
  dev: SetMetrics;
  holdout: SetMetrics;
}): Baseline {
  return {
    schema: 1,
    provider: input.provider,
    model: input.model,
    prompts: promptFingerprints(),
    sets: { dev: baselineSet(input.dev), holdout: baselineSet(input.holdout) },
  };
}

export function readBaseline(path: string = BASELINE_PATH): Baseline {
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

export function writeBaseline(baseline: Baseline, path: string = BASELINE_PATH): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export interface Regression {
  where: string;
  what: string;
  baseline: string;
  now: string;
}

/**
 * What must never get worse without someone saying so.
 *
 * Deliberately one-directional. Fewer false positives, more true positives or a
 * cheaper mistake are all fine and do not need the baseline updated first; the
 * gate exists to catch a silent slide, not to freeze the numbers.
 */
export function regressions(
  baseline: Baseline,
  now: { dev: SetMetrics; holdout: SetMetrics },
  prompts: Record<string, PromptFingerprint> = promptFingerprints(),
): Regression[] {
  const found: Regression[] = [];

  for (const name of ['dev', 'holdout'] as const) {
    const before = baseline.sets[name];
    const after = baselineSet(now[name]);

    const worse = (
      what: string,
      baselineValue: number,
      nowValue: number,
      direction: 'rise' | 'drop',
    ): void => {
      const bad = direction === 'rise' ? nowValue > baselineValue : nowValue < baselineValue;
      if (bad) {
        found.push({
          where: name,
          what,
          baseline: String(baselineValue),
          now: String(nowValue),
        });
      }
    };

    worse('false positives rose', before.falsePositives, after.falsePositives, 'rise');
    worse(
      'false-positive cost rose (subunits)',
      before.falsePositiveCostSubunits,
      after.falsePositiveCostSubunits,
      'rise',
    );
    worse('true positives dropped', before.truePositives, after.truePositives, 'drop');
    worse('assembly failures rose', before.assemblyFailures, after.assemblyFailures, 'rise');
    worse('corpus size changed (grew)', before.size, after.size, 'rise');
    worse('corpus size changed (shrank)', before.size, after.size, 'drop');
  }

  for (const [id, fingerprint] of Object.entries(prompts)) {
    const before = baseline.prompts[id];
    if (!before) {
      found.push({
        where: 'prompts',
        what: `${id} is not in the baseline`,
        baseline: 'absent',
        now: `v${fingerprint.version}`,
      });
      continue;
    }
    if (before.sha256 !== fingerprint.sha256 && before.version === fingerprint.version) {
      found.push({
        where: 'prompts',
        what: `${id} body changed without a version bump`,
        baseline: `v${before.version} ${before.sha256.slice(0, 12)}`,
        now: `v${fingerprint.version} ${fingerprint.sha256.slice(0, 12)}`,
      });
    }
    if (before.version !== fingerprint.version) {
      found.push({
        where: 'prompts',
        what: `${id} version changed; re-record and rewrite the baseline in the same change`,
        baseline: `v${before.version}`,
        now: `v${fingerprint.version}`,
      });
    }
  }

  return found;
}

/** One line per regression, for a CI summary or a failing test message. */
export function formatRegressions(found: Regression[]): string {
  if (found.length === 0) return 'eval gate: no regression against eval/baseline.json';
  return [
    `eval gate: ${found.length} regression${found.length === 1 ? '' : 's'} against eval/baseline.json`,
    ...found.map((row) => `  - [${row.where}] ${row.what}: baseline ${row.baseline}, now ${row.now}`),
  ].join('\n');
}
