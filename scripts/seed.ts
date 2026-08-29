/**
 * Seed a corpus into the store -- entirely through the capture API.
 *
 *   pnpm seed                     # 100 dev disputes against a running API
 *   pnpm seed -- --size 60
 *   pnpm seed -- --config ood --size 30
 *
 * Order matters: the evidence pack is captured first, then the dispute is
 * recorded against it. That is the product's actual sequence -- evidence exists
 * at transaction time, the dispute arrives later -- and the API enforces it by
 * refusing a dispute whose payment was never captured.
 */
import process from 'node:process';

import { CaptureClient, DEV_CONFIG, generateCorpus, summarise } from '@praman/simulator';

process.loadEnvFile?.('.env');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const configName = arg('config', 'dev');
const size = Number(arg('size', '100'));
const baseUrl = arg('base-url', process.env.PRAMAN_API_URL ?? 'http://localhost:3000');

/**
 * This script seeds the DEV corpus and nothing else. It does not import
 * OOD_CONFIG at all, so there is no flag, typo or hurried late-night edit that
 * can point everyday development tooling at the held-out set. Seeding the
 * holdout is a separate, deliberate command:
 *
 *   pnpm holdout:generate -- --seed-api
 *
 * "We didn't peek" is worth more as a structural property than as a promise.
 */
if (configName !== 'dev') {
  console.error(`FAIL: this script seeds the dev corpus only (got --config ${configName}).`);
  console.error('The held-out set is generated and seeded separately:');
  console.error('  pnpm holdout:generate -- --seed-api');
  process.exit(1);
}

const config = DEV_CONFIG;

async function main(): Promise<void> {
  const client = new CaptureClient({ baseUrl });

  if (!(await client.health())) {
    console.error(`FAIL: no API at ${baseUrl}. Start it with: pnpm --filter @praman/api dev`);
    process.exit(1);
  }

  console.log(`Seeding ${size} disputes from config "${config.name}" (seed: ${config.seed})`);
  console.log(`  target: ${baseUrl}\n`);

  const corpus = generateCorpus(config, size);

  let captured = 0;
  let seeded = 0;
  for (const dispute of corpus.disputes) {
    await client.captureEvidencePack(dispute.transaction.pack);
    captured += 1;
    await client.seedDispute(dispute);
    seeded += 1;
    if (seeded % 20 === 0) console.log(`  ${seeded}/${corpus.size}...`);
  }

  const stats = summarise(corpus);
  console.log(`\nDone. ${captured} evidence packs captured, ${seeded} disputes seeded.\n`);
  console.log('  by rail:        ', JSON.stringify(stats.byRail));
  console.log('  by class:       ', JSON.stringify(stats.byClass));
  console.log('  by ground truth:', JSON.stringify(stats.byGroundTruth));
  console.log('  by phase:       ', JSON.stringify(stats.byPhase));
  console.log(`  unwinnable or ambiguous: ${(stats.hardShare * 100).toFixed(1)}%`);
  console.log(`  total at stake:  Rs ${(stats.totalAmount / 100).toLocaleString('en-IN')}`);
}

main().catch((error: unknown) => {
  console.error('FAIL: seeding threw.');
  console.error(error);
  process.exit(1);
});
