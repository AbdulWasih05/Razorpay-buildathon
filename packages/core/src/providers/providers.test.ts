import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVIDENCE_ARTIFACTS } from '../domain/rubric.js';
import { formatMoney, formatRupees } from '../domain/money.js';
import { CONTEST_EVIDENCE_DOCUMENT_FIELDS } from '../schema/contest.js';
import { disputeWebhookEventSchema } from '../schema/webhook.js';
import { RAZORPAY_FIELDS, RAZORPAY_FIELD_MAP } from './razorpay/fields.js';
import { normaliseRazorpayDispute } from './razorpay/normalise.js';

/**
 * The provider seam.
 *
 * What these pin: the domain no longer names one provider's fields, the
 * Razorpay table is complete and uses only documented field names, the
 * normaliser converts the wire format in exactly one place, and money in
 * rupees still formats byte-for-byte as it did -- that last one is why the
 * replay fixtures still hit.
 */

describe("Razorpay's field map", () => {
  it('places every artifact the domain knows about', () => {
    expect(EVIDENCE_ARTIFACTS.length).toBeGreaterThan(10);
    for (const artifact of EVIDENCE_ARTIFACTS) {
      expect(RAZORPAY_FIELD_MAP[artifact]?.field, artifact).toBeTruthy();
    }
  });

  it('uses only fields the Disputes API documents', () => {
    const documented = new Set<string>([...CONTEST_EVIDENCE_DOCUMENT_FIELDS, 'others']);
    for (const artifact of EVIDENCE_ARTIFACTS) {
      expect(documented.has(RAZORPAY_FIELD_MAP[artifact].field), artifact).toBe(true);
    }
  });

  it('labels every catch-all entry, because Razorpay requires a type on `others`', () => {
    for (const artifact of EVIDENCE_ARTIFACTS) {
      const placement = RAZORPAY_FIELD_MAP[artifact];
      if (placement.field !== 'others') continue;
      expect(placement.othersType, artifact).toBeTruthy();
    }
  });

  it('is readable as a neutral map, which is what the mapper takes', () => {
    expect(RAZORPAY_FIELDS.delivery_proof.field).toBe('shipping_proof');
  });
});

describe('the Razorpay normaliser', () => {
  // The event Razorpay prints in its own docs, committed with its provenance.
  // Normalising a hand-written payload would only prove the normaliser agrees
  // with whatever this test made up.
  const event = disputeWebhookEventSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../fixtures/webhook-payment-dispute-created.json', import.meta.url)),
        'utf8',
      ),
    ),
  );
  const entity = event.payload.dispute.entity;

  it('converts the wire format once, seconds included', () => {
    const dispute = normaliseRazorpayDispute(event, 'upi');
    expect(dispute).toMatchObject({
      provider: 'razorpay',
      providerDisputeId: entity.id,
      providerPaymentId: entity.payment_id,
      amountMinor: entity.amount,
      currency: entity.currency,
      reasonCode: entity.reason_code,
      network: 'upi',
      status: entity.status,
      phase: entity.phase,
    });
    // Seconds on the wire, Date inside. Getting this wrong is a deadline that
    // reads as 1970 or as fifty thousand years away, and both have shipped.
    expect(dispute.respondBy.toISOString()).toBe(new Date(entity.respond_by * 1000).toISOString());
    expect(dispute.raisedAt.toISOString()).toBe(new Date(entity.created_at * 1000).toISOString());
  });

  it('leaves the network null when nobody said what it is', () => {
    expect(normaliseRazorpayDispute(event).network).toBeNull();
  });
});

describe('money in more than one currency', () => {
  it('formats rupees exactly as before, because prompts are hashed', () => {
    for (const amount of [0, 1, 99, 100, 165400, 245635, 100000000, -224000]) {
      expect(formatMoney(amount, 'INR')).toBe(formatRupees(amount));
    }
  });

  it('groups other currencies in threes and names the code', () => {
    expect(formatMoney(123456, 'USD')).toBe('USD 1,234.56');
    expect(formatMoney(100000000, 'USD')).toBe('USD 1,000,000');
    expect(formatMoney(-500, 'EUR')).toBe('-EUR 5');
  });

  it('treats a zero-decimal currency as already whole', () => {
    expect(formatMoney(1500, 'JPY')).toBe('JPY 1,500');
  });
});
