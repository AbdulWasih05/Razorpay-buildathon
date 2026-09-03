import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { loadRootEnv } from '../apps/api/src/env.js';

import { EVAL_SETS, buildClient, runSet, type EvalCase, type EvalSetName } from './harness.js';
import { renderReport, score } from './score.js';

/**
 * `pnpm eval` — the batch run (TASKS.md P4.1).
 *
 *   pnpm eval                 replay from committed recordings. No network, no key.
 *   pnpm eval -- --live       call the model and record. Deliberate, and rare.
 *   pnpm eval -- --set dev    score one set only (recordings still write through).
 *   pnpm eval -- --no-write   print the report without touching eval/results.md
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

const RESULTS_PATH = new URL('./results.md', import.meta.url);

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
  const report = renderReport({
    dev: score('dev', devCases),
    holdout: score('holdout', holdoutCases),
    devCases,
    holdoutCases,
    provider: provider.name,
    model: provider.model,
    recordings: cache.size,
  });

  if (write) {
    writeFileSync(RESULTS_PATH, report);
    console.log(`wrote ${RESULTS_PATH.pathname}`);
  } else {
    console.log(report);
  }
}

main().catch((error: unknown) => {
  console.error('\nFAIL: the eval run threw. No report written.');
  console.error(error);
  process.exit(1);
});
