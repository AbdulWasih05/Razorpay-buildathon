/**
 * Assemble N dev disputes end to end (TASKS.md P2.3 / P2.4).
 *
 *   pnpm assemble            # replay from committed fixtures, no network
 *   pnpm assemble -- --live  # call the model and record
 *   pnpm assemble -- --size 10
 *
 * Dev corpus only. This script does not import OOD_CONFIG and never can reach
 * the holdout -- the static guard test in eval/ enforces that.
 *
 * It prints a per-dispute line and a summary. It never submits anything: there
 * is no adapter here, by construction.
 */
import { loadRootEnv } from '../apps/api/src/env.js';
import {
  SCENARIOS,
  collectEvidence,
  evidencePackIngestSchema,
  type CollectedEvidence,
} from '@praman/core';
import {
  AssemblyClient,
  ResponseCache,
  assembleDispute,
  providerFromEnv,
  type AssembledDispute,
} from '@praman/llm';
import { DEV_CONFIG, generateCorpus } from '@praman/simulator';

const args = process.argv.slice(2);
const live = args.includes('--live');
const sizeIndex = args.indexOf('--size');
const size = sizeIndex === -1 ? 10 : Number(args[sizeIndex + 1] ?? 10);

loadRootEnv();

async function main(): Promise<void> {
  const provider = live
    ? providerFromEnv(process.env)
    : // Replay needs no credentials at all. A placeholder keeps the replay key
      // stable without implying a key exists.
      providerFromEnv({ GROQ_API_KEY: 'replay-only' });

  const cache = new ResponseCache();
  const client = new AssemblyClient({
    provider,
    cache,
    mode: live ? 'live' : 'replay',
    timeoutMs: 60_000,
  });

  console.log(
    `assembling ${size} dev disputes | provider=${provider.name} model=${provider.model} | ` +
      `mode=${live ? 'LIVE (recording)' : 'replay'} | ${cache.size} recordings on disk`,
  );

  const corpus = generateCorpus(DEV_CONFIG, size);
  const results: AssembledDispute[] = [];

  for (const dispute of corpus.disputes) {
    const entity = dispute.event.payload.dispute.entity;
    const pack = evidencePackIngestSchema.parse(dispute.transaction.pack);
    let collected: CollectedEvidence;
    try {
      collected = collectEvidence(pack, {
        disputeId: entity.id,
        reasonCode: entity.reason_code,
        network: SCENARIOS[dispute.scenarioClass].network,
        amount: entity.amount,
      });
    } catch (error) {
      console.log(`  ${entity.id}  COLLECT FAILED  ${(error as Error).message}`);
      continue;
    }

    const trace = pack.conversationTrace
      ? { turns: pack.conversationTrace.turns.map((t) => ({ role: t.role, content: t.content })) }
      : undefined;

    const assembled = await assembleDispute({
      client,
      collected,
      ...(trace ? { trace } : {}),
      amount: entity.amount,
    });
    results.push(assembled);

    const coverage = `${collected.coverage.present}/${collected.coverage.required}`;
    if (assembled.outcome === 'assembled') {
      console.log(
        `  ${entity.id}  ${dispute.scenarioClass}  ${dispute.rail.padEnd(8)}  ` +
          `code ${entity.reason_code.padEnd(4)}  evidence ${coverage}  ` +
          `draft ${assembled.draft?.summary.length ?? 0} chars  ` +
          `fields ${assembled.draft?.assignments.length ?? 0}  ` +
          `flags ${assembled.ambiguityFlags.length}`,
      );
    } else {
      console.log(
        `  ${entity.id}  ${dispute.scenarioClass}  ${dispute.rail.padEnd(8)}  ` +
          `code ${entity.reason_code.padEnd(4)}  evidence ${coverage}  ` +
          `ABSTAINED [${assembled.failureKind ?? 'on merits'}]  ` +
          `${assembled.insufficientEvidenceReason ?? assembled.audit.find((e) => e.step === 'assembly_failed')?.detail ?? assembled.abstentionReason ?? ''}`,
      );
    }
  }

  const assembled = results.filter((r) => r.outcome === 'assembled').length;
  const abstained = results.length - assembled;
  console.log(
    `\n${results.length} processed | ${assembled} assembled | ${abstained} abstained | ` +
      `${cache.size} recordings on disk`,
  );

  // Ground truth is NOT scored here. Scoring is P4.1, in the eval harness, and
  // deliberately not in a script that can run live.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
