import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { callCostUsd } from '@praman/llm';

import {
  EVAL_SETS,
  buildClient,
  fixturePathFor,
  runSet,
  type EvalCase,
  type MatrixModel,
} from './harness.js';
import { score, type SetMetrics } from './score.js';

/**
 * The matrix, as a library: load the pinned config, score a model, render the
 * summary. `eval/matrix.ts` is the command-line wrapper that writes the files,
 * and `eval/matrix.test.ts` tests these functions without running a script.
 *
 * Everything here is deterministic on a replay run. Latency and token counts
 * come from the recordings rather than from this run, which is what lets the
 * committed `eval/matrix.md` be diffed like any other artefact.
 */

export const CONFIG_PATH = fileURLToPath(new URL('./matrix.config.json', import.meta.url));
export const OUT_DIR = fileURLToPath(new URL('./matrix/', import.meta.url));
export const MATRIX_MD = fileURLToPath(new URL('./matrix.md', import.meta.url));

export interface MatrixEntry extends MatrixModel {
  family: string;
  note: string;
}

export interface MatrixConfig {
  chosenOn: string;
  source: string;
  catalogueNote: string;
  models: MatrixEntry[];
}

export interface LatencySummary {
  measured: number;
  p50: number | null;
  p95: number | null;
}

export interface ModelRun {
  provider: string;
  model: string;
  family: string;
  note: string;
  sets: Record<'dev' | 'holdout', SetMetrics>;
  latency: LatencySummary;
  costUsd: number | null;
}

export function loadMatrixConfig(path: string = CONFIG_PATH): MatrixConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as MatrixConfig;
}

export function slugOf(entry: MatrixModel): string {
  return `${entry.provider}__${entry.model}`.replace(/[^a-z0-9.-]+/gi, '-');
}

/** Nearest-rank percentile over recorded latencies. Null when none were recorded. */
export function latencyOf(cases: EvalCase[]): LatencySummary {
  const values = cases
    .flatMap((c) => c.modelCalls)
    .map((call) => call.latencyMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return { measured: 0, p50: null, p95: null };
  const at = (q: number): number =>
    values[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)] as number;
  return { measured: values.length, p50: at(0.5), p95: at(0.95) };
}

export function totalCost(cases: EvalCase[]): number | null {
  const priced = cases
    .flatMap((c) => c.modelCalls)
    .map((call) => callCostUsd(call))
    .filter((cost): cost is number => cost !== null);
  return priced.length === 0 ? null : priced.reduce((sum, cost) => sum + cost, 0);
}

export async function runModel(
  entry: MatrixEntry,
  live: boolean,
  onProgress?: (line: string) => void,
): Promise<ModelRun> {
  const { client, provider } = buildClient(live, process.env, entry);
  onProgress?.(`${provider.name} ${provider.model} (${live ? 'LIVE, recording' : 'replay'})`);

  const cases: Record<'dev' | 'holdout', EvalCase[]> = { dev: [], holdout: [] };
  for (const name of ['dev', 'holdout'] as const) {
    cases[name] = await runSet({
      spec: EVAL_SETS[name],
      client,
      onCase: (_evalCase, index, total) => {
        if (index % 25 === 0 || index === total) onProgress?.(`  ${name} ${index}/${total}`);
      },
    });
  }

  const all = [...cases.dev, ...cases.holdout];
  return {
    provider: provider.name,
    model: provider.model,
    family: entry.family,
    note: entry.note,
    sets: { dev: score('dev', cases.dev), holdout: score('holdout', cases.holdout) },
    latency: latencyOf(all),
    costUsd: totalCost(all),
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const frac = (part: number, whole: number): string => `${part}/${whole}`;
const orDash = (value: number | null, suffix = ''): string =>
  value === null ? 'not recorded' : `${value}${suffix}`;

export function renderMatrix(config: MatrixConfig, runs: ModelRun[]): string {
  const out: string[] = [];
  out.push('# Praman — model family comparison');
  out.push('');
  out.push(
    'The same corpus, the same deterministic gate, and one row per **model family**. ' +
      'Every model here is served by Groq: these are model families, not providers.',
  );
  out.push('');
  out.push(
    `Pinned in \`eval/matrix.config.json\` on ${config.chosenOn}, from ${config.source}. ` +
      config.catalogueNote,
  );
  out.push('');
  out.push(
    '**The gate is identical on every row.** It is deterministic and runs before any model ' +
      '(D-025), so a dispute it declines makes no model call at all. Rows differ only where a ' +
      "drafter's judgement, or its ability to hold the output contract, differs.",
  );
  out.push('');

  const recall = (m: SetMetrics): string =>
    `${frac(m.confusion.truePositives, m.confusion.truePositives + m.confusion.falseNegatives)} = ${pct(m.recall)}`;

  out.push('## Decision quality');
  out.push('');
  out.push(
    '| family | model | recall dev | recall held-out | precision dev | precision held-out | false positives | assembly failures |',
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const { dev, holdout } = run.sets;
    out.push(
      `| ${run.family} | \`${run.model}\` | ${recall(dev)} | ${recall(holdout)} | ${pct(dev.precision)} | ${pct(holdout.precision)} | ` +
        `${dev.confusion.falsePositives} dev, ${holdout.confusion.falsePositives} held-out | ` +
        `${dev.byClass['assembly_failure'] ?? 0} dev, ${holdout.byClass['assembly_failure'] ?? 0} held-out |`,
    );
  }
  out.push('');
  out.push(
    'Zero false positives is partly a statement about the corpus, not only about the gate: most ' +
      'unwinnable cases are unwinnable by arithmetic. Do not quote a false-positive figure without ' +
      'that sentence.',
  );
  out.push('');

  out.push('## Abstention, and who abstained');
  out.push('');
  out.push(
    '| family | abstention dev | abstention held-out | gate | drafter disagreed | assembly failure |',
  );
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const { dev, holdout } = run.sets;
    const both = (key: string): string =>
      `${dev.byClass[key] ?? 0} dev, ${holdout.byClass[key] ?? 0} held-out`;
    out.push(
      `| ${run.family} | ${pct(dev.abstentionRate)} | ${pct(holdout.abstentionRate)} | ${both('gate')} | ` +
        `${both('drafter_disagreement')} | ${both('assembly_failure')} |`,
    );
  }
  out.push('');

  out.push('## What each run cost');
  out.push('');
  out.push(
    '| family | model calls | calls with token counts | input tokens | output tokens | p50 latency | p95 latency | cost (USD) |',
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const usage = {
      calls: run.sets.dev.usage.calls + run.sets.holdout.usage.calls,
      withUsage: run.sets.dev.usage.callsWithUsage + run.sets.holdout.usage.callsWithUsage,
      input: run.sets.dev.usage.inputTokens + run.sets.holdout.usage.inputTokens,
      output: run.sets.dev.usage.outputTokens + run.sets.holdout.usage.outputTokens,
    };
    out.push(
      `| ${run.family} | ${usage.calls} | ${usage.withUsage} | ${usage.input} | ${usage.output} | ` +
        `${orDash(run.latency.p50, ' ms')} | ${orDash(run.latency.p95, ' ms')} | ` +
        `${run.costUsd === null ? 'no published price' : `$${run.costUsd.toFixed(4)}`} |`,
    );
  }
  out.push('');
  out.push(
    'Latency is the figure recorded when each call was made, replayed rather than re-measured, so ' +
      'this file is byte-identical across replay runs. Prices come from the committed table in ' +
      '`packages/llm/src/pricing.ts`, which cites where and when each was read; a model with no ' +
      'published price reports none rather than a guess.',
  );
  out.push('');

  out.push('## Notes per model');
  out.push('');
  for (const run of runs) {
    out.push(`- **${run.family}** (\`${run.model}\`): ${run.note}`);
  }
  out.push('');
  out.push(
    'The headline numbers in `eval/results.md` stay the frozen model of record (D-023). This file ' +
      'is a comparison, never a replacement for them.',
  );
  out.push('');
  return out.join('\n');
}

export { fixturePathFor };
