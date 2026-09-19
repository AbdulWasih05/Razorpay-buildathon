import type { Network } from '../../domain/reason-codes.js';
import type { DisputeWebhookEvent } from '../../schema/webhook.js';
import type { NormalizedDispute } from '../types.js';

/**
 * Razorpay's dispute event, in the shape the pipeline works on.
 *
 * One place converts Razorpay's wire format: seconds to `Date`, `payment_id`
 * to `providerPaymentId`, and so on. Before this, every caller that stored a
 * dispute did its own conversion inline, which is fine with one provider and
 * becomes a second dialect the moment there are two.
 *
 * `network` is a parameter because Razorpay's entity does not carry it. The
 * seeded corpus knows it from the scenario that generated the dispute; a real
 * webhook would leave it null, and the rubric lookup then has to fall back to
 * the reason code alone.
 */
export function normaliseRazorpayDispute(
  event: DisputeWebhookEvent,
  network: Network | null = null,
): NormalizedDispute {
  const entity = event.payload.dispute.entity;
  return {
    provider: 'razorpay',
    providerDisputeId: entity.id,
    providerPaymentId: entity.payment_id,
    amountMinor: entity.amount,
    currency: entity.currency,
    reasonCode: entity.reason_code,
    network,
    status: entity.status,
    phase: entity.phase,
    // Razorpay sends seconds; everything inside Praman is a Date.
    respondBy: new Date(entity.respond_by * 1000),
    raisedAt: new Date(entity.created_at * 1000),
  };
}
