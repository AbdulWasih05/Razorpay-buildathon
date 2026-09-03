import process from 'node:process';

import { PrismaClient } from '@prisma/client';
import { CaptureClient, DEV_CONFIG, generateCorpus } from '@praman/simulator';

import { loadRootEnv } from './env.js';
import { buildServer } from './server.js';

loadRootEnv();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const SEED_ON_BOOT = process.env.SEED_ON_BOOT === 'true';
const SEED_SIZE = Number(process.env.SEED_SIZE ?? 100);

const prisma = new PrismaClient();
const app = buildServer({ prisma, logger: true });

/**
 * Seed the deployed instance on first boot (TASKS.md P4.3, "seed on boot").
 *
 * Two properties are deliberate.
 *
 * It goes **over HTTP through `POST /evidence-pack`**, against this very
 * process, exactly like `pnpm seed` does locally. There is no direct-to-Prisma
 * shortcut for the deployed case (D-012): if the capture endpoint were broken,
 * a boot seed that bypassed it would hide that fact behind a queue full of
 * disputes, which is the one thing the capture layer must never be able to do.
 *
 * And it is **conditional on an empty store**, not on a flag alone. Every
 * upsert here is idempotent, so re-seeding would be harmless, but a container
 * that reseeds on every restart would silently undo whatever a visitor did
 * between restarts and make the reset endpoint the second way to clean up
 * rather than the only one.
 */
async function seedIfEmpty(): Promise<void> {
  const client = new CaptureClient({ baseUrl: `http://127.0.0.1:${PORT}` });
  const existing = await prisma.dispute.count();
  if (existing > 0) {
    app.log.info({ disputes: existing }, 'store already seeded; skipping boot seed');
    return;
  }

  app.log.info({ size: SEED_SIZE, seed: DEV_CONFIG.seed }, 'seeding on boot through the capture API');
  const corpus = generateCorpus(DEV_CONFIG, SEED_SIZE);
  for (const dispute of corpus.disputes) {
    await client.captureEvidencePack(dispute.transaction.pack);
    await client.seedDispute(dispute);
  }
  app.log.info({ disputes: corpus.size }, 'boot seed complete');
}

async function main(): Promise<void> {
  await app.listen({ port: PORT, host: HOST });
  console.log(`praman api listening on http://localhost:${PORT}`);
  if (SEED_ON_BOOT) await seedIfEmpty();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
