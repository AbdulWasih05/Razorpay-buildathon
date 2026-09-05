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
   * Razorpay's published required-evidence guidance, one array entry per
   * bullet, quoted verbatim. Empty array where the page lists a code without
   * evidence guidance.
   *
   * An array, not a comma-joined string (changed 2026-09-05, see the review
   * that caught this): several of Razorpay's own bullets contain an internal
   * comma -- 1085's first item is "Invoice with detailed price breakdown
   * (price, taxes, fee, discount and so on) prove amount charged was
   * correct" -- so a `', '.split()` over a joined string would have silently
   * shredded the guidance it was supposed to preserve verbatim. An array has
   * no delimiter to collide with the text.
   */
  evidenceGuidance: readonly string[];
}

export const UPI_REASON_CODES: readonly ReasonCode[] = [
  {
    code: '1061',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Credit Not Processed',
    evidenceGuidance: [
      'Proof of refund generation',
      'Bank statement showing refund amount which should match the payment amount',
      'Customer communication showing refund confirmation',
      'Refund policies',
    ],
  },
  {
    code: '1062',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Goods/Services Not As Described',
    evidenceGuidance: [
      'Product description/image screenshots',
      'Proof of product/service delivery',
      'Customer communication showcasing dissatisfaction',
      'Return policies',
    ],
  },
  {
    code: '1064',
    network: 'upi',
    category: 'customer_dispute',
    description: 'Goods/Services Not Received',
    evidenceGuidance: [
      'Proof of service/product delivery',
      'Customer interaction showcasing product/service related enquiries',
      'Terms & Conditions showcasing refund & fulfillment policies',
    ],
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
    //
    // Corrected 2026-09-03 by the P5.4 fact-check (FAILURES.md F-019). The
    // published guidance has THREE clauses; this transcription carried two and
    // dropped the delivery one, which hard rule #1 forbids -- "never invent
    // fields, and never omit documented ones". Re-read from
    // https://razorpay.com/docs/payments/disputes/submit-evidence/ on that date.
    //
    // Re-checked 2026-09-05 against the live page again: clause 2 was itself
    // truncated ("...price breakdown" dropped "for the debited amount"). A
    // verbatim-quote claim gets checked twice, not assumed correct because it
    // was checked once (F-019's own lesson, F-019 F-019 not applied to itself).
    evidenceGuidance: [
      'Internal logs to show authorisation was obtained',
      'Invoicing details along with detailed price breakdown for the debited amount',
      'Proof of service/goods delivery clearly mentioning customer name and address details',
    ],
  },
  {
    code: '108',
    network: 'upi',
    category: 'authorisation_error',
    description: 'Remiter Debited but Beneficiary Not Credited',
    // Filled in 2026-09-05. The page has always had guidance for this code;
    // the empty array here was the actual bug an adversarial review caught --
    // this file's own docblock claimed "transcribes the UPI section in full"
    // while four codes' guidance sat unread. 108/1065/121 share one identical
    // four-item list on the live page.
    evidenceGuidance: [
      'Proof of service/product delivery',
      'Customer interaction showcasing product/service related enquiries',
      'Customer Withdrawn letter',
      'Terms & Conditions showcasing refund & fulfillment policies',
    ],
  },
  {
    code: '1065',
    network: 'upi',
    category: 'authorisation_error',
    description: 'Debit on Failed Transaction',
    evidenceGuidance: [
      'Proof of service/product delivery',
      'Customer interaction showcasing product/service related enquiries',
      'Customer Withdrawn letter',
      'Terms & Conditions showcasing refund & fulfillment policies',
    ],
  },
  {
    code: '121',
    network: 'upi',
    category: 'authorisation_error',
    description: 'TCC Raised but Beneficiary is Not Credited',
    evidenceGuidance: [
      'Proof of service/product delivery',
      'Customer interaction showcasing product/service related enquiries',
      'Customer Withdrawn letter',
      'Terms & Conditions showcasing refund & fulfillment policies',
    ],
  },
  {
    code: '1063',
    network: 'upi',
    category: 'processing_error',
    description: 'Paid by Other Means',
    evidenceGuidance: [
      'Proof showing payment was not received using any other method',
      'Refund proof if amount was refunded for duplicate charge',
      'Proof to show the claimed transaction was for a different product/service',
    ],
  },
  {
    code: '1084',
    network: 'upi',
    category: 'processing_error',
    description: 'Duplicate Processing',
    evidenceGuidance: [
      'System logs to prove only one transaction was processed for single authorisation',
      'Invoicing to prove each transaction was for separate service/product',
    ],
  },
  {
    code: '1085',
    network: 'upi',
    category: 'processing_error',
    description: 'Charge Amount Exceeds Authorisation Amount',
    evidenceGuidance: [
      'Invoice with detailed price breakdown (price, taxes, fee, discount and so on) prove amount charged was correct',
      'Screenshot of product/service along with the price details',
      'Authorisation proof showing final amount was authorised by cardholder',
      'System logs to show correct amount was charged',
    ],
  },
  {
    code: '1081',
    network: 'upi',
    category: 'processing_error',
    description: 'Not Settled Within Timeline',
    evidenceGuidance: [
      'Internal logs to prove that charge was submitted within allowed time frame',
      'Time stamp of transaction and processing of the payment showing debit amount',
      'In case of re-auth, please provide proof of same',
      'Customer authorisation proof',
      'Masked card details and invoice of the transaction',
    ],
  },
] as const;

/** RuPay codes used by ordinary-rail card scenarios. */
export const RUPAY_REASON_CODES: readonly ReasonCode[] = [
  {
    code: '1104',
    network: 'rupay',
    category: 'fraud',
    description: 'Cardholder Does Not Recognise the Transaction',
    evidenceGuidance: [],
  },
  {
    code: '1064',
    network: 'rupay',
    category: 'customer_dispute',
    description: 'Goods/Services Not Received',
    evidenceGuidance: [],
  },
  {
    code: '1061',
    network: 'rupay',
    category: 'customer_dispute',
    description: 'Credit Not Processed',
    evidenceGuidance: [],
  },
  {
    code: '1084',
    network: 'rupay',
    category: 'processing_error',
    description: 'Duplicate Processing',
    evidenceGuidance: [],
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
