import { z } from 'zod';
import { amountInSubunits, orderId, paymentId, unixTimestamp } from './ids.js';

// Source: the payment entity as embedded in the dispute webhook payload,
//   https://razorpay.com/docs/webhooks/disputes/

/**
 * `notes` is documented as a key-value object, but Razorpay serialises an empty
 * notes map as `[]` (a JSON array). The published webhook example shows exactly
 * that. Both shapes are accepted rather than "fixed" in the fixture.
 */
const notes = z.union([z.record(z.string(), z.string()), z.array(z.unknown())]);

/**
 * Unlike the dispute entity, the payment entity is NOT `.strict()`.
 *
 * The dispute entity is our contract -- we produce and consume it, so drift must
 * fail loudly. The payment entity is context that rides along with the webhook,
 * and its shape legitimately varies by payment method (a UPI payment populates
 * `vpa` and leaves `card_id` null; card payments do the reverse; new methods add
 * new keys). Hard-failing dispute ingestion because Razorpay added a field to an
 * unrelated payment method would be brittleness, not fidelity. Documented fields
 * are still typed and still validated. See DECISIONS.md D-004.
 */
export const paymentEntitySchema = z
  .object({
    id: paymentId,
    entity: z.literal('payment'),
    amount: amountInSubunits,
    currency: z.string().length(3),
    base_amount: amountInSubunits.optional(),
    status: z.string().min(1),
    order_id: orderId.nullable(),
    invoice_id: z.string().nullable(),
    international: z.boolean(),
    method: z.string().min(1),
    amount_refunded: amountInSubunits,
    amount_transferred: amountInSubunits.optional(),
    refund_status: z.string().nullable(),
    captured: z.boolean(),
    description: z.string().nullable(),
    card_id: z.string().nullable(),
    bank: z.string().nullable(),
    wallet: z.string().nullable(),
    vpa: z.string().nullable(),
    email: z.string(),
    contact: z.string().nullable(),
    notes,
    fee: z.number().int().nullable(),
    tax: z.number().int().nullable(),
    error_code: z.string().nullable(),
    error_description: z.string().nullable(),
    error_source: z.string().nullable(),
    error_step: z.string().nullable(),
    error_reason: z.string().nullable(),
    acquirer_data: z.record(z.string(), z.unknown()).optional(),
    created_at: unixTimestamp,
  })
  .passthrough();

export type PaymentEntity = z.infer<typeof paymentEntitySchema>;
