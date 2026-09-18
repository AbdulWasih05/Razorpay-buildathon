import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { loadRootEnv } from '../apps/api/src/env.js';

import { fixturePathFor } from './harness.js';
import {
  MATRIX_MD,
  OUT_DIR,
  loadMatrixConfig,
  renderMatrix,
  runModel,
  slugOf,
  type ModelRun,
} from './matrix-run.js';

/**
 * `pnpm eval:matrix` — the same corpus, scored on every pinned model family.
 *
 *   pnpm eval:matrix              replay each model from its own fixture file
 *   pnpm eval:matrix -- --live    call each model and record (deliberate, costs money)
 *   pnpm eval:matrix -- --only allam-2-7b
 *
 * Why it exists: the headline numbers are one model's numbers, and on their own
 * there is no way to tell a result about Praman's design from a result about
 * the model it happened to run on. Every row here shares the same deterministic
 * gate decisions, so the rows differ only where a drafter's judgement, or its
 * ability to hold the output contract, differs.
 *
 * What it is not: a change to the model of record. Each model records into its
 * own fixture file and the committed report keeps replaying from the frozen one
 * (D-023).
 */

async function main(): Promise<void> {
  loadRootEnv();
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;

  const config = loadMatrixConfig();
  const models = only ? config.models.filter((entry) => entry.model === only) : config.models;
  if (models.length === 0) throw new Error(`no model in matrix.config.json matches --only ${only}`);

  const runs: ModelRun[] = [];
  for (const entry of models) {
    console.log(`\n--- ${entry.family} ---`);
    console.log(`    fixture: ${fixturePathFor(entry)}`);
    runs.push(await runModel(entry, live, (line) => console.log(`    ${line}`)));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const run of runs) {
    const path = `${OUT_DIR}${slugOf(run)}.json`;
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`\nwrote ${path}`);
  }

  // A partial run must not rewrite the summary with a missing row.
  if (only) {
    console.log('\n--only run: eval/matrix.md not rewritten (it needs every pinned model).');
    return;
  }
  writeFileSync(MATRIX_MD, renderMatrix(config, runs));
  console.log(`wrote ${MATRIX_MD}`);
}

main().catch((error: unknown) => {
  console.error('\nFAIL: the matrix run threw. Nothing was written.');
  console.error(error);
  process.exit(1);
});
