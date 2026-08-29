/**
 * Generate the out-of-distribution held-out corpus.
 *
 *   pnpm holdout:generate            # replay from the committed language cache
 *   pnpm holdout:generate -- --live  # call the second model and record
 *   pnpm holdout:generate -- --seed-api   # also push it into a running API
 *
 * The holdout differs from the dev corpus on every axis (see configs.ts), and
 * its conversation language is written by a different model from a different
 * lab. It is generated ONCE, here, and is never read during feature
 * development -- a guard test in eval/ enforces that.
 *
 * Two runs of this script with the committed cache produce the same corpus,
 * because the language is replayed rather than regenerated.
 */
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  CaptureClient,
  OOD_CONFIG,
  OodLanguageGenerator,
  generateCorpus,
  shift,
  summarise,
  type GeneratedCorpus,
} from '@praman/simulator';

process.loadEnvFile?.('.env');

const LIVE = process.argv.includes('--live');
const SEED_API = process.argv.includes('--seed-api');
const SIZE = Number(
  process.argv[process.argv.indexOf('--size') + 1] ?? (process.argv.includes('--size') ? '30' : '30'),
);

const CACHE_PATH = fileURLToPath(
  new URL('../packages/simulator/fixtures/ood-language.json', import.meta.url),
);
const HOLDOUT_PATH = fileURLToPath(new URL('../eval/holdout.json', import.meta.url));

const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

/**
 * Replace each agentic transaction's templated conversation with the
 * model-written one, preserving the seed-derived ids and timestamps so the
 * corpus stays deterministic.
 */
async function applyOodLanguage(corpus: GeneratedCorpus, generator: OodLanguageGenerator): Promise<void> {
  for (const dispute of corpus.disputes) {
    const trace = dispute.transaction.pack.conversationTrace;
    if (!trace) continue;

    const turns = await generator.turnsFor(dispute.transaction);
    const startedAt = new Date(String(trace.startedAt));

    trace.turns = turns.map((turn, seq) => ({
      externalId: `trn_${OOD_CONFIG.name}_${dispute.scenarioClass}_${dispute.transaction.index}_${seq}`,
      seq,
      role: turn.role,
      content: turn.content,
      occurredAt: shift(startedAt, seq * 2).toISOString(),
    }));
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  if (LIVE && !apiKey) {
    console.error('FAIL: --live needs GROQ_API_KEY in .env');
    process.exit(1);
  }

  console.log(`Generating held-out corpus "${OOD_CONFIG.name}" (seed: ${OOD_CONFIG.seed})`);
  console.log(`  size: ${SIZE}   language: ${MODEL}   mode: ${LIVE ? 'LIVE (recording)' : 'replay'}\n`);

  const corpus = generateCorpus(OOD_CONFIG, SIZE);

  const generator = new OodLanguageGenerator({
    apiKey: apiKey ?? '',
    model: MODEL,
    cachePath: CACHE_PATH,
    allowLive: LIVE,
  });

  await applyOodLanguage(corpus, generator);
  if (LIVE) generator.persist();

  const stats = summarise(corpus);
  const { liveCalls, cacheHits } = generator.stats;

  // The holdout manifest. Dev tooling reads this to know what it must not touch.
  const manifest = {
    config: OOD_CONFIG.name,
    corpus: OOD_CONFIG.corpus,
    seed: OOD_CONFIG.seed,
    size: corpus.size,
    languageModel: MODEL,
    languageSource: OOD_CONFIG.languageSource,
    note:
      'Out-of-distribution held-out set. Generated once, with a different model and a different ' +
      'prompt/persona set than the dev corpus. Never read during feature development -- see the ' +
      'guard test in eval/. Regenerating this file is a deliberate act, not a side effect.',
    disputeExternalIds: corpus.disputes.map((d) => d.externalId).sort(),
    razorpayDisputeIds: corpus.disputes.map((d) => d.disputeId).sort(),
    evidencePackExternalIds: corpus.disputes.map((d) => d.transaction.pack.externalId).sort(),
    distribution: stats.byClass,
    groundTruth: stats.byGroundTruth,
    byRail: stats.byRail,
    hardShare: Number(stats.hardShare.toFixed(4)),
  };

  writeFileSync(HOLDOUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Wrote ${HOLDOUT_PATH}`);
  console.log(`  language: ${cacheHits} from cache, ${liveCalls} live call(s)`);
  console.log('  by rail:        ', JSON.stringify(stats.byRail));
  console.log('  by class:       ', JSON.stringify(stats.byClass));
  console.log('  by ground truth:', JSON.stringify(stats.byGroundTruth));
  console.log(`  unwinnable or ambiguous: ${(stats.hardShare * 100).toFixed(1)}%`);

  if (SEED_API) {
    const baseUrl = process.env.PRAMAN_API_URL ?? 'http://localhost:3000';
    const client = new CaptureClient({ baseUrl });
    if (!(await client.health())) {
      console.error(`\nFAIL: no API at ${baseUrl}`);
      process.exit(1);
    }
    for (const dispute of corpus.disputes) {
      await client.captureEvidencePack(dispute.transaction.pack);
      await client.seedDispute(dispute);
    }
    console.log(`\nSeeded ${corpus.size} held-out disputes into ${baseUrl}`);
  }
}

main().catch((error: unknown) => {
  console.error('FAIL: holdout generation threw.');
  console.error(error);
  process.exit(1);
});
