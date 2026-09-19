import type { PrismaClient } from '@prisma/client';

import { evidencePackIngestSchema } from '@praman/core';
import { DEV_CONFIG, generateDispute, generateTransaction } from '@praman/simulator';

import { captureEvidencePack } from './capture.js';

/**
 * Demo mode (TASKS.md P4.3).
 *
 * The deployed instance has a "release next dispute" trigger so a video can
 * show a dispute arriving rather than describing one that already arrived. That
 * trigger is a **state-mutating endpoint on the open internet with no auth**,
 * and the first reader of this repository is plausibly a security-minded
 * screener who will poke it. Three things follow, and they are requirements
 * rather than polish:
 *
 *   - it is rate limited, so hammering it cannot fill the queue with a thousand
 *     disputes and make the demo incoherent for the next visitor;
 *   - it is bounded, so even a patient attacker gets 20 and then nothing;
 *   - there is a reset, scoped to exactly what the demo itself created, so
 *     whatever a screener does to the demo, one call restores a clean state
 *     -- without touching the 100 disputes the eval actually measures.
 *
 * Demo disputes are generated at indices far above the seeded corpus and
 * carry their own `demo-` external-id prefix, so they can never collide with,
 * overwrite or be confused for the 100 disputes the eval measures. Nothing here
 * touches the eval corpus, and nothing here can reach the held-out set.
 *
 * That last sentence was false for `resetDemo` until FAILURES.md F-028: the
 * reset scanned every dispute in the database, not just `demo-`-prefixed
 * ones, and rewound the whole seeded corpus to `received` -- precisely
 * because a screener poked the reset button this docblock invited them to
 * poke. `demo.test.ts` now asserts the scope directly rather than leaving it
 * as a claim in a comment above code that did not enforce it.
 */

/** Demo disputes start here: far above the 100 seeded corpus indices. */
export const DEMO_INDEX_BASE = 500;

/** Even with unlimited patience, the queue cannot grow past this. */
export const DEMO_RELEASE_CAP = 20;

export const DEMO_PREFIX = 'demo-';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * A fixed-window counter, per caller, in memory.
 *
 * Deliberately not a dependency and deliberately not distributed. One process
 * serves this demo; a Redis-backed limiter would be more correct and would also
 * be a new service, a new failure mode and a new thing to explain, to protect a
 * button that seeds fake disputes. What it must do is make hammering pointless,
 * and a counter does that.
 *
 * The map is bounded by eviction on read rather than a timer, so an idle
 * process holds nothing and a busy one cannot accumulate a key per address
 * forever.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the call is allowed. Records the hit when it is. */
  take(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = this.now();
    this.evictExpired(now);

    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.limit) {
      const elapsed = now - entry.windowStart;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((this.windowMs - elapsed) / 1000),
      };
    }

    entry.count += 1;
    return { allowed: true, remaining: this.limit - entry.count, retryAfterSeconds: 0 };
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Releasing a dispute
// ---------------------------------------------------------------------------

export interface ReleasedDispute {
  externalId: string;
  providerDisputeId: string;
  scenarioClass: string;
  rail: string;
  reasonCode: string;
  amount: number;
  respondBy: string;
  released: number;
  remaining: number;
}

/**
 * The classes the demo releases, in order, cycling.
 *
 * b1 and b3 first and adjacent on purpose: they share reason code UPI 128 and
 * have opposite correct answers, so two consecutive releases show the same code
 * getting a contest and an abstention. That is the demo beat -- same code, the
 * gate read the mandate -- and it is worth more than a random draw.
 */
export const DEMO_SEQUENCE = ['b1', 'b3', 'a4', 'a1', 'b2'] as const;

export async function countDemoDisputes(prisma: PrismaClient): Promise<number> {
  return prisma.dispute.count({ where: { externalId: { startsWith: DEMO_PREFIX } } });
}

export async function releaseNextDispute(
  prisma: PrismaClient,
): Promise<ReleasedDispute | { capped: true; released: number }> {
  const released = await countDemoDisputes(prisma);
  if (released >= DEMO_RELEASE_CAP) return { capped: true, released };

  const scenarioClass = DEMO_SEQUENCE[released % DEMO_SEQUENCE.length]!;
  const index = DEMO_INDEX_BASE + released;

  const transaction = generateTransaction(DEV_CONFIG, scenarioClass, index);
  const pack = evidencePackIngestSchema.parse(transaction.pack);
  await captureEvidencePack(prisma, pack);

  const dispute = generateDispute(DEV_CONFIG, transaction);
  const entity = dispute.event.payload.dispute.entity;

  const payment = await prisma.payment.findUniqueOrThrow({
    where: {
      provider_providerPaymentId: { provider: 'razorpay', providerPaymentId: entity.payment_id },
    },
    select: { id: true },
  });

  const externalId = `${DEMO_PREFIX}${dispute.externalId}`;
  await prisma.dispute.upsert({
    where: { externalId },
    update: {},
    create: {
      externalId,
      provider: 'razorpay',
      providerDisputeId: entity.id,
      providerPaymentId: entity.payment_id,
      paymentId: payment.id,
      amount: entity.amount,
      currency: entity.currency,
      amountDeducted: entity.amount_deducted,
      reasonCode: entity.reason_code,
      reasonDescription: entity.reason_description ?? null,
      respondBy: new Date(entity.respond_by * 1000),
      status: entity.status,
      phase: entity.phase,
      raisedAt: new Date(entity.created_at * 1000),
      rail: dispute.rail,
      scenarioClass: dispute.scenarioClass,
      corpus: 'dev',
      seed: dispute.seed,
      groundTruth: dispute.groundTruth,
      groundTruthRationale: dispute.groundTruthRationale,
      occurredAt: dispute.raisedAt,
    },
  });

  return {
    externalId,
    providerDisputeId: entity.id,
    scenarioClass: dispute.scenarioClass,
    rail: dispute.rail,
    reasonCode: entity.reason_code,
    amount: entity.amount,
    respondBy: new Date(entity.respond_by * 1000).toISOString(),
    released: released + 1,
    remaining: DEMO_RELEASE_CAP - released - 1,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetSummary {
  demoDisputesRemoved: number;
}

/**
 * Restore a clean demo, touching only what the demo itself created.
 *
 * FAILURES.md F-028: this used to also rewind every dispute in the database
 * that was not `received` -- not scoped to `demo-`-prefixed rows at all. That
 * is not "restore a clean demo", it is "wipe the seeded eval corpus's
 * processed state", and it is exactly what happened live: a screener hitting
 * this endpoint (precisely the thing this module's own docblock says to
 * expect) rewound all 100 seeded disputes back to `received`, and nothing
 * reprocesses them automatically (`SEED_ON_BOOT` only runs when the store is
 * empty, D-035), so every dispute in the queue was left drafted-looking in
 * `dispute.state` but stuck at `received` in its own audit trail the moment
 * anyone reprocessed it -- the exact desync F-026 fixed the symptom of.
 * `rewindToReceived` heals a trail that has already been desynced this way;
 * this function is what must stop causing the desync in the first place.
 *
 * The scope is now identical to the query above it: `demo-`-prefixed rows,
 * and nothing else. A demo-released dispute is deleted outright -- its trail
 * is evidence of nothing, since it was never part of the corpus the eval
 * measures, and there is no "rewind" state for something with no legitimate
 * history to preserve. The AuditLog table's append-only contract therefore
 * never actually applies here: there is nothing left to append to, because
 * there is nothing left to preserve a history of. A seeded dispute is never
 * touched by this function, in any state, including `approved` or
 * `submitted` -- a judge who actually approves a real dispute during a
 * demo keeps that decision; `/demo/reset` does not undo it.
 */
export async function resetDemo(prisma: PrismaClient): Promise<ResetSummary> {
  const demoDisputes = await prisma.dispute.findMany({
    where: { externalId: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const demoIds = demoDisputes.map((row) => row.id);

  if (demoIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { disputeId: { in: demoIds } } });
    await prisma.dispute.deleteMany({ where: { id: { in: demoIds } } });
  }

  return { demoDisputesRemoved: demoIds.length };
}
