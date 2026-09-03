/**
 * Record the assembly responses the deployed demo will replay.
 *
 *   pnpm record:demo            # dry run: which releases need a recording
 *   pnpm record:demo -- --live  # call the model and record them
 *
 * Why this exists (FAILURES.md F-017). `POST /demo/release-dispute` mints
 * disputes at indices far above the seeded corpus so a visitor cannot disturb
 * the 100 the eval measures. That isolation is right, and it had a consequence
 * nobody had followed through: those indices have no recorded model responses,
 * the deployed instance runs in replay mode with no API key, and replay refuses
 * to fall back to a live call. So the first released dispute the gate CLEARED
 * failed with a replay miss -- the demo broke on precisely the case worth
 * demonstrating, while the ones it declined worked fine, because a declined
 * dispute never calls a model at all.
 *
 * This records the whole release pool once, on the frozen model of record, so
 * the demo is fully offline. It is additive: it touches no key any scored
 * dispute uses, and `eval/results.md` does not change. That is checked rather
 * than asserted -- `pnpm eval` after this run produces the same file, and a
 * test compares them.
 *
 * It walks the exact path the API walks -- same generator, same collector, same
 * gate, same assembler -- because a recording keyed by a slightly different
 * prompt is not a recording, it is a miss that will surface in front of an
 * audience.
 */
import process from 'node:process';

import {
  SCENARIOS,
  collectEvidence,
  evaluateGate,
  evidencePackIngestSchema,
} from '@praman/core';
import { AssemblyClient, ResponseCache, assembleDispute, providerFromEnv } from '@praman/llm';
import { DEV_CONFIG, generateDispute, generateTransaction } from '@praman/simulator';

import { DEMO_INDEX_BASE, DEMO_RELEASE_CAP, DEMO_SEQUENCE } from '../apps/api/src/demo.js';
import { loadRootEnv } from '../apps/api/src/env.js';

loadRootEnv();

const live = process.argv.includes('--live');

async function main(): Promise<void> {
  const provider = live
    ? providerFromEnv(process.env)
    : providerFromEnv({ GROQ_API_KEY: 'replay-only' });
  const cache = new ResponseCache();
  const client = new AssemblyClient({
    provider,
    cache,
    mode: live ? 'live' : 'replay',
    timeoutMs: 60_000,
  });

  console.log(
    `demo release pool: ${DEMO_RELEASE_CAP} disputes from index ${DEMO_INDEX_BASE} | ` +
      `provider=${provider.name} model=${provider.model} | ` +
      `mode=${live ? 'LIVE (recording)' : 'replay (dry run)'} | ${cache.size} recordings on disk`,
  );

  let missing = 0;

  for (let offset = 0; offset < DEMO_RELEASE_CAP; offset += 1) {
    const scenarioClass = DEMO_SEQUENCE[offset % DEMO_SEQUENCE.length]!;
    const index = DEMO_INDEX_BASE + offset;
    const transaction = generateTransaction(DEV_CONFIG, scenarioClass, index);
    const dispute = generateDispute(DEV_CONFIG, transaction);
    const entity = dispute.event.payload.dispute.entity;
    const pack = evidencePackIngestSchema.parse(transaction.pack);

    const collected = collectEvidence(pack, {
      disputeId: entity.id,
      reasonCode: entity.reason_code,
      network: SCENARIOS[scenarioClass].network,
      amount: entity.amount,
    });
    const gate = evaluateGate(collected);

    // A dispute the gate declines never reaches a model (D-025), so it needs no
    // recording and gets none. That is not an optimisation, it is the LLM
    // boundary: most of the release pool is offline-safe for free.
    if (gate.decision === 'abstain') {
      console.log(`  ${index}  ${scenarioClass}  gate abstains -- no model call, nothing to record`);
      continue;
    }

    const trace = pack.conversationTrace
      ? { turns: pack.conversationTrace.turns.map((t) => ({ role: t.role, content: t.content })) }
      : undefined;

    try {
      const assembled = await assembleDispute({
        client,
        collected,
        gate,
        ...(trace ? { trace } : {}),
        amount: entity.amount,
      });
      const outcome =
        assembled.outcome === 'assembled'
          ? `drafted ${assembled.draft?.summary.length ?? 0} chars`
          : `abstained [${assembled.abstentionClass}]`;
      console.log(`  ${index}  ${scenarioClass}  ${live ? 'recorded' : 'replayed'}: ${outcome}`);
    } catch (error) {
      missing += 1;
      console.log(
        `  ${index}  ${scenarioClass}  MISSING RECORDING -- ${(error as Error).name}`,
      );
    }
  }

  console.log(`\n${cache.size} recordings on disk`);
  if (missing > 0 && !live) {
    console.log(
      `${missing} release(s) would fail in the deployed demo. Record them: pnpm record:demo -- --live`,
    );
    process.exit(1);
  }
  if (missing > 0) {
    console.error(`FAIL: ${missing} release(s) still unrecorded after a live run.`);
    process.exit(1);
  }
  console.log('Every release the gate clears has a recorded response. The demo is offline-safe.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
