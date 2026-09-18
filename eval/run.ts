import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { loadRootEnv } from '../apps/api/src/env.js';

import {
  buildBaseline,
  formatRegressions,
  promptFingerprints,
  readBaseline,
  regressions,
  writeBaseline,
} from './baseline.js';
import {
  COST_MODEL,
  EVAL_SETS,
  buildClient,
  runSet,
  type EvalCase,
  type EvalSetName,
} from './harness.js';
import { renderReport, score } from './score.js';

/**
 * `pnpm eval` — the batch run (TASKS.md P4.1).
 *
 *   pnpm eval                 replay from committed recordings. No network, no key.
 *   pnpm eval -- --live       call the model and record. Deliberate, and rare.
 *   pnpm eval -- --set dev    score one set only (recordings still write through).
 *   pnpm eval -- --no-write   print the report without touching eval/results.md
 *   pnpm eval -- --write-baseline
 *                             rewrite eval/baseline.json from this run. Deliberate:
 *                             the gate compares against it, so the diff is the record
 *                             of which number moved and why.
 *
 * Replay is the default and the point. A replay miss throws instead of falling
 * back to a live call, so the failure mode of a stale fixture is a stopped run
 * rather than a quietly different number in a table nobody re-derives.
 *
 * This script scores. It cannot submit: neither it nor `harness.ts` imports
 * `@praman/adapter`, and `harness.test.ts` asserts that statically. Hard rule
 * #2's carve-out for eval mode is enforced by the module graph.
 */

const args = process.argv.slice(2);
const live = args.includes('--live');
const write = !args.includes('--no-write');
const setArg = args[args.indexOf('--set') + 1];
const sets: EvalSetName[] =
  args.includes('--set') && (setArg === 'dev' || setArg === 'holdout') ? [setArg] : ['dev', 'holdout'];

const rewriteBaseline = args.includes('--write-baseline');

const RESULTS_PATH = new URL('./results.md', import.meta.url);
/**
 * The same numbers as the report, in a shape a machine reads: the gate, the
 * matrix and any later tooling take this rather than parsing markdown. It
 * carries no timestamp, for the same reason the report does not -- two replay
 * runs must produce identical bytes.
 */
const RESULTS_JSON_PATH = new URL('./results.json', import.meta.url);

loadRootEnv();

async function main(): Promise<void> {
  const { client, provider, cache } = buildClient(live, process.env);

  console.log(
    `eval | provider=${provider.name} model=${provider.model} | ` +
      `mode=${live ? 'LIVE (recording)' : 'replay'} | ${cache.size} recordings on disk`,
  );
  if (live) {
    console.log(
      'LIVE: this run mints recordings. D-023 freezes the model once eval/results.md exists.',
    );
  }
  console.log('');

  const collected = new Map<EvalSetName, EvalCase[]>();

  for (const name of sets) {
    const spec = EVAL_SETS[name];
    console.log(`--- ${name} (${spec.size} disputes, seed ${spec.config.seed}) ---`);
    const cases = await runSet({
      spec,
      client,
      onCase: (evalCase, index, total) => {
        const coverage = `${evalCase.presentArtifacts}/${evalCase.requiredArtifacts}`;
        const verdict =
          evalCase.decision === 'contest'
            ? `contest  ${evalCase.draftChars ?? 0} chars, ${evalCase.evidenceFields ?? 0} fields`
            : `abstain  [${evalCase.abstentionClass}] ${evalCase.abstentionReason ?? ''}`;
        console.log(
          `  ${String(index).padStart(3)}/${total}  ${evalCase.externalId.padEnd(22)}  ` +
            `${evalCase.scenarioClass}  ${evalCase.rail.padEnd(8)}  ` +
            `${evalCase.network} ${evalCase.reasonCode.padEnd(5)}  ev ${coverage}  ${verdict}`,
        );
      },
    });
    collected.set(name, cases);
    console.log('');
  }

  // A one-set run is for recording and iteration; the committed report always
  // carries both, because a dev number without its held-out counterpart is
  // exactly the half-truth the eval design exists to prevent.
  if (!collected.has('dev') || !collected.has('holdout')) {
    console.log('single-set run: no report written (a report needs both sets).');
    return;
  }

  const devCases = collected.get('dev') as EvalCase[];
  const holdoutCases = collected.get('holdout') as EvalCase[];
  const dev = score('dev', devCases);
  const holdout = score('holdout', holdoutCases);
  const report = renderReport({
    dev,
    holdout,
    devCases,
    holdoutCases,
    provider: provider.name,
    model: provider.model,
  });

  const summary = {
    schema: 1,
    provider: provider.name,
    model: provider.model,
    prompts: promptFingerprints(),
    costModel: COST_MODEL,
    sets: { dev, holdout },
  };

  if (write) {
    writeFileSync(RESULTS_PATH, report);
    writeFileSync(RESULTS_JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`wrote ${RESULTS_PATH.pathname}`);
    console.log(`wrote ${RESULTS_JSON_PATH.pathname}`);
  } else {
    console.log(report);
  }

  if (rewriteBaseline) {
    writeBaseline(buildBaseline({ provider: provider.name, model: provider.model, dev, holdout }));
    console.log('\nwrote eval/baseline.json — the gate now compares against this run.');
    return;
  }

  // Say what CI will say, from the same numbers, so a regression is visible
  // here rather than first on a pull request.
  console.log('');
  try {
    console.log(formatRegressions(regressions(readBaseline(), { dev, holdout })));
  } catch {
    console.log('eval gate: no eval/baseline.json yet. Write one with `pnpm eval -- --write-baseline`.');
  }
}

main().catch((error: unknown) => {
  console.error('\nFAIL: the eval run threw. No report written.');
  console.error(error);
  process.exit(1);
});
