import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AssemblyClient, providerFromEnv } from '@praman/llm';
import { DEV_CONFIG, generateDispute, generateTransaction } from '@praman/simulator';

import { runPipeline } from './review.js';
import { buildServer } from './server.js';

/**
 * FAILURES.md F-028.
 *
 * `resetDemo()` used to rewind EVERY dispute in the database that was not
 * `received` -- not scoped to `demo-`-prefixed rows at all. `demo.test.ts`'s
 * own docblock already claimed "the reset can delete one without touching
 * the other" (D-029's shape: a claim sitting above code that did not enforce
 * it), and nothing exercised `resetDemo` against real data to check.
 *
 * This is a database round-trip test, in the same family as roundtrip.test.ts
 * (F-014): the bug was never visible to a pure test because `resetDemo`'s
 * whole job is a Prisma query, and a query's scope cannot be wrong in a test
 * that never runs one against real rows.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

async function databaseReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

const reachable = await databaseReachable();

if (!reachable) {
  console.warn(
    '\n  [demo-reset.test.ts] SKIPPED: no reachable database.\n' +
      '  This is the only test covering the reset-scoping bug (F-028).\n' +
      '  Run `pnpm db:up` locally, or see the CI `integration` job.\n',
  );
}

describe.skipIf(!reachable)('resetDemo touches only what the demo itself created', () => {
  const prisma = new PrismaClient();
  const app = buildServer({ prisma });

  // A prefix of its own, isolated from the seeded corpus and from
  // roundtrip.test.ts's own fixtures the same way that file isolates itself.
  const config = { ...DEV_CONFIG, name: 'demo-reset-test' };

  // The same construction `server.ts` uses for a replay-mode server: a
  // provider that would fail if it were ever actually called over the
  // network, which is fine, because a gate-declined dispute never calls one
  // (D-025). Built directly, rather than through the HTTP route, so this test
  // processes exactly one dispute and cannot pick up unrelated `received`
  // rows that might already exist in a developer's local database.
  const assemblyClient = new AssemblyClient({
    provider: providerFromEnv({ GROQ_API_KEY: 'replay-only' }),
    mode: 'replay',
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('leaves a seeded dispute exactly as it was, mid-cycle, after a reset', async () => {
    // b3: expired mandate. The gate declines on arithmetic alone -- no model
    // call, so this is safe under replay with no recorded fixture for it.
    const transaction = generateTransaction(config, 'b3', 1);
    const captureResponse = await app.inject({
      method: 'POST',
      url: '/evidence-pack',
      payload: transaction.pack,
    });
    expect(captureResponse.statusCode, captureResponse.body).toBeLessThan(300);

    const dispute = generateDispute(config, transaction);
    const seedResponse = await app.inject({
      method: 'POST',
      url: '/seed/dispute',
      payload: {
        event: dispute.event,
        meta: {
          externalId: dispute.externalId,
          rail: dispute.rail,
          scenarioClass: dispute.scenarioClass,
          corpus: dispute.corpus,
          seed: dispute.seed,
          groundTruth: dispute.groundTruth,
          groundTruthRationale: dispute.groundTruthRationale,
        },
      },
    });
    expect(seedResponse.statusCode, seedResponse.body).toBe(201);

    const processed = await runPipeline({ prisma, client: assemblyClient }, dispute.externalId);
    expect(processed.state).toBe('abstained'); // b3 is gate-declined, deterministically

    const before = await app.inject({
      method: 'GET',
      url: `/review/disputes/${dispute.externalId}`,
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json();
    expect(beforeBody.state).toBe('abstained');
    expect(beforeBody.auditLogs.length).toBeGreaterThan(0);

    const resetResponse = await app.inject({ method: 'POST', url: '/demo/reset' });
    expect(resetResponse.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: `/review/disputes/${dispute.externalId}`,
    });
    expect(after.statusCode).toBe(200);
    // The exact property F-028 broke: reset must not touch this dispute at
    // all, not "reset it and then something reprocesses it back". Same
    // state, same trail, byte for byte.
    expect(after.json()).toEqual(beforeBody);
  });

  it('deletes a demo-released dispute entirely, and reports no seeded rewinds', async () => {
    const released = await app.inject({ method: 'POST', url: '/demo/release-dispute' });
    expect(released.statusCode).toBe(201);
    const externalId = released.json().externalId as string;
    expect(externalId.startsWith('demo-')).toBe(true);

    const existsBefore = await app.inject({
      method: 'GET',
      url: `/review/disputes/${externalId}`,
    });
    expect(existsBefore.statusCode).toBe(200);

    const resetResponse = await app.inject({ method: 'POST', url: '/demo/reset' });
    expect(resetResponse.statusCode).toBe(200);
    const summary = resetResponse.json();
    // The old shape carried `rewound`, counted over the whole table. There is
    // nothing left to rewind: a demo-released dispute is deleted, and a
    // seeded one is never touched, so the field no longer means anything and
    // no longer exists.
    expect(summary).toEqual({ demoDisputesRemoved: expect.any(Number) });
    expect(summary.demoDisputesRemoved).toBeGreaterThanOrEqual(1);

    const existsAfter = await app.inject({
      method: 'GET',
      url: `/review/disputes/${externalId}`,
    });
    expect(existsAfter.statusCode).toBe(404);
  });
});
