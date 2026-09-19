import type { ContestEvidenceField } from '../../schema/contest.js';
import type { EvidenceArtifact } from '../../domain/rubric.js';
import type { ProviderFieldMap } from '../types.js';

/**
 * Razorpay's own table, typed against the documented field union rather than
 * against `string`. The neutral `ProviderFieldMap` cannot know one provider's
 * field names, so the narrowing happens here, where they are known: a typo in
 * a field name is a compile error, not a payload Razorpay rejects.
 */
export type RazorpayFieldMap = Readonly<
  Record<EvidenceArtifact, { field: ContestEvidenceField; othersType?: string }>
>;

/**
 * Where each artifact lands in Razorpay's typed evidence fields.
 *
 * This table used to live on the rubric, as a `contestField` on every artifact
 * definition. That made the domain's own vocabulary Razorpay's: an artifact is
 * a thing a merchant holds, and which field it goes in is a fact about a
 * provider's API, not about the evidence.
 *
 * The field names are Razorpay's, verbatim, from
 * https://razorpay.com/docs/api/disputes/. `others` entries carry the `type`
 * label Razorpay requires, set here so the mapper never invents one.
 *
 * Total over every artifact: a missing entry is a type error rather than a
 * silently unmapped piece of evidence.
 */
export const RAZORPAY_FIELD_MAP = {
  order_record: { field: 'billing_proof' },
  payment_record: { field: 'billing_proof' },
  shipment_record: { field: 'shipping_proof' },
  delivery_proof: { field: 'shipping_proof' },
  product_description: { field: 'others', othersType: 'product_description' },
  customer_communication: { field: 'customer_communication' },
  authorisation_evidence: { field: 'access_activity_log' },
  invoice_breakdown: { field: 'others', othersType: 'invoice_with_price_breakdown' },
  duplicate_payment_analysis: { field: 'others', othersType: 'duplicate_payment_analysis' },
  refund_record: { field: 'refund_confirmation' },
  refund_settlement_proof: { field: 'refund_confirmation' },
  item_selection_confirmation: { field: 'customer_communication' },
  merchant_refund_policy: { field: 'refund_cancellation_policy' },
  merchant_terms_conditions: { field: 'term_and_conditions' },
  customer_withdrawal_letter: { field: 'others', othersType: 'customer_withdrawal_letter' },
  alternate_payment_negative_proof: {
    field: 'others',
    othersType: 'alternate_payment_negative_proof',
  },
  reauth_proof: { field: 'others', othersType: 'reauth_proof' },
} satisfies RazorpayFieldMap;

/** The same table, seen as any provider's: what the mapper is handed. */
export const RAZORPAY_FIELDS: ProviderFieldMap = RAZORPAY_FIELD_MAP;
