import { existsSync, readFileSync } from 'node:fs';

import { assertNotHoldoutFamily } from '@praman/llm';
import { describe, expect, it } from 'vitest';

import { fixturePathFor } from './harness.js';
import {
  MATRIX_MD,
  loadMatrixConfig,
  renderMatrix,
  runModel,
  type ModelRun,
} from './matrix-run.js';

/**
 * The model-family matrix.
 *
 * Two properties are worth a test. The comparison has to be **reproducible**,
 * like every other number here: replaying it twice must produce the same file,
 * which holds only because latency and token counts are read back from the
 * recordings rather than measured now. And its membership has to be **pinned**:
 * a matrix that quietly follows a provider's catalogue is not a comparison, and
 * a model from the holdout's own family would destroy the OOD delta it is
 * being compared on.
 *
 * Replay only. No key, no network.
 */

const config = loadMatrixConfig();

describe('the matrix is pinned, not discovered', () => {
  it('lists at least two families, so the comparison has something to compare', () => {
    expect(config.models.length).toBeGreaterThanOrEqual(2);
    expect(new Set(config.models.map((entry) => entry.family)).size).toBe(config.models.length);
  });

  it('records when and where the list came from', () => {
    expect(config.chosenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config.source).toMatch(/models/);
  });

  it('includes no model from the family that wrote the holdout', () => {
    for (const entry of config.models) {
      expect(() => assertNotHoldoutFamily(entry.model)).not.toThrow();
    }
  });

  it('has a committed fixture for every pinned model', () => {
    for (const entry of config.models) {
      const path = fixturePathFor(entry);
      expect(path, `${entry.model} has no fixture path`).toBeTruthy();
      expect(existsSync(path as string), `${entry.model}: ${path} is missing`).toBe(true);
    }
  });

  it('keeps every model in its own fixture, away from the model of record', () => {
    const paths = config.models.map((entry) => fixturePathFor(entry));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path).toContain('fixtures');
      // The frozen recordings behind eval/results.md live in assembly.json at
      // the fixtures root; a matrix run must never write there (D-023).
      expect((path as string).replace(/\\/g, '/')).not.toMatch(/fixtures\/assembly\.json$/);
    }
  });
});

describe('the comparison replays byte-identically', () => {
  async function runAll(): Promise<ModelRun[]> {
    const runs: ModelRun[] = [];
    for (const entry of config.models) runs.push(await runModel(entry, false));
    return runs;
  }

  it('produces the committed eval/matrix.md, twice', { timeout: 600_000 }, async () => {
    const first = renderMatrix(config, await runAll());
    const second = renderMatrix(config, await runAll());

    expect(second).toBe(first);
    expect(first.replace(/\r\n/g, '\n')).toBe(readFileSync(MATRIX_MD, 'utf8').replace(/\r\n/g, '\n'));
  });
});
