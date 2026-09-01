import { describe, expect, it } from 'vitest';

import { ORDER_RELATIONS, cleanRow } from './review.js';

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
