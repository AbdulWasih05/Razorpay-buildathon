import process from 'node:process';

import { formatRegressions, readBaseline, regressions } from './baseline.js';
import { EVAL_SETS, buildClient, runSet } from './harness.js';
import { score } from './score.js';

/**
 * `pnpm eval:gate` — the regression check on its own, for CI.
 *
 * It replays both sets, scores them, and compares the counts against
 * `eval/baseline.json`. Exit code 1 means a number this project promised not to
 * lose has been lost. No key and no network: a gate that needed either would be
 * skipped in exactly the situation it exists for.
 *
 * The same verdict is printed at the end of `pnpm eval`. This exists so CI can
 * fail on it and write it to the job summary without running the report.
 */

async function main(): Promise<void> {
  const { client } = buildClient(false, {});
  const dev = score('dev', await runSet({ spec: EVAL_SETS.dev, client }));
  const holdout = score('holdout', await runSet({ spec: EVAL_SETS.holdout, client }));

  const found = regressions(readBaseline(), { dev, holdout });
  const summary = formatRegressions(found);
  console.log(summary);

  // GitHub renders this under the job, so a red run explains itself without
  // anyone opening the log.
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(stepSummary, `### Eval gate\n\n\`\`\`\n${summary}\n\`\`\`\n`);
  }

  if (found.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error('eval gate: the run threw before it could compare anything.');
  console.error(error);
  process.exit(1);
});
