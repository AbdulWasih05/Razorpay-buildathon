import type { EvidencePackIngest, MandateInput, Rail } from '../capture/ingest.js';
import type { Network } from './reason-codes.js';
import {
  ARTIFACTS,
  type EvidenceArtifact,
  type EvidenceRequirement,
  type RubricEntry,
  requirementsFor,
} from './rubric.js';

/**
 * The deterministic evidence collector (TASKS.md P2.2).
 *
 * Given a dispute and the evidence pack captured at transaction time, report
 * what the rubric asks for and what the store actually holds. Pure functions.
 * No LLM, no I/O, no clock: the same pack and dispute always produce the same
 * report, which is what makes the eval reproducible and the gate testable.
 *
 * The collector DECIDES NOTHING. It reports presence and computes arithmetic.
 * Whether to contest is the gate's call (P3.1); the words are the drafter's
 * (P2.3). Keeping those three apart is the whole reason the money path is
 * inspectable.
 *
 * Three finding states, not two -- the distinction matters:
 *   present        -- we hold it, with references into the store.
 *   absent         -- it could have been captured for this transaction and was
 *                     not, or the fact it asserts is not true (nothing was
 *                     delivered, no refund was issued).
 *   not_capturable -- Praman structurally cannot produce it for ANY dispute.
 *                     A bank statement is not a merchant record. Saying so is
 *                     more useful than an absence that looks like an oversight.
 */

export const FINDING_STATES = ['present', 'absent', 'not_capturable'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export interface ArtifactFinding {
  artifact: EvidenceArtifact;
  state: FindingState;
  necessity: EvidenceRequirement['necessity'];
  /** Why it is not present. Required whenever `state` is not `present`. */
  reason?: string;
  /** `externalId`-level pointers into the capture store, for the audit trail. */
  references: string[];
  /** Structured facts the mapper and the drafter build on. Never prose. */
  detail: Record<string, unknown>;
}

/**
 * Mandate arithmetic. Explicitly NOT AI: interval comparison and a `<=`.
 * A model here would be strictly worse and strictly less explainable
 * (DECISIONS.md, "Where we deliberately did NOT use AI").
 */
export interface MandateChecks {
  present: boolean;
  status?: MandateInput['status'];
  maxAmount?: number;
  chargedAmount: number;
  withinLimit?: boolean;
  validFrom?: string;
  validUntil?: string;
  paymentAt?: string;
  withinValidityWindow?: boolean;
  consentBeforePayment?: boolean;
}

export interface CollectedEvidence {
  disputeId: string;
  packExternalId: string;
  rail: Rail;
  network: Network;
  reasonCode: string;
  /** The rubric entry this dispute was assessed against. */
  rubric: RubricEntry;
  findings: ArtifactFinding[];
  /** Required artifacts we do not hold, whatever the reason. */
  missingRequired: EvidenceArtifact[];
  /** Required artifacts we could never hold. A subset of `missingRequired`. */
  structurallyUnavailable: EvidenceArtifact[];
  coverage: { required: number; present: number; ratio: number };
  mandate: MandateChecks;
  /** Deterministic anomaly signals from the orchestration log, if any. */
  anomalySignals: string[];
}

export interface DisputeContext {
  disputeId: string;
  network: Network;
  reasonCode: string;
  /** Disputed amount in subunits. */
  amount: number;
}

/**
 * A second payment against the same order, when the caller can supply one.
 *
 * Today the capture envelope is one order and one payment, so nothing populates
 * this and duplicate-processing claims report `not_capturable`. The parameter
 * exists so that the day the store captures sibling payments, the collector
 * needs no reshaping. See FAILURES.md F-010.
 */
export interface RelatedPayment {
  paymentExternalId: string;
  orderExternalId: string;
  amount: number;
  capturedAt: string | null;
}

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function computeMandateChecks(pack: EvidencePackIngest): MandateChecks {
  const chargedAmount = pack.payment.amount;
  const mandate = pack.mandate;
  if (!mandate) return { present: false, chargedAmount };

  const paymentAt = pack.payment.capturedAt ?? pack.payment.occurredAt;
  return {
    present: true,
    status: mandate.status,
    maxAmount: mandate.maxAmount,
    chargedAmount,
    withinLimit: chargedAmount <= mandate.maxAmount,
    validFrom: iso(mandate.validFrom),
    validUntil: iso(mandate.validUntil),
    paymentAt: iso(paymentAt),
    withinValidityWindow:
      paymentAt >= mandate.validFrom && paymentAt <= mandate.validUntil,
    consentBeforePayment: mandate.consentAt <= paymentAt,
  };
}

function anomalySignals(pack: EvidencePackIngest): string[] {
  // Structured signals only. Reading the conversation for anomalies is natural
  // language work and belongs to the LLM layer, flagged as ambiguity -- not
  // decided here.
  const signals: string[] = [];
  for (const log of pack.orchestrationLogs) {
    if (log.action !== 'session_anomaly_detected') continue;
    const signal = log.detail['signal'];
    signals.push(typeof signal === 'string' ? signal : log.action);
  }
  return signals;
}

type Collect = (
  pack: EvidencePackIngest,
  context: DisputeContext,
  related: readonly RelatedPayment[],
) => Omit<ArtifactFinding, 'artifact' | 'necessity'>;

const absent = (reason: string): Omit<ArtifactFinding, 'artifact' | 'necessity'> => ({
  state: 'absent',
  reason,
  references: [],
  detail: {},
});

const notCapturable = (reason: string): Omit<ArtifactFinding, 'artifact' | 'necessity'> => ({
  state: 'not_capturable',
  reason,
  references: [],
  detail: {},
});

/**
 * One collector per artifact kind. Each is a pure function of the pack.
 *
 * They are deliberately literal about what counts. `delivery_proof` is not
 * "we shipped it" -- it is a delivery confirmation reference. Softening these
 * would inflate coverage and produce exactly the bluffed contests the gate
 * exists to prevent.
 */
const COLLECTORS: Record<EvidenceArtifact, Collect> = {
  order_record: (pack) => ({
    state: 'present',
    references: [pack.order.externalId],
    detail: {
      amount: pack.order.amount,
      currency: pack.order.currency,
      status: pack.order.status,
      itemCount: pack.order.items.length,
      placedAt: iso(pack.order.placedAt),
    },
  }),

  payment_record: (pack) => ({
    state: 'present',
    references: [pack.payment.externalId, pack.payment.razorpayPaymentId],
    detail: {
      razorpayPaymentId: pack.payment.razorpayPaymentId,
      amount: pack.payment.amount,
      method: pack.payment.method,
      status: pack.payment.status,
      capturedAt: iso(pack.payment.capturedAt),
      vpa: pack.payment.vpa ?? null,
    },
  }),

  shipment_record: (pack) => {
    const fulfillment = pack.fulfillment;
    if (!fulfillment) return absent('no fulfilment record was captured for this order');
    if (fulfillment.status === 'pending') {
      return absent('the order was never dispatched');
    }
    if (!fulfillment.carrier && !fulfillment.trackingId) {
      return absent('the fulfilment record carries neither a carrier nor a tracking id');
    }
    return {
      state: 'present',
      references: [fulfillment.externalId],
      detail: {
        status: fulfillment.status,
        carrier: fulfillment.carrier ?? null,
        trackingId: fulfillment.trackingId ?? null,
        shippedAt: iso(fulfillment.shippedAt),
      },
    };
  },

  delivery_proof: (pack) => {
    const fulfillment = pack.fulfillment;
    if (!fulfillment) return absent('no fulfilment record was captured for this order');
    if (fulfillment.status !== 'delivered') {
      return absent(`fulfilment status is "${fulfillment.status}", not delivered`);
    }
    if (!fulfillment.proofRef) {
      // The ambiguous middle: delivered per our own record, but nothing a card
      // network would accept as proof of it.
      return absent('marked delivered, but no signature, OTP or carrier proof reference exists');
    }
    return {
      state: 'present',
      references: [fulfillment.externalId, fulfillment.proofRef],
      detail: { proofRef: fulfillment.proofRef, deliveredAt: iso(fulfillment.deliveredAt) },
    };
  },

  product_description: (pack) => ({
    state: 'present',
    references: [pack.order.externalId],
    detail: {
      items: pack.order.items.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        amount: item.amount,
      })),
    },
  }),

  customer_communication: (pack) => {
    const trace = pack.conversationTrace;
    if (!trace) {
      return absent(
        pack.rail === 'agentic'
          ? 'no conversation trace was captured'
          : 'an ordinary checkout leaves no captured conversation with the customer',
      );
    }
    return {
      state: 'present',
      references: [trace.externalId],
      detail: {
        turnCount: trace.turns.length,
        startedAt: iso(trace.startedAt),
        // Turn text is the LLM layer's input, not the collector's business. We
        // report the shape; summarising the content is P2.3's job.
        roles: trace.turns.map((turn) => turn.role),
      },
    };
  },

  authorisation_evidence: (pack) => {
    if (pack.rail !== 'agentic') {
      // The honest contrast the whole product is built on. A human checkout in
      // this store leaves a payment record, and a payment record does not show
      // that authorisation was obtained.
      return absent(
        'an ordinary checkout leaves no authorisation log: the payment record shows a charge occurred, not that the customer authorised it',
      );
    }
    const mandate = pack.mandate;
    if (!mandate) return absent('agentic pack with no mandate record');
    if (pack.orchestrationLogs.length === 0) {
      return absent('agentic pack with no orchestration log');
    }
    return {
      state: 'present',
      references: [
        mandate.externalId,
        ...pack.orchestrationLogs.map((log) => log.externalId),
      ],
      detail: {
        agentId: mandate.agentId,
        agentPlatform: mandate.agentPlatform,
        consentAt: iso(mandate.consentAt),
        mandateStatus: mandate.status,
        orchestrationActions: pack.orchestrationLogs.map((log) => log.action),
        protocol: pack.agentic?.protocol ?? null,
        protocolVersion: pack.agentic?.protocolVersion ?? null,
      },
    };
  },

  invoice_breakdown: (pack) => ({
    state: 'present',
    references: [pack.order.externalId, pack.payment.externalId],
    detail: {
      lineItems: pack.order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        amount: item.amount,
      })),
      orderTotal: pack.order.amount,
      charged: pack.payment.amount,
      currency: pack.order.currency,
    },
  }),

  duplicate_payment_analysis: (pack, _context, related) => {
    if (related.length === 0) {
      // See FAILURES.md F-010. Reporting "no duplicate found" here would be a
      // confident wrong answer on the money path: we have not looked, because
      // the store holds one payment per order.
      return notCapturable(
        'the capture store holds one payment per order, so a second payment against this order cannot be confirmed or ruled out from the captured pack',
      );
    }
    const sameOrder = related.filter((payment) => payment.orderExternalId === pack.order.externalId);
    return {
      state: 'present',
      references: related.map((payment) => payment.paymentExternalId),
      detail: {
        relatedPaymentCount: related.length,
        sameOrderPaymentCount: sameOrder.length,
        isDuplicate: sameOrder.length > 0,
      },
    };
  },

  refund_record: (pack) => {
    if (pack.order.status !== 'refunded') {
      return absent(`order status is "${pack.order.status}": no refund was issued against it`);
    }
    return {
      state: 'present',
      references: [pack.order.externalId],
      detail: { orderStatus: pack.order.status, amount: pack.order.amount },
    };
  },

  item_selection_confirmation: () =>
    notCapturable(ARTIFACTS.item_selection_confirmation.notSourceableReason as string),

  refund_settlement_proof: (pack) => {
    // The distinction this artifact exists for: a refund that was RAISED is not
    // a refund that was PAID, and UPI 1061 is a complaint that the money never
    // arrived. Reporting a created-but-unsettled refund as settlement proof
    // would contest a dispute the customer is right about.
    const refund = pack.refund;
    if (!refund) {
      return absent('no refund was captured against this order');
    }
    if (refund.status !== 'processed' || !refund.utr) {
      return absent(
        `refund ${refund.externalId} is "${refund.status}" with no settlement reference: it was raised but the money has not been shown to reach the customer`,
      );
    }
    return {
      state: 'present',
      references: [refund.externalId, refund.utr],
      detail: {
        utr: refund.utr,
        amount: refund.amount,
        settledAt: refund.settledAt ?? null,
        initiatedAt: refund.initiatedAt,
      },
    };
  },
};

/**
 * Collect the evidence a dispute's reason code calls for.
 *
 * Throws when the reason code is not in the rubric: an unknown code must stop
 * the pipeline and reach a human, not be assessed against an empty rubric that
 * would look like "nothing was required".
 */
export function collectEvidence(
  pack: EvidencePackIngest,
  context: DisputeContext,
  related: readonly RelatedPayment[] = [],
): CollectedEvidence {
  const rubric = requirementsFor(context.network, context.reasonCode);
  if (!rubric) {
    throw new Error(
      `no rubric entry for ${context.network}:${context.reasonCode}; dispute ${context.disputeId} needs manual review`,
    );
  }

  const findings: ArtifactFinding[] = rubric.requires.map((requirement) => {
    const collected = COLLECTORS[requirement.artifact](pack, context, related);
    return { artifact: requirement.artifact, necessity: requirement.necessity, ...collected };
  });

  const requiredFindings = findings.filter((finding) => finding.necessity === 'required');
  const presentRequired = requiredFindings.filter((finding) => finding.state === 'present');
  const missingRequired = requiredFindings
    .filter((finding) => finding.state !== 'present')
    .map((finding) => finding.artifact);
  const structurallyUnavailable = requiredFindings
    .filter((finding) => finding.state === 'not_capturable')
    .map((finding) => finding.artifact);

  return {
    disputeId: context.disputeId,
    packExternalId: pack.externalId,
    rail: pack.rail,
    network: context.network,
    reasonCode: context.reasonCode,
    rubric,
    findings,
    missingRequired,
    structurallyUnavailable,
    coverage: {
      required: requiredFindings.length,
      present: presentRequired.length,
      ratio:
        requiredFindings.length === 0
          ? 1
          : presentRequired.length / requiredFindings.length,
    },
    mandate: computeMandateChecks(pack),
    anomalySignals: anomalySignals(pack),
  };
}

/** Every finding that is not present, with its reason. Used by the audit trail. */
export function unmetRequirements(collected: CollectedEvidence): ArtifactFinding[] {
  return collected.findings.filter((finding) => finding.state !== 'present');
}
