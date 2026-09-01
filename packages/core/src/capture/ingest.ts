import { z } from 'zod';

/**
 * The capture contract: what `POST /evidence-pack` accepts at transaction time.
 *
 * This is the product thesis expressed as a schema. The agentic evidence for a
 * dispute -- which agent acted, under which mandate, with what limit and
 * validity window, after what conversation -- lives with the agent platform or
 * TPAP, not the merchant. By the time a dispute arrives months later it is
 * unrecoverable. So it is captured here, at the moment the transaction happens.
 *
 * Two properties this schema is built for:
 *
 * 1. **Idempotency.** Every entity carries a caller-supplied `externalId`. The
 *    endpoint upserts on it, so replaying the same capture is a no-op rather
 *    than a duplicate. Reseeding the corpus is therefore safe.
 *
 * 2. **Determinism.** Every timestamp here is caller-supplied domain time
 *    (`occurredAt`, `capturedAt`, ...), never server wall-clock. Together with
 *    caller-supplied ids this is what lets a reseed produce a logically
 *    identical store, which is what keeps hash-keyed LLM replay fixtures valid.
 *    See DECISIONS.md D-007.
 */

/**
 * Accepts an ISO-8601 string or a Date, normalises to Date.
 *
 * Written as an explicit union rather than `z.coerce.date()` on purpose:
 * `coerce` narrows the *TypeScript* input type to `Date` even though it accepts
 * a string at runtime, so callers building JSON payloads fail to typecheck. The
 * union keeps the static input type honest about what the API really accepts,
 * and requiring an offset rejects ambiguous local-time strings outright.
 */
const domainTime = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((value) => (value instanceof Date ? value : new Date(value)));

/** Seed-derived, caller-supplied, stable across regeneration. */
const externalId = z.string().min(1).max(200);

const amountInSubunits = z.number().int().nonnegative();
const currency = z.string().length(3).default('INR');

export const RAILS = ['ordinary', 'agentic'] as const;
export type Rail = (typeof RAILS)[number];

export const merchantInputSchema = z
  .object({
    externalId,
    name: z.string().min(1),
    category: z.string().min(1),
    occurredAt: domainTime,
  })
  .strict();

export const customerInputSchema = z
  .object({
    externalId,
    name: z.string().min(1),
    email: z.string().email(),
    contact: z.string().min(1),
    occurredAt: domainTime,
  })
  .strict();

export const MANDATE_STATUSES = ['active', 'expired', 'revoked', 'exhausted'] as const;

/**
 * A UPI Reserve Pay mandate. These five facts -- a named agent, recorded
 * consent, a spending cap, a validity window, and a status -- are precisely
 * what a mandate-breach or "I never authorised this" dispute turns on.
 */
export const mandateInputSchema = z
  .object({
    externalId,
    agentId: z.string().min(1),
    agentPlatform: z.string().min(1),
    payerVpa: z.string().min(1),
    consentAt: domainTime,
    validFrom: domainTime,
    validUntil: domainTime,
    maxAmount: amountInSubunits,
    currency,
    status: z.enum(MANDATE_STATUSES),
    occurredAt: domainTime,
  })
  .strict();

export const ORDER_STATUSES = ['placed', 'confirmed', 'cancelled', 'refunded'] as const;

export const orderItemSchema = z
  .object({
    sku: z.string().min(1),
    name: z.string().min(1),
    quantity: z.number().int().positive(),
    amount: amountInSubunits,
  })
  .strict();

export const orderInputSchema = z
  .object({
    externalId,
    amount: amountInSubunits,
    currency,
    status: z.enum(ORDER_STATUSES),
    items: z.array(orderItemSchema).min(1),
    placedAt: domainTime,
    occurredAt: domainTime,
  })
  .strict();

export const paymentInputSchema = z
  .object({
    externalId,
    /**
     * A real Razorpay test-mode `pay_` id once P0.2 lands, a synthetic `pay_`
     * id until then. Either way the prefix is enforced, because this value is
     * what a generated dispute's `payment_id` must match.
     */
    razorpayPaymentId: z.string().startsWith('pay_'),
    amount: amountInSubunits,
    currency,
    method: z.string().min(1),
    status: z.string().min(1),
    vpa: z.string().nullable().optional(),
    capturedAt: domainTime.nullable().optional(),
    occurredAt: domainTime,
  })
  .strict();

export const FULFILLMENT_STATUSES = ['pending', 'shipped', 'delivered', 'returned', 'failed'] as const;

export const fulfillmentInputSchema = z
  .object({
    externalId,
    status: z.enum(FULFILLMENT_STATUSES),
    carrier: z.string().nullable().optional(),
    trackingId: z.string().nullable().optional(),
    shippedAt: domainTime.nullable().optional(),
    deliveredAt: domainTime.nullable().optional(),
    /** Signature, OTP or delivery-confirmation reference, when one exists. */
    proofRef: z.string().nullable().optional(),
    occurredAt: domainTime,
  })
  .strict();

export const REFUND_STATUSES = ['created', 'processed', 'failed'] as const;

/**
 * A refund the merchant issued against this order, and whether the money
 * actually landed.
 *
 * This slot did not exist until P4.0. Its absence was a real recall hole, not a
 * corpus one: UPI reason code 1061 ("credit not processed") asks for proof that
 * a promised refund settled, `order.status = "refunded"` says only that a
 * refund was *generated*, and nothing in the envelope could say the customer
 * received the money. Every 1061 dispute therefore reported the requirement as
 * structurally unmet -- correctly, but the merchant genuinely holds this record.
 * See DECISIONS.md D-030 and D-024.
 *
 * The distinction that does the work is `status` plus `utr`. A refund that was
 * created and never settled is exactly the case Praman must NOT contest: the
 * customer is right, they never got their money. So the settlement reference is
 * modelled separately from the refund itself rather than assumed to follow it.
 */
export const refundInputSchema = z
  .object({
    externalId,
    amount: amountInSubunits,
    currency,
    status: z.enum(REFUND_STATUSES),
    /**
     * The bank's settlement reference (UTR / ARN). Present only once the money
     * has actually moved -- which is what "credit processed" means, and what a
     * created-but-unsettled refund cannot show.
     */
    utr: z.string().min(1).nullable().optional(),
    /** When the refund settled at the customer's bank, not when it was raised. */
    settledAt: domainTime.nullable().optional(),
    initiatedAt: domainTime,
    occurredAt: domainTime,
  })
  .strict()
  .superRefine((refund, ctx) => {
    // A processed refund with no settlement reference would let the collector
    // report proof it does not hold -- the exact shape of confident wrongness
    // on the money path that hard rule #7 exists to prevent.
    if (refund.status === 'processed' && !refund.utr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['utr'],
        message:
          'a processed refund must carry its settlement reference: without a UTR there is no evidence the money moved',
      });
    }
    if (refund.status !== 'processed' && refund.utr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['utr'],
        message: 'only a processed refund has a settlement reference',
      });
    }
  });

/** Protocol-level identity of the agent that transacted. Agentic rail only. */
export const agenticContextSchema = z
  .object({
    agentId: z.string().min(1),
    agentPlatform: z.string().min(1),
    /** e.g. "upi-reserve-pay", "uap". */
    protocol: z.string().min(1),
    protocolVersion: z.string().min(1),
    /**
     * Protocol fields with no first-class column yet, kept rather than dropped.
     * An unmodelled field we retained beats one we needed and never captured --
     * which is the whole argument for capturing at transaction time.
     */
    protocolMetadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const TURN_ROLES = ['customer', 'agent', 'system'] as const;

export const conversationTurnSchema = z
  .object({
    externalId,
    seq: z.number().int().nonnegative(),
    role: z.enum(TURN_ROLES),
    content: z.string().min(1),
    occurredAt: domainTime,
  })
  .strict();

export const conversationTraceSchema = z
  .object({
    externalId,
    startedAt: domainTime,
    occurredAt: domainTime,
    turns: z.array(conversationTurnSchema).min(1),
  })
  .strict();

export const orchestrationLogSchema = z
  .object({
    externalId,
    seq: z.number().int().nonnegative(),
    action: z.string().min(1),
    actor: z.string().min(1),
    detail: z.record(z.string(), z.unknown()).default({}),
    occurredAt: domainTime,
  })
  .strict();

/**
 * The full capture envelope. One POST records an entire transaction and the
 * agentic context around it.
 */
export const evidencePackIngestSchema = z
  .object({
    externalId,
    rail: z.enum(RAILS),
    capturedAt: domainTime,
    occurredAt: domainTime,

    merchant: merchantInputSchema,
    customer: customerInputSchema,
    order: orderInputSchema,
    payment: paymentInputSchema,

    mandate: mandateInputSchema.nullable().optional(),
    fulfillment: fulfillmentInputSchema.nullable().optional(),
    refund: refundInputSchema.nullable().optional(),
    agentic: agenticContextSchema.nullable().optional(),
    conversationTrace: conversationTraceSchema.nullable().optional(),
    orchestrationLogs: z.array(orchestrationLogSchema).default([]),
  })
  .strict()
  .superRefine((pack, ctx) => {
    // An agentic capture without its agentic evidence is the exact failure this
    // product exists to prevent, so it is rejected at the door rather than
    // discovered to be useless at dispute time.
    if (pack.rail === 'agentic') {
      if (!pack.mandate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mandate'],
          message: 'agentic rail requires a mandate: it is the consent record the defense rests on',
        });
      }
      if (!pack.agentic) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentic'],
          message: 'agentic rail requires agent identity and protocol metadata',
        });
      }
      if (!pack.conversationTrace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conversationTrace'],
          message: 'agentic rail requires a conversation trace: unrecoverable after the fact',
        });
      }
      if (pack.orchestrationLogs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['orchestrationLogs'],
          message: 'agentic rail requires an orchestration log: it is the access_activity_log source',
        });
      }
    }

    // The payment must actually be for this order.
    if (pack.payment.amount !== pack.order.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payment', 'amount'],
        message: `payment amount ${pack.payment.amount} does not match order amount ${pack.order.amount}`,
      });
    }
  });

export type MerchantInput = z.infer<typeof merchantInputSchema>;
export type CustomerInput = z.infer<typeof customerInputSchema>;
export type MandateInput = z.infer<typeof mandateInputSchema>;
export type OrderInput = z.infer<typeof orderInputSchema>;
export type PaymentInput = z.infer<typeof paymentInputSchema>;
export type FulfillmentInput = z.infer<typeof fulfillmentInputSchema>;
export type AgenticContext = z.infer<typeof agenticContextSchema>;
export type ConversationTurnInput = z.infer<typeof conversationTurnSchema>;
export type ConversationTraceInput = z.infer<typeof conversationTraceSchema>;
export type OrchestrationLogInput = z.infer<typeof orchestrationLogSchema>;
export type EvidencePackIngest = z.infer<typeof evidencePackIngestSchema>;

/** The input side, before Zod applies its defaults and date coercion. */
export type EvidencePackIngestInput = z.input<typeof evidencePackIngestSchema>;
