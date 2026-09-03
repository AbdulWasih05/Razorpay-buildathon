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
 *   - there is a reset, so whatever anyone does, one call restores a clean
 *     state.
 *
 * Demo disputes are generated at indices far above the seeded corpus and
 * carry their own `demo-` external-id prefix, so they can never collide with,
 * overwrite or be confused for the 100 disputes the eval measures. Nothing here
 * touches the eval corpus, and nothing here can reach the held-out set.
 */

/** Demo disputes start here: far above the 100 seeded corpus indices. */
const DEMO_INDEX_BASE = 500;

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
  razorpayDisputeId: string;
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
const DEMO_SEQUENCE = ['b1', 'b3', 'a4', 'a1', 'b2'] as const;

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
    where: { razorpayPaymentId: entity.payment_id },
    select: { id: true },
  });

  const externalId = `${DEMO_PREFIX}${dispute.externalId}`;
  await prisma.dispute.upsert({
    where: { externalId },
    update: {},
    create: {
      externalId,
      razorpayDisputeId: entity.id,
      razorpayPaymentId: entity.payment_id,
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
    razorpayDisputeId: entity.id,
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
  rewound: number;
  demoDisputesRemoved: number;
}

/**
 * Restore a clean demo, without erasing an audit trail.
 *
 * The AuditLog table's contract is that it is append-only -- "nothing in this
 * table is ever updated or deleted" -- and a reset that quietly truncated it
 * would make that sentence false in the one place someone would check. So the
 * reset **rewinds state and appends a record that it did**: every seeded
 * dispute goes back to `received` with its pipeline output cleared, and the
 * trail gains a `demo_reset` entry saying so. The history of the demo remains
 * legible after the demo has been reset, which is the whole point of having a
 * trail rather than a status column.
 *
 * Disputes the demo itself released are a different case and are deleted
 * outright. They were never part of the corpus, their trail is evidence of
 * nothing, and leaving them would mean "reset" did not.
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

  const dirty = await prisma.dispute.findMany({
    where: { state: { not: 'received' } },
    select: { id: true, state: true },
  });

  const now = new Date();
  for (const dispute of dirty) {
    const seq = await prisma.auditLog.count({ where: { disputeId: dispute.id } });
    await prisma.auditLog.create({
      data: {
        disputeId: dispute.id,
        seq,
        fromState: dispute.state,
        toState: 'received',
        actor: 'system:demo_reset',
        reason: 'demo reset requested; pipeline output cleared, trail retained',
        occurredAt: now,
      },
    });
    await prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        state: 'received',
        gateDecision: null,
        gateReason: null,
        abstentionClass: null,
        collectedJson: undefined,
        contestDraftJson: undefined,
        submittedRequestJson: undefined,
        approvedBy: null,
        approvedAt: null,
      },
    });
  }

  return { rewound: dirty.length, demoDisputesRemoved: demoIds.length };
}
