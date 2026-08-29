/**
 * Dispute reason codes, transcribed from Razorpay's published
 * reason-code -> required-evidence guidance.
 *
 * Source: https://razorpay.com/docs/payments/disputes/submit-evidence/
 * Retrieved 2026-08-30. The page groups codes by network (Visa, Mastercard,
 * RuPay, Amex) and carries an explicit **UPI** section -- which is the
 * verification the whole thesis rests on. See DECISIONS.md D-008.
 *
 * `evidenceGuidance` is quoted from that page, not paraphrased. It is the
 * ground truth for the P2.1 rubric table, so paraphrasing it would quietly
 * replace Razorpay's requirement with our opinion of it.
 *
 * Scope note: this file transcribes the UPI section in full, because UPI is the
 * rail this product is about. The card networks are represented by the codes the
 * ordinary-rail scenarios actually use, not exhaustively.
 */

export const NETWORKS = ['upi', 'rupay', 'visa', 'mastercard', 'amex'] as const;
export type Network = (typeof NETWORKS)[number];

/** Razorpay's own grouping of UPI codes on the submit-evidence page. */
export const DISPUTE_CATEGORIES = [
  'customer_dispute',
  'fraud',
  'authorisation_error',
  'processing_error',
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export interface ReasonCode {
  code: string;
  network: Network;
  category: DisputeCategory;
  /** Razorpay's own description of the code. */
  description: string;
  /**
   * Razorpay's published required-evidence guidance, quoted verbatim.
   * Empty string where the page lists a code without evidence guidance.
   */
  evidenceGuidance: string;
}

export const UPI_REASON_CODES: readonly ReasonCode[] = [
  {
    code: '1061',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Credit Not Processed',
    evidenceGuidance:
      'Proof of refund generation, Bank statement showing refund amount which should match payment amount',
  },
  {
    code: '1062',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Goods/Services Not As Described',
    evidenceGuidance: 'Product description/image screenshots, Proof of product/service delivery',
  },
  {
    code: '1064',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Goods/Services Not Received',
    evidenceGuidance:
      'Proof of service/product delivery, Customer interaction showcasing product/service related enquiries',
  },
  {
    code: '128',
    network: 'upi',
    category: 'fraud',
    description: 'Fraudulent Transaction',
    // The load-bearing line for this entire product. For an agent-initiated
    // payment, the mandate record and the orchestration log ARE the "internal
    // logs to show authorisation was obtained". The agentic module is not a
    // stretch of the schema; it is the schema's own answer.
    evidenceGuidance:
      'Internal logs to show authorisation was obtained, Invoicing details along with detailed price breakdown',
  },
  {
    code: '108',
    network: 'upi',
    category: 'authorisation_error',
    description: 'Remiter Debited but Beneficiary Not Credited',
    evidenceGuidance: '',
  },
  {
    code: '1065',
    network: 'upi',
    category: 'authorisation_error',
    description: 'Debit on Failed Transaction',
    evidenceGuidance: '',
  },
  {
    code: '121',
    network: 'upi',
    category: 'authorisation_error',
    description: 'TCC Raised but Beneficiary is Not Credited',
    evidenceGuidance: '',
  },
  {
    code: '1063',
    network: 'upi',
    category: 'processing_error',
    description: 'Paid by Other Means',
    evidenceGuidance: '',
  },
  {
    code: '1084',
    network: 'upi',
    category: 'processing_error',
    description: 'Duplicate Processing',
    evidenceGuidance: '',
  },
  {
    code: '1085',
    network: 'upi',
    category: 'processing_error',
    description: 'Charge Amount Exceeds Authorisation Amount',
    evidenceGuidance: '',
  },
  {
    code: '1081',
    network: 'upi',
    category: 'processing_error',
    description: 'Not Settled Within Timeline',
    evidenceGuidance: '',
  },
] as const;

/** RuPay codes used by ordinary-rail card scenarios. */
export const RUPAY_REASON_CODES: readonly ReasonCode[] = [
  {
    code: '1104',
    network: 'rupay',
    category: 'fraud',
    description: 'Cardholder Does Not Recognise the Transaction',
    evidenceGuidance: '',
  },
  {
    code: '1064',
    network: 'rupay',
    category: 'customer_dispute',
    description: 'Goods/Services Not Received',
    evidenceGuidance: '',
  },
  {
    code: '1061',
    network: 'rupay',
    category: 'customer_dispute',
    description: 'Credit Not Processed',
    evidenceGuidance: '',
  },
  {
    code: '1084',
    network: 'rupay',
    category: 'processing_error',
    description: 'Duplicate Processing',
    evidenceGuidance: '',
  },
] as const;

export const ALL_REASON_CODES: readonly ReasonCode[] = [
  ...UPI_REASON_CODES,
  ...RUPAY_REASON_CODES,
];

/** Look up a code within a network. Networks reuse numbers, so both are needed. */
export function findReasonCode(network: Network, code: string): ReasonCode | undefined {
  return ALL_REASON_CODES.find((entry) => entry.network === network && entry.code === code);
}
