import { z } from 'zod';
import { accountId, unixTimestamp } from './ids.js';
import { disputeEntitySchema } from './dispute.js';
import { paymentEntitySchema } from './payment.js';

// Source: https://razorpay.com/docs/webhooks/disputes/
// Note the `payment.` prefix -- the event is `payment.dispute.created`,
// not `dispute.created`. Getting this wrong is the kind of detail a Razorpay
// engineer spots on sight.

export const DISPUTE_WEBHOOK_EVENTS = [
  'payment.dispute.created',
  'payment.dispute.won',
  'payment.dispute.lost',
  'payment.dispute.closed',
  'payment.dispute.under_review',
  'payment.dispute.action_required',
] as const;

export const disputeWebhookEventSchema = z
  .object({
    entity: z.literal('event'),
    account_id: accountId,
    event: z.enum(DISPUTE_WEBHOOK_EVENTS),
    contains: z.array(z.string().min(1)).min(1),
    payload: z
      .object({
        payment: z.object({ entity: paymentEntitySchema }).strict(),
        dispute: z.object({ entity: disputeEntitySchema }).strict(),
      })
      .strict(),
    created_at: unixTimestamp,
  })
  .strict();

export type DisputeWebhookEventName = (typeof DISPUTE_WEBHOOK_EVENTS)[number];
export type DisputeWebhookEvent = z.infer<typeof disputeWebhookEventSchema>;

/** Narrow an unknown body to a dispute webhook event, throwing on any mismatch. */
export function parseDisputeWebhookEvent(input: unknown): DisputeWebhookEvent {
  return disputeWebhookEventSchema.parse(input);
}
