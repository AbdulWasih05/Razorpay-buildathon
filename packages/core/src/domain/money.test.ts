import { describe, expect, it } from 'vitest';

import { formatRupees, withReadableMoney } from './money.js';

/**
 * The regression these tests exist for is F-025: the drafter was handed
 * `165400` and wrote "INR 165,400" into a contest for a ₹1,654 dispute. The
 * assertions below are therefore about the exact string, not about "roughly the
 * right number" -- this output goes into a prompt whose hash is the replay cache
 * key, so a formatting change is a cache invalidation and has to be deliberate.
 */
describe('formatRupees', () => {
  it('renders whole rupees without a paise suffix', () => {
    expect(formatRupees(165400)).toBe('₹1,654');
  });

  it('renders paise when they are not zero', () => {
    expect(formatRupees(245635)).toBe('₹2,456.35');
    expect(formatRupees(5)).toBe('₹0.05');
  });

  it('groups in the Indian convention: last three, then pairs', () => {
    expect(formatRupees(100)).toBe('₹1');
    expect(formatRupees(99900)).toBe('₹999');
    expect(formatRupees(100000)).toBe('₹1,000');
    expect(formatRupees(1234500)).toBe('₹12,345');
    expect(formatRupees(123456700)).toBe('₹12,34,567');
    expect(formatRupees(0)).toBe('₹0');
  });

  it('keeps a negative amount signed', () => {
    expect(formatRupees(-165400)).toBe('-₹1,654');
  });
});

describe('withReadableMoney', () => {
  it('rewrites the three money keys the collector emits', () => {
    expect(withReadableMoney({ orderTotal: 165400, charged: 165400, currency: 'INR' })).toEqual({
      orderTotal: '₹1,654',
      charged: '₹1,654',
      currency: 'INR',
    });
  });

  it('reaches money nested inside arrays of line items', () => {
    expect(
      withReadableMoney({ lineItems: [{ name: 'Family dinner order', quantity: 2, amount: 165400 }] }),
    ).toEqual({
      lineItems: [{ name: 'Family dinner order', quantity: 2, amount: '₹1,654' }],
    });
  });

  it('leaves everything that is not a money field alone', () => {
    const detail = { turnCount: 5, roles: ['customer', 'agent'], proofRef: 'otp_9931', vpa: null };
    expect(withReadableMoney(detail)).toEqual(detail);
  });

  it('does not mutate the caller', () => {
    const detail = { amount: 165400 };
    withReadableMoney(detail);
    expect(detail.amount).toBe(165400);
  });

  it('leaves a money key alone when it is not a number', () => {
    // `quantity` is a count and `amount` on a non-numeric shape is not ours to
    // reinterpret. The guard keeps the walk total rather than clever.
    expect(withReadableMoney({ amount: 'already ₹1,654' })).toEqual({ amount: 'already ₹1,654' });
  });
});
