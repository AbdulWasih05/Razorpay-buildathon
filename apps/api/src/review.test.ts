import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@prisma/client';
import type { ContestDraft } from '@praman/core';
import type { DisputeAdapter } from '@praman/adapter';

import { ORDER_RELATIONS, approveAndSubmit, cleanRow } from './review.js';

/**
 * Regression tests for FAILURES.md F-014.
 *
 * `cleanRow` flattens a Prisma row into the shape the `.strict()` capture
 * envelope expects, which means every key it lets through must be one the
 * schema declares. It got that wrong in a way 203 passing tests could not see,
 * because nothing else in the suite round-trips through Prisma.
 *
 * The tests below are deliberately about the null case. A populated relation
 * was always dropped correctly; it was the ABSENT one that broke ingest, so a
 * test that only exercises the happy path reproduces the original blindness.
 */

describe('cleanRow drops relations by name, not by guessing from the value', () => {
  it('drops a relation that is present', () => {
    const row = { externalId: 'ord_1', amount: 100, refund: { externalId: 'rfd_1' } };
    expect(cleanRow(row, ORDER_RELATIONS)).toEqual({ externalId: 'ord_1', amount: 100 });
  });

  it('drops a relation that is NULL -- the case that broke ingest', () => {
    // F-014 exactly. `refund: null` is indistinguishable from a null column by
    // value, so the old value-shape check passed it straight into a .strict()
    // schema and every order without a refund failed with "unrecognized keys".
    const row = { externalId: 'ord_1', amount: 100, refund: null };
    const out = cleanRow(row, ORDER_RELATIONS);
    expect(Object.keys(out)).not.toContain('refund');
    expect(out).toEqual({ externalId: 'ord_1', amount: 100 });
  });

  it('keeps a null COLUMN, which is a captured fact and not a missing relation', () => {
    // The reason nulls cannot simply be dropped wholesale. "no VPA was
    // recorded" and "no UTR, because this refund never settled" are both facts
    // the collector reads; deleting them would silently change evidence.
    const row = { externalId: 'pmt_1', vpa: null, utr: null, capturedAt: null };
    expect(cleanRow(row)).toEqual({ externalId: 'pmt_1', vpa: null, utr: null, capturedAt: null });
  });

  it('names every relation Prisma can attach to an order', () => {
    // The guard against the list going stale the next time a relation is added
    // -- which is how F-014 happened in the first place.
    expect([...ORDER_RELATIONS]).toEqual(
      expect.arrayContaining(['customer', 'payment', 'fulfillment', 'refund']),
    );
  });
});

describe('cleanRow keeps what the envelope needs', () => {
  it('drops foreign keys but keeps the identifiers the domain uses', () => {
    const row = {
      externalId: 'ord_1',
      merchantId: 'cuid1',
      customerId: 'cuid2',
      agentId: 'agent_x',
      razorpayPaymentId: 'pay_x',
    };
    expect(cleanRow(row)).toEqual({
      externalId: 'ord_1',
      agentId: 'agent_x',
      razorpayPaymentId: 'pay_x',
    });
  });

  /**
   * F-030. `trackingId` is a carrier tracking number -- evidence a 1064 "goods
   * not received" contest leans on -- and the drop-anything-ending-in-`Id` rule
   * ate it on every read-back. It was captured and stored correctly and then
   * lost on the one path that leads to a drafted contest, so the eval (which
   * builds packs from the generator) scored a prompt the product never sent.
   *
   * The assertion is on the field, not on the allowlist, so it still holds if
   * the mechanism is ever rewritten.
   */
  it('keeps a carrier tracking id, which is evidence and not a row pointer', () => {
    const row = { externalId: 'ful_1', trackingId: 'trk_abc', orderId: 'cuid3' };
    expect(cleanRow(row)).toEqual({ externalId: 'ful_1', trackingId: 'trk_abc' });
  });

  it('renders dates as ISO strings, since the envelope is JSON', () => {
    const out = cleanRow({ occurredAt: new Date('2026-06-10T09:00:00.000Z') });
    expect(out.occurredAt).toBe('2026-06-10T09:00:00.000Z');
  });

  it('drops *Json columns, which callers re-attach under the domain name', () => {
    expect(cleanRow({ externalId: 'ord_1', itemsJson: [{ sku: 'a' }] })).toEqual({
      externalId: 'ord_1',
    });
  });
});

/**
 * Route-level adversarial tests for the money path, owed since F-013 and
 * never paid ("Route-level adversarial tests are now owed for anything on
 * the money path" -- FAILURES.md F-013). These exercise `approveAndSubmit`
 * itself, not a unit inside it, because F-013's whole lesson was that a
 * caller can satisfy every unit-level guard while the *path* is still broken.
 *
 * A second review found the descendant of the same bug: `isHumanActor`
 * (the audit-trail-layer check) only reads the `human:` prefix, so
 * `human:system` passes it. `ApprovalToken.approve` is the only check that
 * reads the name -- and until this fix, it ran AFTER the audit-trail write
 * and the document-upload loop, so a spoofed actor still caused a real
 * adapter call (`uploadDocument`) before anything rejected it. These tests
 * assert not just that the call throws, but that ZERO adapter calls happened
 * -- the thing a unit test of `ApprovalToken` alone cannot see.
 */
describe('approveAndSubmit refuses a spoofed actor before any side effect', () => {
  function fakeDraft(): ContestDraft {
    return {
      disputeId: 'disp_test1',
      amount: 1000,
      disputedAmount: 1000,
      summary: 'test summary',
      action: 'draft',
      assignments: [{ field: 'customer_communication', documentIds: [], referenceKeys: ['ref_1'] }],
      references: ['ref_1'],
    } as unknown as ContestDraft;
  }

  function fakePrisma(): PrismaClient {
    return {
      dispute: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'row_1',
          externalId: 'dsp_test1',
          razorpayDisputeId: 'disp_test1',
          state: 'drafted',
          provider: 'razorpay',
          contestDraftJson: fakeDraft(),
          auditLogs: [],
        }),
        update: vi.fn(),
        // The conditional claim the approve path now makes: `updateMany` with
        // `state: 'drafted'` in its WHERE, so two racing approvals cannot both
        // proceed. See approve-race.test.ts.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        count: vi.fn().mockResolvedValue(0),
        createMany: vi.fn(),
      },
    } as unknown as PrismaClient;
  }

  function fakeAdapter(): DisputeAdapter & { uploadDocument: ReturnType<typeof vi.fn> } {
    return {
      name: 'fake',
      simulated: true,
      uploadDocument: vi.fn().mockResolvedValue({ reference: 'ref_1', documentId: 'doc_1' }),
      submit: vi.fn().mockResolvedValue({
        simulated: true,
        request: { action: 'submit' },
      }),
    } as unknown as DisputeAdapter & { uploadDocument: ReturnType<typeof vi.fn> };
  }

  it.each(['human:system', 'human:bot', 'human:llm', 'human:adapter', 'human:admin'])(
    'rejects %s and calls the adapter zero times',
    async (spoofedActor) => {
      const prisma = fakePrisma();
      const adapter = fakeAdapter();

      await expect(
        approveAndSubmit({ prisma, adapters: { razorpay: adapter }, now: () => new Date() } as never, 'dsp_test1', spoofedActor),
      ).rejects.toThrow(/system actor|not a person/);

      // The proof F-013's own regression tests could not offer: no upload, no
      // submit, and no write to the audit trail either -- the manufactured
      // identity produces exactly nothing, not "nothing except what already ran".
      expect(adapter.uploadDocument).not.toHaveBeenCalled();
      expect(adapter.submit).not.toHaveBeenCalled();
      expect((prisma.auditLog.createMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((prisma.dispute.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      // Not even the claim: a spoofed identity never reaches a write at all.
      expect((prisma.dispute.updateMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    },
  );

  it('still accepts a real reviewer name, including one with a hyphen', async () => {
    // The check the reserved-name defence must not become is paranoid: the
    // regression this pins is that F-013's fix tightened WHO can approve
    // without narrowing WHAT a real name can look like.
    const prisma = fakePrisma();
    const adapter = fakeAdapter();

    const result = await approveAndSubmit(
      { prisma, adapters: { razorpay: adapter }, now: () => new Date() } as never,
      'dsp_test1',
      'human:systems-team-anita',
    );

    expect(result.state).toBe('submitted');
    expect(adapter.uploadDocument).toHaveBeenCalledTimes(1);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });
});
