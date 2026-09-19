import { ALL_REASON_CODES, type DisputeCategory, type Network } from './reason-codes.js';
import { SCENARIOS, type ScenarioClass } from './scenarios.js';

/**
 * The reason-code -> required-evidence rubric (TASKS.md P2.1).
 *
 * Source for every `published` requirement:
 *   https://razorpay.com/docs/payments/disputes/submit-evidence/  (retrieved 2026-08-30)
 * The verbatim guidance strings live on the reason codes themselves in
 * ./reason-codes.ts; this file maps that prose onto (a) artifacts our capture
 * store can actually produce and (b) the typed Razorpay contest fields they
 * belong in.
 *
 * Three properties this table is built for, all of them about trust:
 *
 * 1. **Every requirement carries its provenance.** `published` means it answers
 *    to a phrase Razorpay printed, and the phrase is quoted on the requirement.
 *    `derived` means Razorpay published no evidence guidance for that code and
 *    this is *our* considered view, labelled as ours. Tests assert this in
 *    BOTH directions: no `published` requirement exists for a code marked
 *    `hasPublishedGuidance: false`, AND no code is marked `false` while
 *    reason-codes.ts's transcription says otherwise. Only the forward
 *    direction existed until 2026-09-05 -- an adversarial review caught seven
 *    UPI codes marked `false` that the live page actually publishes guidance
 *    for, because the only thing being checked was self-consistency with
 *    reason-codes.ts, and reason-codes.ts was the file that had the gap.
 *
 * 2. **It knows what we cannot produce.** An artifact carries `sourceable`.
 *    `refund_settlement_proof` is required by the docs for UPI 1061 and our
 *    capture layer structurally cannot produce it -- we hold no bank statement.
 *    Saying so in the data is better than a rubric that silently pretends every
 *    requirement is satisfiable.
 *
 * 3. **It is data, not logic.** Nothing here decides anything. The collector
 *    (P2.2) reports presence, the gate (P3.1) decides. No LLM touches any of it.
 */

/** An artifact kind the capture store can be asked for. */
export const EVIDENCE_ARTIFACTS = [
  'order_record',
  'payment_record',
  'shipment_record',
  'delivery_proof',
  'product_description',
  'customer_communication',
  'authorisation_evidence',
  'invoice_breakdown',
  'duplicate_payment_analysis',
  'refund_record',
  'refund_settlement_proof',
  'item_selection_confirmation',
  'merchant_refund_policy',
  'merchant_terms_conditions',
  'customer_withdrawal_letter',
  'alternate_payment_negative_proof',
  'reauth_proof',
] as const;

export type EvidenceArtifact = (typeof EVIDENCE_ARTIFACTS)[number];

export interface ArtifactDefinition {
  artifact: EvidenceArtifact;
  /** What this artifact is, in one line. */
  description: string;
  /** Whether Praman's capture layer can produce this at all. */
  sourceable: boolean;
  /** Required when `sourceable` is false. Stated, not hidden. */
  notSourceableReason?: string;
}

export const ARTIFACTS: Record<EvidenceArtifact, ArtifactDefinition> = {
  order_record: {
    artifact: 'order_record',
    description: 'The order: items, quantities, amounts, status and placement time.',
    sourceable: true,
  },
  payment_record: {
    artifact: 'payment_record',
    description: 'The payment: amount, method, status, capture time, payer VPA.',
    sourceable: true,
  },
  shipment_record: {
    artifact: 'shipment_record',
    description: 'Carrier and tracking id showing the goods were dispatched.',
    sourceable: true,
  },
  delivery_proof: {
    artifact: 'delivery_proof',
    description: 'Delivery confirmation: signature, OTP or carrier proof reference.',
    sourceable: true,
  },
  product_description: {
    artifact: 'product_description',
    description: 'What was actually sold: SKU, name and per-item amount as ordered.',
    sourceable: true,
  },
  customer_communication: {
    artifact: 'customer_communication',
    description:
      'The conversation with the customer -- on the agentic rail, the captured agent trace.',
    sourceable: true,
  },
  authorisation_evidence: {
    artifact: 'authorisation_evidence',
    description:
      'Internal logs showing authorisation was obtained. On the agentic rail: the mandate consent record, the in-limit in-window amount check, and the orchestration log of the payment call.',
    // The orchestration log IS an access/activity log; the capture schema says
    // so in its own words ("it is the access_activity_log source").
    sourceable: true,
  },
  invoice_breakdown: {
    artifact: 'invoice_breakdown',
    description: 'Invoice with a detailed price breakdown across line items.',
    sourceable: true,
  },
  duplicate_payment_analysis: {
    artifact: 'duplicate_payment_analysis',
    description:
      'Whether a second payment exists against the same order, or the two payments are for distinct orders.',
    sourceable: true,
  },
  refund_record: {
    artifact: 'refund_record',
    description: 'Evidence that a refund was generated against this order.',
    sourceable: true,
  },
  item_selection_confirmation: {
    artifact: 'item_selection_confirmation',
    description:
      'A structured record that the customer approved the specific item that was ordered -- the requested SKU alongside the selected SKU, not a sentence about it.',
    sourceable: false,
    notSourceableReason:
      'The capture layer records what the agent selected (the orchestration log entry item_selected) but never what the customer requested, so agreement between the two cannot be established from records. The fact exists only as natural language in the conversation trace, and reading it is a model judgement -- which hard rule #4 forbids on the money path. Repairable: capture the requested SKU at selection time. See D-026 in docs/CASE_STUDY.md.',
  },
  refund_settlement_proof: {
    artifact: 'refund_settlement_proof',
    description:
      'Evidence that the refund actually settled -- its bank settlement reference (UTR/ARN) and the date the money reached the customer, not merely that a refund was raised.',
    // Was `sourceable: false` until P4.0. The capture envelope had no refund
    // object at all, so no merchant using Praman could have supplied this and
    // every UPI 1061 dispute reported it structurally unmet -- correctly, but
    // it cost 5 winnable disputes on the dev corpus (D-030). The fix added the
    // slot to the product; a merchant genuinely holds this record.
    sourceable: true,
  },
  // Added 2026-09-05: five artifacts Razorpay's own published guidance names
  // for UPI reason codes this rubric already covered, but which the capture
  // envelope has no slot for. None of these are `required` on any code -- see
  // the RUBRIC table below -- so adding them, honestly marked unsourceable,
  // cannot change gate coverage or any headline metric. Leaving them out of
  // the table entirely was the actual bug this file existed to prevent: a
  // published item this store cannot supply belongs in the rubric as
  // `not_capturable`, not silently absent from it.
  merchant_refund_policy: {
    artifact: 'merchant_refund_policy',
    description: "The merchant's written refund/return policy document.",
    sourceable: false,
    notSourceableReason:
      "The capture envelope records order and refund facts, never the merchant's policy documents themselves -- nothing at checkout emits a copy of a refund policy PDF. Repairable: a merchant-onboarding step could attach one, but nothing in the transaction-time capture model produces it today.",
  },
  merchant_terms_conditions: {
    artifact: 'merchant_terms_conditions',
    description: "The merchant's written terms and conditions covering refund and fulfilment.",
    sourceable: false,
    notSourceableReason:
      'Same gap as merchant_refund_policy: a T&C document is a merchant-level artifact, not a transaction-time capture, and the capture envelope has no slot for it.',
  },
  customer_withdrawal_letter: {
    artifact: 'customer_withdrawal_letter',
    description: 'A letter from the customer withdrawing their complaint.',
    sourceable: false,
    notSourceableReason:
      'This document, if it exists at all, is produced after the dispute is raised and held by the bank or the customer, never by the merchant at transaction time. Structurally outside what a capture layer can ever supply.',
  },
  alternate_payment_negative_proof: {
    artifact: 'alternate_payment_negative_proof',
    description: 'Proof the disputed amount was not also paid through a different channel.',
    sourceable: false,
    notSourceableReason:
      'Proving a negative across payment channels Praman does not observe (cash, a different gateway, a different merchant account) is outside what any one capture layer can hold.',
  },
  reauth_proof: {
    artifact: 'reauth_proof',
    description: 'Evidence of a re-authorisation attempt for a delayed-settlement claim.',
    sourceable: false,
    notSourceableReason:
      'The capture schema does not model a re-authorisation event distinct from the original payment capture, so there is nothing to report even as absent-but-tracked.',
  },
};

export type RequirementProvenance = 'published' | 'derived';

/**
 * `provenance` and `necessity` answer different questions, and conflating them
 * was a real bug in the first version of this table.
 *
 *   provenance -- WHO says this evidence is relevant. `published` means Razorpay
 *                 listed it, and the exact phrase is quoted. Not our opinion.
 *   necessity  -- WHETHER a contest can stand without it. This is ALWAYS our
 *                 judgement, including on published items, because Razorpay
 *                 publishes evidence *guidance*, not a mandatory checklist. The
 *                 only precondition their API actually enforces is "a minimum of
 *                 one document id across any of the evidence attributes".
 *
 * So a `published` + `supporting` requirement is not a contradiction: Razorpay
 * listed it, and we judge that a contest can stand without it. Marking every
 * published item `required` -- which this table did at first -- silently turned
 * our strictness into their rule, and made the gate abstain on cases Razorpay's
 * own contract would have accepted.
 */
export interface EvidenceRequirement {
  artifact: EvidenceArtifact;
  /** Our judgement, never Razorpay's. See the note above. */
  necessity: 'required' | 'supporting';
  provenance: RequirementProvenance;
  /** `published` only: the exact phrase from Razorpay's guidance this answers. */
  sourcePhrase?: string;
  /** `derived` only: why we require it, since Razorpay publishes no guidance. */
  rationale?: string;
}

export interface RubricEntry {
  network: Network;
  code: string;
  category: DisputeCategory;
  /** True when Razorpay publishes evidence guidance for this code. */
  hasPublishedGuidance: boolean;
  requires: readonly EvidenceRequirement[];
}

function published(
  artifact: EvidenceArtifact,
  sourcePhrase: string,
  necessity: 'required' | 'supporting' = 'required',
): EvidenceRequirement {
  return { artifact, necessity, provenance: 'published', sourcePhrase };
}

function derived(
  artifact: EvidenceArtifact,
  rationale: string,
  necessity: 'required' | 'supporting' = 'required',
): EvidenceRequirement {
  return { artifact, necessity, provenance: 'derived', rationale };
}

/** Rubric key. Networks reuse code numbers, so the network is part of the key. */
export function rubricKey(network: Network, code: string): string {
  return `${network}:${code}`;
}

/**
 * The table itself.
 *
 * Ordering within `requires` follows the order Razorpay lists the evidence in,
 * so a reviewer can read the guidance string and this list side by side.
 */
export const RUBRIC: Record<string, RubricEntry> = {
  // --- UPI, with published guidance -----------------------------------------
  'upi:1061': {
    network: 'upi',
    code: '1061',
    category: 'customer_dispute',
    hasPublishedGuidance: true,
    requires: [
      published('refund_record', 'Proof of refund generation'),
      published(
        'refund_settlement_proof',
        'Bank statement showing refund amount which should match the payment amount',
      ),
      // Added 2026-09-05: these two were on the live page from the start and
      // missing from this transcription -- the omission an adversarial review
      // caught. Both `supporting`: settlement proof already decides the claim
      // (D-030), and neither is sourceable, so this cannot change coverage.
      published('customer_communication', 'Customer communication showing refund confirmation', 'supporting'),
      published('merchant_refund_policy', 'Refund policies', 'supporting'),
      derived(
        'order_record',
        'The refund is only meaningful against the order it reverses.',
        'supporting',
      ),
    ],
  },
  'upi:1062': {
    network: 'upi',
    code: '1062',
    category: 'customer_dispute',
    hasPublishedGuidance: true,
    requires: [
      published('product_description', 'Product description/image screenshots', 'supporting'),
      published('delivery_proof', 'Proof of product/service delivery'),
      // Was `derived`: Razorpay publishes this exact phrase for 1062. Same
      // artifact, same necessity, corrected provenance only.
      published(
        'customer_communication',
        'Customer communication showcasing dissatisfaction',
        'supporting',
      ),
      // Added 2026-09-05, previously omitted from this transcription.
      published('merchant_refund_policy', 'Return policies', 'supporting'),
      derived(
        'item_selection_confirmation',
        'This code turns on whether the item ordered is the item asked for. That agreement is the whole dispute, and the capture layer holds no structured record of it -- so the gate refuses to guess rather than reading the answer out of a conversation.',
      ),
    ],
  },
  'upi:1064': {
    network: 'upi',
    code: '1064',
    category: 'customer_dispute',
    hasPublishedGuidance: true,
    requires: [
      published('delivery_proof', 'Proof of service/product delivery'),
      published(
        'customer_communication',
        'Customer interaction showcasing product/service related enquiries',
        // Razorpay lists it; we judge that delivery proof decides a
        // "not received" claim on its own. An ordinary-rail merchant's support
        // thread is not captured here at all, so treating this as required
        // would abstain the entire ordinary rail on a gap in our capture layer
        // rather than on anything about the dispute.
        'supporting',
      ),
      derived(
        'shipment_record',
        'Dispatch is the weaker half of delivery evidence: it supports a contest but does not establish receipt on its own.',
        'supporting',
      ),
      // Added 2026-09-05, previously omitted from this transcription.
      published(
        'merchant_terms_conditions',
        'Terms & Conditions showcasing refund & fulfillment policies',
        'supporting',
      ),
    ],
  },
  'upi:128': {
    network: 'upi',
    code: '128',
    category: 'fraud',
    hasPublishedGuidance: true,
    requires: [
      // The load-bearing line of the whole product. For an agent-initiated
      // payment, the mandate record and the orchestration log ARE these logs.
      published('authorisation_evidence', 'Internal logs to show authorisation was obtained'),
      // Re-checked 2026-09-05: this quote was itself truncated, dropping "for
      // the debited amount" -- the same class of error F-019 fixed on this
      // exact code, on the clause next to the one F-019 fixed.
      published(
        'invoice_breakdown',
        'Invoicing details along with detailed price breakdown for the debited amount',
        'supporting',
      ),
      derived(
        'customer_communication',
        'On the agentic rail the conversation trace is where consent is actually visible, and it cuts both ways: it is also the evidence that defeats a contest when consent is absent.',
        'supporting',
      ),
      // Added 2026-09-03 by the P5.4 fact-check (FAILURES.md F-019). The
      // published guidance for 128 has THREE clauses and this transcription
      // carried two; hard rule #1 says a documented field is never omitted.
      //
      // `supporting`, not `required`, and that is our judgement rather than
      // theirs (D-026). A fraud claim on an agent-initiated payment is answered
      // by proving authorisation, not delivery: b1's whole point is that the
      // goods arrived and the customer disputes having asked for them. Making
      // delivery proof required here would abstain on cases the mandate record
      // already settles -- which is a worse product for a more literal reading.
      published(
        'delivery_proof',
        'Proof of service/goods delivery clearly mentioning customer name and address details',
        'supporting',
      ),
    ],
  },

  // --- UPI, published guidance restored 2026-09-05 ---------------------------
  //
  // These seven codes were marked `hasPublishedGuidance: false` and given
  // fully `derived` requirement lists. That was wrong: Razorpay's
  // submit-evidence page publishes evidence guidance for all seven -- the
  // actual bug was in reason-codes.ts, whose `evidenceGuidance` sat empty for
  // these codes despite the file's own docblock claiming a full transcription.
  // An adversarial review checking the live page directly, rather than this
  // file's internal cross-check against reason-codes.ts, is what caught it
  // (see FAILURES.md's entry on this). Every `derived` requirement Praman had
  // already assigned stays exactly as it was -- same artifact, same necessity
  // -- so gate coverage does not move; the published items are added
  // alongside them, all `supporting` unless a derived requirement already
  // covered the identical fact, in which case that entry's provenance is
  // corrected to `published` in place.
  'upi:1084': {
    network: 'upi',
    code: '1084',
    category: 'processing_error',
    hasPublishedGuidance: true,
    requires: [
      // Was `derived`: this is the same fact Razorpay's first bullet names.
      published(
        'duplicate_payment_analysis',
        'System logs to prove only one transaction was processed for single authorisation',
      ),
      published(
        'invoice_breakdown',
        'Invoicing to prove each transaction was for separate service/product',
        'supporting',
      ),
      derived('order_record', 'Establishes whether the two payments belong to one order or two.'),
      derived('payment_record', 'The payments being compared.'),
    ],
  },
  'upi:1085': {
    network: 'upi',
    code: '1085',
    category: 'processing_error',
    hasPublishedGuidance: true,
    requires: [
      // Was `derived`: matches "Authorisation proof showing final amount was
      // authorised by cardholder" -- on the agentic rail, the mandate cap.
      published(
        'authorisation_evidence',
        'Authorisation proof showing final amount was authorised by cardholder',
      ),
      // Was `derived`: matches the invoice bullet verbatim.
      published(
        'invoice_breakdown',
        'Invoice with detailed price breakdown (price, taxes, fee, discount and so on) prove amount charged was correct',
        'supporting',
      ),
      published(
        'product_description',
        'Screenshot of product/service along with the price details',
        'supporting',
      ),
      published('payment_record', 'System logs to show correct amount was charged', 'supporting'),
      derived('order_record', 'The amount charged, against the amount ordered.'),
    ],
  },
  'upi:1063': {
    network: 'upi',
    code: '1063',
    category: 'processing_error',
    hasPublishedGuidance: true,
    requires: [
      derived('payment_record', 'Whether this payment succeeded is the question being asked.'),
      derived('order_record', 'Establishes what was being paid for, and once.'),
      published(
        'alternate_payment_negative_proof',
        'Proof showing payment was not received using any other method',
        'supporting',
      ),
      published(
        'refund_record',
        'Refund proof if amount was refunded for duplicate charge',
        'supporting',
      ),
      published(
        'product_description',
        'Proof to show the claimed transaction was for a different product/service',
        'supporting',
      ),
    ],
  },
  'upi:1081': {
    network: 'upi',
    code: '1081',
    category: 'processing_error',
    hasPublishedGuidance: true,
    requires: [
      // Was `derived`: matches the timestamp bullet.
      published(
        'payment_record',
        'Time stamp of transaction and processing of the payment showing debit amount',
      ),
      published(
        'authorisation_evidence',
        'Internal logs to prove that charge was submitted within allowed time frame',
        'supporting',
      ),
      published('reauth_proof', 'In case of re-auth, please provide proof of same', 'supporting'),
      published('authorisation_evidence', 'Customer authorisation proof', 'supporting'),
      published(
        'invoice_breakdown',
        'Masked card details and invoice of the transaction',
        'supporting',
      ),
    ],
  },
  'upi:108': {
    network: 'upi',
    code: '108',
    category: 'authorisation_error',
    hasPublishedGuidance: true,
    requires: [
      derived('payment_record', 'Whether the beneficiary was credited is a payment-record fact.'),
      published('delivery_proof', 'Proof of service/product delivery', 'supporting'),
      published(
        'customer_communication',
        'Customer interaction showcasing product/service related enquiries',
        'supporting',
      ),
      published('customer_withdrawal_letter', 'Customer Withdrawn letter', 'supporting'),
      published(
        'merchant_terms_conditions',
        'Terms & Conditions showcasing refund & fulfillment policies',
        'supporting',
      ),
    ],
  },
  'upi:1065': {
    network: 'upi',
    code: '1065',
    category: 'authorisation_error',
    hasPublishedGuidance: true,
    requires: [
      derived('payment_record', 'Whether the transaction failed is a payment-record fact.'),
      published('delivery_proof', 'Proof of service/product delivery', 'supporting'),
      published(
        'customer_communication',
        'Customer interaction showcasing product/service related enquiries',
        'supporting',
      ),
      published('customer_withdrawal_letter', 'Customer Withdrawn letter', 'supporting'),
      published(
        'merchant_terms_conditions',
        'Terms & Conditions showcasing refund & fulfillment policies',
        'supporting',
      ),
    ],
  },
  'upi:121': {
    network: 'upi',
    code: '121',
    category: 'authorisation_error',
    hasPublishedGuidance: true,
    requires: [
      derived('payment_record', 'Credit status is a payment-record fact.'),
      published('delivery_proof', 'Proof of service/product delivery', 'supporting'),
      published(
        'customer_communication',
        'Customer interaction showcasing product/service related enquiries',
        'supporting',
      ),
      published('customer_withdrawal_letter', 'Customer Withdrawn letter', 'supporting'),
      published(
        'merchant_terms_conditions',
        'Terms & Conditions showcasing refund & fulfillment policies',
        'supporting',
      ),
    ],
  },

  // --- RuPay, no published guidance on the page -----------------------------
  'rupay:1104': {
    network: 'rupay',
    code: '1104',
    category: 'fraud',
    hasPublishedGuidance: false,
    requires: [
      derived(
        'authorisation_evidence',
        'An unrecognised-transaction claim is answered by whatever authorisation record exists. On the ordinary rail that record is thin, which is the honest contrast with the agentic rail.',
      ),
      derived('order_record', 'Ties the charge to a real order the customer placed.'),
      derived('invoice_breakdown', 'Shows the customer what the charge was for.', 'supporting'),
    ],
  },
  'rupay:1064': {
    network: 'rupay',
    code: '1064',
    category: 'customer_dispute',
    hasPublishedGuidance: false,
    requires: [
      derived('delivery_proof', 'Receipt is the fact in dispute.'),
      derived('shipment_record', 'Dispatch supports it without establishing receipt.', 'supporting'),
      derived(
        'order_record',
        'Establishes what was ordered and for how much, which a delivery proof on its own does not.',
      ),
    ],
  },
  'rupay:1061': {
    network: 'rupay',
    code: '1061',
    category: 'customer_dispute',
    hasPublishedGuidance: false,
    requires: [
      derived('refund_record', 'Whether a refund was generated is the fact in dispute.'),
      derived('order_record', 'The order the refund reverses.'),
    ],
  },
  'rupay:1084': {
    network: 'rupay',
    code: '1084',
    category: 'processing_error',
    hasPublishedGuidance: false,
    requires: [
      derived('duplicate_payment_analysis', 'How many payments exist against one order.'),
      derived(
        'order_record',
        'Two payments against one order is a real duplicate; two payments against two orders is not. The order record is what separates them.',
      ),
      derived('payment_record', 'The payments being compared.'),
    ],
  },
};

/** Requirements for a reason code, or undefined if the code is not in the rubric. */
export function requirementsFor(network: Network, code: string): RubricEntry | undefined {
  return RUBRIC[rubricKey(network, code)];
}

/** Requirements for a scenario class, via the reason code it is generated with. */
export function requirementsForScenario(scenarioClass: ScenarioClass): RubricEntry {
  const scenario = SCENARIOS[scenarioClass];
  const entry = requirementsFor(scenario.network, scenario.reasonCode);
  if (!entry) {
    throw new Error(
      `no rubric entry for ${scenario.network}:${scenario.reasonCode} (scenario ${scenarioClass})`,
    );
  }
  return entry;
}

/** Only the requirements our capture layer can actually satisfy. */
export function sourceableRequirements(entry: RubricEntry): EvidenceRequirement[] {
  return entry.requires.filter((requirement) => ARTIFACTS[requirement.artifact].sourceable);
}

/** Every reason code the rubric covers, for coverage tests. */
export function rubricCoverage(): { covered: string[]; uncovered: string[] } {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const reasonCode of ALL_REASON_CODES) {
    const key = rubricKey(reasonCode.network, reasonCode.code);
    if (RUBRIC[key]) covered.push(key);
    else uncovered.push(key);
  }
  return { covered, uncovered };
}
