import { SCENARIO_CLASSES, type ScenarioClass } from '@praman/core';

import type { GeneratorConfig } from './configs.js';
import { generateTransaction } from './transaction.js';
import { generateDispute, type GeneratedDispute } from './dispute.js';

/**
 * Builds a whole corpus from a config: allocate a class mix, generate one
 * transaction per slot, raise a dispute against each.
 *
 * Allocation uses largest-remainder rather than rounding each weight
 * independently, so the class counts always sum to exactly the requested size
 * and are identical on every run. Independent rounding would drift by a case or
 * two and quietly make "100 disputes" mean 98 or 103.
 */

export interface GeneratedCorpus {
  configName: string;
  corpus: 'dev' | 'ood_holdout';
  seed: string;
  size: number;
  disputes: GeneratedDispute[];
}

/** Exact, deterministic allocation of `size` across weighted classes. */
export function allocate(
  distribution: Record<ScenarioClass, number>,
  size: number,
): Record<ScenarioClass, number> {
  const total = SCENARIO_CLASSES.reduce((sum, cls) => sum + distribution[cls], 0);
  if (total <= 0) throw new Error('distribution weights must sum to a positive number');

  const exact = SCENARIO_CLASSES.map((cls) => ({
    cls,
    ideal: (distribution[cls] / total) * size,
  }));

  const counts = {} as Record<ScenarioClass, number>;
  let assigned = 0;
  for (const { cls, ideal } of exact) {
    counts[cls] = Math.floor(ideal);
    assigned += counts[cls];
  }

  // Hand out the remaining slots to the largest fractional parts. Ties break on
  // class order, which is fixed -- so this is deterministic.
  const remainders = exact
    .map(({ cls, ideal }) => ({ cls, frac: ideal - Math.floor(ideal) }))
    .sort((a, b) => b.frac - a.frac || SCENARIO_CLASSES.indexOf(a.cls) - SCENARIO_CLASSES.indexOf(b.cls));

  let cursor = 0;
  while (assigned < size) {
    const entry = remainders[cursor % remainders.length];
    if (entry) {
      counts[entry.cls] += 1;
      assigned += 1;
    }
    cursor += 1;
  }

  return counts;
}

export function generateCorpus(config: GeneratorConfig, size: number): GeneratedCorpus {
  const counts = allocate(config.distribution, size);
  const disputes: GeneratedDispute[] = [];

  // Iterating classes in fixed order, index ascending, keeps output order stable.
  let index = 0;
  for (const cls of SCENARIO_CLASSES) {
    for (let i = 0; i < counts[cls]; i += 1) {
      const transaction = generateTransaction(config, cls, index);
      disputes.push(generateDispute(config, transaction));
      index += 1;
    }
  }

  return {
    configName: config.name,
    corpus: config.corpus,
    seed: config.seed,
    size: disputes.length,
    disputes,
  };
}

export interface CorpusSummary {
  size: number;
  byRail: Record<string, number>;
  byClass: Record<string, number>;
  byGroundTruth: Record<string, number>;
  byPhase: Record<string, number>;
  /** Share of the corpus that is unwinnable or ambiguous. */
  hardShare: number;
  totalAmount: number;
}

/** Descriptive stats, used by the seed CLI and by EVAL.md. */
export function summarise(corpus: GeneratedCorpus): CorpusSummary {
  const byRail: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const byGroundTruth: Record<string, number> = {};
  const byPhase: Record<string, number> = {};
  let totalAmount = 0;

  for (const dispute of corpus.disputes) {
    byRail[dispute.rail] = (byRail[dispute.rail] ?? 0) + 1;
    byClass[dispute.scenarioClass] = (byClass[dispute.scenarioClass] ?? 0) + 1;
    byGroundTruth[dispute.groundTruth] = (byGroundTruth[dispute.groundTruth] ?? 0) + 1;
    const phase = dispute.event.payload.dispute.entity.phase;
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    totalAmount += dispute.amount;
  }

  const hard = (byGroundTruth.unwinnable ?? 0) + (byGroundTruth.ambiguous ?? 0);

  return {
    size: corpus.size,
    byRail,
    byClass,
    byGroundTruth,
    byPhase,
    hardShare: corpus.size === 0 ? 0 : hard / corpus.size,
    totalAmount,
  };
}
