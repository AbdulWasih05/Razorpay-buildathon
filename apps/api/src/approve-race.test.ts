import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { SimulatorClient } from '@praman/adapter';

import { approveAndSubmit } from './review.js';

/**
 * Two approvals racing on one dispute.
 *
 * The check that used to guard this was a read: load the dispute, see
 * `drafted`, carry on. Two callers -- a double click, a retried request, two
 * reviewers on the same case -- both read `drafted`, both pass, and both go on
 * to upload documents and submit. The window is every await between the read
 * and the write, which includes the network calls to the provider.
 *
 * The fix is a conditional write: `state: 'drafted'` in the WHERE clause of an
 * `updateMany`, which the database serialises, so exactly one caller sees
 * `count: 1`.
 *
 * This test pins OUR half of that: given a store where only the first
 * conditional update matches, exactly one approval proceeds and the loser
 * reaches neither the document upload nor the submit. It does not re-test that
 * Postgres serialises an UPDATE, which is Postgres's promise, not ours.
 */

interface FakeState {
  state: string;
  updates: number;
}

/**
 * The few Prisma calls `approveAndSubmit` makes, backed by one variable.
 *
 * `updateMany` is the interesting one: it only matches while the row is still
 * `drafted`, exactly like the real WHERE clause, so the second caller gets
 * `count: 0` the way it would against a database.
 */
function fakePrisma(row: FakeState, draft: unknown) {
  return {
    dispute: {
      findUnique: async () => ({
        id: 'row-1',
        externalId: 'dsp_race',
        razorpayDisputeId: 'disp_SIMrace00000000',
        state: row.state,
        provider: 'razorpay' as const,
        contestDraftJson: draft,
        auditLogs: [
          {
            seq: 0,
            fromState: null,
            toState: 'received',
            actor: 'system',
            reason: null,
            detail: null,
            occurredAt: new Date('2026-06-01T00:00:00.000Z'),
          },
          {
            seq: 1,
            fromState: 'received',
            toState: 'gated',
            actor: 'gate',
            reason: 'all rules passed',
            detail: null,
            occurredAt: new Date('2026-06-01T00:00:01.000Z'),
          },
          {
            seq: 2,
            fromState: 'gated',
            toState: 'drafted',
            actor: 'llm',
            reason: 'drafted',
            detail: null,
            occurredAt: new Date('2026-06-01T00:00:02.000Z'),
          },
        ],
      }),
      updateMany: async ({ where }: { where: { state?: string } }) => {
        if (where.state && row.state !== where.state) return { count: 0 };
        row.state = 'approved';
        row.updates += 1;
        return { count: 1 };
      },
      update: async () => ({}),
    },
    auditLog: {
      count: async () => 3,
      createMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
}

const draft = {
  disputeId: 'disp_SIMrace00000000',
  summary: 'The customer authorised this payment under a valid mandate.',
  disputedAmount: 224_000,
  references: ['evi_one'],
  assignments: [{ field: 'customer_communication', artifacts: ['customer_communication'], references: ['evi_one'] }],
  action: 'draft',
};

describe('two approvals racing on one dispute', () => {
  it('submits exactly once, and refuses the loser before it reaches the adapter', async () => {
    const row: FakeState = { state: 'drafted', updates: 0 };
    const adapter = new SimulatorClient({ now: () => new Date('2026-07-21T00:00:00.000Z') });
    const uploads = vi.spyOn(adapter, 'uploadDocument');
    const submits = vi.spyOn(adapter, 'submit');

    const deps = {
      prisma: fakePrisma(row, draft),
      client: {} as never,
      adapters: { razorpay: adapter },
      now: () => new Date('2026-07-21T00:00:00.000Z'),
    };

    const results = await Promise.allSettled([
      approveAndSubmit(deps, 'dsp_race', 'human:wasih'),
      approveAndSubmit(deps, 'dsp_race', 'human:usman'),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      'approved by another request first',
    );

    // The claim happened once, and the loser touched neither the upload nor
    // the submit: an approval that loses the race has no side effects at all.
    expect(row.updates).toBe(1);
    expect(submits).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveBeenCalledTimes(draft.references.length);
  });

  it('refuses outright when the dispute is no longer drafted', async () => {
    const row: FakeState = { state: 'submitted', updates: 0 };
    const adapter = new SimulatorClient({ now: () => new Date('2026-07-21T00:00:00.000Z') });
    const submits = vi.spyOn(adapter, 'submit');

    await expect(
      approveAndSubmit(
        {
          prisma: fakePrisma(row, draft),
          client: {} as never,
          adapters: { razorpay: adapter },
          now: () => new Date('2026-07-21T00:00:00.000Z'),
        },
        'dsp_race',
        'human:wasih',
      ),
    ).rejects.toThrow(/not drafted/);

    expect(submits).not.toHaveBeenCalled();
    expect(row.updates).toBe(0);
  });
});
