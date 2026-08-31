import type { ContestEvidenceField } from '../schema/contest.js';
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
 *    this is *our* considered view, labelled as ours. A test asserts that no
 *    `published` requirement exists for a code with no published guidance, so
 *    the two can never quietly blur.
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
] as const;

export type EvidenceArtifact = (typeof EVIDENCE_ARTIFACTS)[number];

export interface ArtifactDefinition {
  artifact: EvidenceArtifact;
  /** What this artifact is, in one line. */
  description: string;
  /** The Razorpay contest field this artifact lands in. */
  contestField: ContestEvidenceField;
  /**
   * When `contestField` is `others`, Razorpay requires a `type` label. Set here
   * so the mapper never invents one at the call site.
   */
  othersType?: string;
  /** Whether Praman's capture layer can produce this at all. */
  sourceable: boolean;
  /** Required when `sourceable` is false. Stated, not hidden. */
  notSourceableReason?: string;
}

export const ARTIFACTS: Record<EvidenceArtifact, ArtifactDefinition> = {
  order_record: {
    artifact: 'order_record',
    description: 'The order: items, quantities, amounts, status and placement time.',
    contestField: 'billing_proof',
    sourceable: true,
  },
  payment_record: {
    artifact: 'payment_record',
    description: 'The payment: amount, method, status, capture time, payer VPA.',
    contestField: 'billing_proof',
    sourceable: true,
  },
  shipment_record: {
    artifact: 'shipment_record',
    description: 'Carrier and tracking id showing the goods were dispatched.',
    contestField: 'shipping_proof',
    sourceable: true,
  },
  delivery_proof: {
    artifact: 'delivery_proof',
    description: 'Delivery confirmation: signature, OTP or carrier proof reference.',
    contestField: 'shipping_proof',
    sourceable: true,
  },
  product_description: {
    artifact: 'product_description',
    description: 'What was actually sold: SKU, name and per-item amount as ordered.',
    contestField: 'others',
    othersType: 'product_description',
    sourceable: true,
  },
  customer_communication: {
    artifact: 'customer_communication',
    description:
      'The conversation with the customer -- on the agentic rail, the captured agent trace.',
    contestField: 'customer_communication',
    sourceable: true,
  },
  authorisation_evidence: {
    artifact: 'authorisation_evidence',
    description:
      'Internal logs showing authorisation was obtained. On the agentic rail: the mandate consent record, the in-limit in-window amount check, and the orchestration log of the payment call.',
    // The orchestration log IS an access/activity log; the capture schema says
    // so in its own words ("it is the access_activity_log source").
    contestField: 'access_activity_log',
    sourceable: true,
  },
  invoice_breakdown: {
    artifact: 'invoice_breakdown',
    description: 'Invoice with a detailed price breakdown across line items.',
    contestField: 'others',
    othersType: 'invoice_with_price_breakdown',
    sourceable: true,
  },
  duplicate_payment_analysis: {
    artifact: 'duplicate_payment_analysis',
    description:
      'Whether a second payment exists against the same order, or the two payments are for distinct orders.',
    contestField: 'others',
    othersType: 'duplicate_payment_analysis',
    sourceable: true,
  },
  refund_record: {
    artifact: 'refund_record',
    description: 'Evidence that a refund was generated against this order.',
    contestField: 'refund_confirmation',
    sourceable: true,
  },
  item_selection_confirmation: {
    artifact: 'item_selection_confirmation',
    description:
      'A structured record that the customer approved the specific item that was ordered -- the requested SKU alongside the selected SKU, not a sentence about it.',
    contestField: 'customer_communication',
    sourceable: false,
    notSourceableReason:
      'The capture layer records what the agent selected (the orchestration log entry item_selected) but never what the customer requested, so agreement between the two cannot be established from records. The fact exists only as natural language in the conversation trace, and reading it is a model judgement -- which hard rule #4 forbids on the money path. Repairable: capture the requested SKU at selection time. See DECISIONS.md D-026.',
  },
  refund_settlement_proof: {
    artifact: 'refund_settlement_proof',
    description:
      'Bank statement showing the refund amount, matching the payment amount, actually settled.',
    contestField: 'refund_confirmation',
    sourceable: false,
    notSourceableReason:
      'A merchant transaction store holds no bank statement. This would come from the settlement or gateway payout record, which Praman does not capture. Disputes on UPI 1061 will therefore report this requirement as structurally unmet rather than pretend otherwise.',
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
        'Bank statement showing refund amount which should match payment amount',
      ),
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
      derived(
        'customer_communication',
        'Whether the customer confirmed this specific item is what decides a "not as described" claim, and on the agentic rail the trace records it verbatim.',
        'supporting',
      ),
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
      published(
        'invoice_breakdown',
        'Invoicing details along with detailed price breakdown',
        'supporting',
      ),
      derived(
        'customer_communication',
        'On the agentic rail the conversation trace is where consent is actually visible, and it cuts both ways: it is also the evidence that defeats a contest when consent is absent.',
        'supporting',
      ),
    ],
  },

  // --- UPI, no published guidance: requirements are ours, and say so ---------
  'upi:1084': {
    network: 'upi',
    code: '1084',
    category: 'processing_error',
    hasPublishedGuidance: false,
    requires: [
      derived(
        'duplicate_payment_analysis',
        'A duplicate-processing claim is a factual question about how many payments exist against one order. Answering it is the whole contest.',
      ),
      derived('order_record', 'Establishes whether the two payments belong to one order or two.'),
      derived('payment_record', 'The payments being compared.'),
    ],
  },
  'upi:1085': {
    network: 'upi',
    code: '1085',
    category: 'processing_error',
    hasPublishedGuidance: false,
    requires: [
      derived(
        'authorisation_evidence',
        'The claim is that the charge exceeded what was authorised, so the authorisation ceiling -- on the agentic rail, the mandate cap -- is the fact in dispute.',
      ),
      derived('invoice_breakdown', 'Shows what the charged amount was actually composed of.'),
      derived('order_record', 'The amount charged, against the amount ordered.'),
    ],
  },
  'upi:1063': {
    network: 'upi',
    code: '1063',
    category: 'processing_error',
    hasPublishedGuidance: false,
    requires: [
      derived('payment_record', 'Whether this payment succeeded is the question being asked.'),
      derived('order_record', 'Establishes what was being paid for, and once.'),
    ],
  },
  'upi:1081': {
    network: 'upi',
    code: '1081',
    category: 'processing_error',
    hasPublishedGuidance: false,
    requires: [derived('payment_record', 'Settlement timing is a fact about the payment record.')],
  },
  'upi:108': {
    network: 'upi',
    code: '108',
    category: 'authorisation_error',
    hasPublishedGuidance: false,
    requires: [
      derived('payment_record', 'Whether the beneficiary was credited is a payment-record fact.'),
    ],
  },
  'upi:1065': {
    network: 'upi',
    code: '1065',
    category: 'authorisation_error',
    hasPublishedGuidance: false,
    requires: [derived('payment_record', 'Whether the transaction failed is a payment-record fact.')],
  },
  'upi:121': {
    network: 'upi',
    code: '121',
    category: 'authorisation_error',
    hasPublishedGuidance: false,
    requires: [derived('payment_record', 'Credit status is a payment-record fact.')],
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
