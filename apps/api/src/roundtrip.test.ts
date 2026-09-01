import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evidencePackIngestSchema } from '@praman/core';
import { DEV_CONFIG, generateTransaction } from '@praman/simulator';

import { readPackAsIngest } from './review.js';
import { buildServer } from './server.js';

/**
 * The one integration test: an envelope through the real HTTP route, into
 * Postgres, and back out in a shape the domain accepts.
 *
 * It exists because of FAILURES.md F-014, and specifically because of how that
 * bug hid. `cleanRow` let a null relation through into a `.strict()` schema, so
 * 85 of 97 disputes failed ingest -- and **all 203 tests stayed green the whole
 * time**, because every one of them is pure: corpus in, collector out, no
 * database anywhere. The suite was strongest exactly where it was blind.
 *
 * The failure lives in the seam between "the domain logic is correct" and "the
 * row Postgres hands back is the shape the domain expects", and no pure test
 * can stand in that seam. This one does, and deliberately stays one test rather
 * than growing into a suite: its whole job is that the next cleanRow-class bug
 * cannot hide behind a green run.
 *
 * The case it leads with is the ABSENT relation, because that is the one that
 * actually broke. A round-trip that only exercises a populated refund
 * reproduces the original blindness precisely.
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
  // Visible, not silent. A guard that quietly skips is the failure mode
  // DECISIONS.md D-029 is about, so the reason is printed rather than implied
  // by an absence in the output. CI runs this in its `integration` job, which
  // has a Postgres service; the default job deliberately has no database.
  console.warn(
    '\n  [roundtrip.test.ts] SKIPPED: no reachable database.\n' +
      '  This is the only test covering the persistence path (F-014).\n' +
      '  Run `pnpm db:up` locally, or see the CI `integration` job.\n',
  );
}

describe.skipIf(!reachable)('an evidence pack survives the trip through Postgres', () => {
  const prisma = new PrismaClient();
  const app = buildServer({ prisma });

  // A prefix of its own, so this never collides with or mutates the seeded
  // corpus the eval measures.
  const config = { ...DEV_CONFIG, name: 'roundtrip-test' };

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function roundTrip(scenarioClass: 'a1' | 'a4' | 'b1', index: number) {
    const transaction = generateTransaction(config, scenarioClass, index);
    const response = await app.inject({
      method: 'POST',
      url: '/evidence-pack',
      payload: transaction.pack,
    });
    expect(response.statusCode, response.body).toBeLessThan(300);

    const readBack = await readPackAsIngest(prisma, transaction.pack.externalId);
    // The exact call that threw "Unrecognized key(s) in object: 'refund'".
    return evidencePackIngestSchema.parse(readBack);
  }

  it('round-trips an order with NO refund -- the case F-014 broke', async () => {
    // a1 is "goods not received": no refund exists, so Prisma returns
    // `refund: null` on the order, which is indistinguishable by value from a
    // null column. Every dispute of this shape failed ingest.
    const pack = await roundTrip('a1', 1);
    expect(pack.refund ?? null).toBeNull();
    expect(pack.order.externalId).toBeTruthy();
    expect(pack.payment.razorpayPaymentId).toMatch(/^pay_/);
  });

  it('round-trips an order WITH a refund, settlement reference intact', async () => {
    // P4.0(a). The UTR is the whole point of the field: it is what separates a
    // refund that was raised from one that was paid.
    const pack = await roundTrip('a4', 1);
    expect(pack.refund).toBeTruthy();
    expect(pack.refund?.status).toMatch(/^(created|processed|failed)$/);
    if (pack.refund?.status === 'processed') {
      expect(pack.refund.utr).toBeTruthy();
    } else {
      expect(pack.refund?.utr ?? null).toBeNull();
    }
  });

  it('round-trips the agentic envelope, mandate and trace and logs intact', async () => {
    // The rail the product is actually about. These are the fields that are
    // unrecoverable after the fact, so losing one in persistence would be the
    // most expensive possible round-trip bug.
    const pack = await roundTrip('b1', 1);
    expect(pack.mandate).toBeTruthy();
    expect(pack.agentic?.agentId).toBeTruthy();
    expect(pack.conversationTrace?.turns.length).toBeGreaterThan(0);
    expect(pack.orchestrationLogs.length).toBeGreaterThan(0);
  });

  it('is idempotent: capturing the same envelope twice changes nothing', async () => {
    // Seeding runs through this endpoint (D-012), and a reseed must not
    // duplicate or drift.
    const first = await roundTrip('a4', 2);
    const second = await roundTrip('a4', 2);
    expect(second).toEqual(first);
  });

  it('rejects an envelope carrying a key the schema does not declare', async () => {
    // The `.strict()` guarantee the whole capture-gap argument rests on: a
    // generator cannot invent a field, so an artifact the envelope has no slot
    // for is a product gap and not a corpus one (D-030).
    const transaction = generateTransaction(config, 'a1', 3);
    const response = await app.inject({
      method: 'POST',
      url: '/evidence-pack',
      payload: { ...transaction.pack, settlementProof: 'utr_invented' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain('settlementProof');
  });
});
