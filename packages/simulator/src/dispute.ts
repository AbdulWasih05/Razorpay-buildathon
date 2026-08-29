import {
  ALL_REASON_CODES,
  SCENARIOS,
  disputeWebhookEventSchema,
  type DisputeEntity,
  type DisputePhase,
  type DisputeWebhookEvent,
  type GroundTruth,
  type Rail,
  type ScenarioClass,
} from '@praman/core';

import { createRng, MINUTES_PER_DAY, shift } from './rng.js';
import { razorpayShapedId } from './ids.js';
import type { GeneratedTransaction } from './transaction.js';
import type { GeneratorConfig } from './configs.js';

/**
 * Turns a generated transaction into a dispute, emitted in Razorpay's exact
 * webhook shape.
 *
 * The output is validated against the contract schema built in P0.3 before it
 * is returned. That is not belt-and-braces: it means the simulator physically
 * cannot emit a dispute that the real ingest path would reject, so "our
 * simulator agrees with the documented API" is enforced rather than asserted.
 */

export interface GeneratedDispute {
  /** Razorpay dispute id, `disp_`-prefixed. */
  disputeId: string;
  /** Stable, seed-derived id for our own bookkeeping. */
  externalId: string;
  scenarioClass: ScenarioClass;
  rail: Rail;
  corpus: 'dev' | 'ood_holdout';
  seed: string;
  groundTruth: GroundTruth;
  groundTruthRationale: string;
  amount: number;
  currency: string;
  raisedAt: Date;
  respondBy: Date;
  /** The full webhook envelope, contract-validated. */
  event: DisputeWebhookEvent;
  /** The transaction this dispute is about. */
  transaction: GeneratedTransaction;
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Most disputes arrive as chargebacks. `retrieval` and `pre_arbitration` appear
 * at low rates so the pipeline is exercised against the phases it will really
 * see -- including the two CLAUDE.md's summary omitted (see DECISIONS.md D-002).
 */
function pickPhase(roll: number): DisputePhase {
  if (roll < 0.08) return 'retrieval';
  if (roll < 0.16) return 'pre_arbitration';
  return 'chargeback';
}

export function generateDispute(
  config: GeneratorConfig,
  transaction: GeneratedTransaction,
): GeneratedDispute {
  const scenario = SCENARIOS[transaction.scenarioClass];
  const label = `${config.name}:${transaction.scenarioClass}:${transaction.index}`;
  const rng = createRng(`${config.seed}::dispute::${label}`);

  // Issuers raise disputes weeks to months after capture; the response window
  // is short. Both facts are what makes deadline-awareness a real requirement.
  const raisedAt = shift(transaction.capturedAt, rng.int(20, 90) * MINUTES_PER_DAY);
  const respondBy = shift(raisedAt, rng.int(5, 10) * MINUTES_PER_DAY);

  const disputeId = razorpayShapedId('disp_', `${config.seed}:disp:${label}`);
  const accountId = razorpayShapedId('acc_', `${config.seed}:acc:${config.name}`);
  const orderRef = razorpayShapedId('order_', `${config.seed}:order:${label}`);

  const reasonCode = ALL_REASON_CODES.find(
    (entry) => entry.network === scenario.network && entry.code === scenario.reasonCode,
  );
  if (!reasonCode) {
    // A scenario pointing at a reason code we never transcribed is a bug in the
    // catalogue, not a runtime condition to paper over.
    throw new Error(
      `scenario ${scenario.id} references unknown reason code ${scenario.network}/${scenario.reasonCode}`,
    );
  }

  const payment = transaction.pack.payment;

  const disputeEntity: DisputeEntity = {
    id: disputeId,
    entity: 'dispute',
    payment_id: payment.razorpayPaymentId,
    amount: transaction.amount,
    currency: transaction.currency,
    amount_deducted: 0,
    reason_code: reasonCode.code,
    reason_description: reasonCode.description,
    respond_by: unix(respondBy),
    status: 'open',
    phase: pickPhase(rng.next()),
    created_at: unix(raisedAt),
    // A freshly raised dispute carries no evidence. Populating it is our job.
    evidence: {
      amount: transaction.amount,
      summary: null,
      shipping_proof: null,
      billing_proof: null,
      cancellation_proof: null,
      customer_communication: null,
      proof_of_service: null,
      explanation_letter: null,
      refund_confirmation: null,
      access_activity_log: null,
      refund_cancellation_policy: null,
      term_and_conditions: null,
      others: null,
      submitted_at: null,
    },
  };

  const event = disputeWebhookEventSchema.parse({
    entity: 'event',
    account_id: accountId,
    event: 'payment.dispute.created',
    contains: ['payment', 'dispute'],
    payload: {
      payment: {
        entity: {
          id: payment.razorpayPaymentId,
          entity: 'payment',
          amount: transaction.amount,
          currency: transaction.currency,
          base_amount: transaction.amount,
          status: 'captured',
          order_id: orderRef,
          invoice_id: null,
          international: false,
          method: payment.method,
          amount_refunded: transaction.facts.refundIssued ? transaction.amount : 0,
          amount_transferred: 0,
          refund_status: transaction.facts.refundIssued ? 'full' : null,
          captured: true,
          description: null,
          card_id: null,
          bank: null,
          wallet: null,
          vpa: payment.vpa ?? null,
          email: transaction.pack.customer.email,
          contact: transaction.pack.customer.contact,
          notes: {},
          fee: 0,
          tax: 0,
          error_code: null,
          error_description: null,
          error_source: null,
          error_step: null,
          error_reason: null,
          acquirer_data: {},
          created_at: unix(transaction.capturedAt),
        },
      },
      dispute: { entity: disputeEntity },
    },
    created_at: unix(raisedAt),
  });

  return {
    disputeId,
    externalId: `dsp_${config.name}_${transaction.scenarioClass}_${transaction.index}`,
    scenarioClass: transaction.scenarioClass,
    rail: transaction.rail,
    corpus: config.corpus,
    seed: config.seed,
    groundTruth: transaction.facts.groundTruth,
    groundTruthRationale: transaction.facts.groundTruthRationale,
    amount: transaction.amount,
    currency: transaction.currency,
    raisedAt,
    respondBy,
    event,
    transaction,
  };
}
