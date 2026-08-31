import { z } from 'zod';
import { amountInSubunits, disputeId, documentId, paymentId, unixTimestamp } from './ids.js';

// Source of truth for every field below:
//   https://razorpay.com/docs/api/disputes/fetch-all/
//   https://razorpay.com/docs/api/disputes/contest/
// Fixtures copied verbatim from those pages live in ../fixtures/.
// Never add a field that is not on those pages (CLAUDE.md hard rule #1).

/** Documented dispute lifecycle states. */
export const DISPUTE_STATUSES = ['open', 'under_review', 'won', 'lost', 'closed'] as const;

/**
 * Documented dispute phases. Note this is FIVE values: the docs list `fraud`
 * and `retrieval` in addition to the three escalation phases. See DECISIONS.md D-002.
 */
export const DISPUTE_PHASES = ['fraud', 'retrieval', 'chargeback', 'pre_arbitration', 'arbitration'] as const;

/**
 * The documented maximum length of the evidence `summary` string. This is the
 * "explanation <=1000 chars" limit: it applies to `summary`, NOT to
 * `explanation_letter` (which is a list of document ids). See DECISIONS.md D-003.
 *
 * It is deliberately NOT enforced on the read schema below -- we must be able to
 * parse whatever Razorpay returns. It is enforced on the write path, where we
 * are the ones producing the value. (Write path lands in P2.0.)
 */
export const EVIDENCE_SUMMARY_MAX_CHARS = 1000;

/** Every typed evidence field except `summary` and `others` is a list of document ids. */
const documentIdList = z.array(documentId).nullable();

/** `others` carries custom evidence: a label plus the document ids backing it. */
export const evidenceOtherSchema = z
  .object({
    type: z.string().min(1),
    document_ids: z.array(documentId),
  })
  .strict();

export const disputeEvidenceSchema = z
  .object({
    amount: amountInSubunits,
    summary: z.string().nullable(),
    shipping_proof: documentIdList,
    billing_proof: documentIdList,
    cancellation_proof: documentIdList,
    customer_communication: documentIdList,
    proof_of_service: documentIdList,
    explanation_letter: documentIdList,
    refund_confirmation: documentIdList,
    access_activity_log: documentIdList,
    refund_cancellation_policy: documentIdList,
    term_and_conditions: documentIdList,
    others: z.array(evidenceOtherSchema).nullable(),
    submitted_at: unixTimestamp.nullable(),
  })
  .strict();

/**
 * `.strict()` is deliberate. An unexpected key in a dispute payload means our
 * understanding of Razorpay's contract has drifted, and we would rather fail a
 * test loudly than silently drop a field that mattered on the money path.
 */
export const disputeEntitySchema = z
  .object({
    id: disputeId,
    entity: z.literal('dispute'),
    payment_id: paymentId,
    amount: amountInSubunits,
    currency: z.string().length(3),
    amount_deducted: amountInSubunits,
    reason_code: z.string().min(1),
    // Documented in the response table but absent from every published example,
    // so it is optional as well as nullable.
    reason_description: z.string().nullable().optional(),
    respond_by: unixTimestamp,
    status: z.enum(DISPUTE_STATUSES),
    phase: z.enum(DISPUTE_PHASES),
    created_at: unixTimestamp,
    evidence: disputeEvidenceSchema,
  })
  .strict();

/** The `GET /disputes` collection envelope. */
export const disputeCollectionSchema = z
  .object({
    entity: z.literal('collection'),
    count: z.number().int().nonnegative(),
    items: z.array(disputeEntitySchema),
  })
  .strict();

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputePhase = (typeof DISPUTE_PHASES)[number];
export type EvidenceOther = z.infer<typeof evidenceOtherSchema>;
export type DisputeEvidence = z.infer<typeof disputeEvidenceSchema>;
export type DisputeEntity = z.infer<typeof disputeEntitySchema>;
export type DisputeCollection = z.infer<typeof disputeCollectionSchema>;

// The contest REQUEST body -- the write side of this contract -- lives in
// ./contest.ts (TASKS.md P2.0). It is deliberately a separate schema: read
// parses whatever Razorpay returns, write enforces what we are allowed to send.
