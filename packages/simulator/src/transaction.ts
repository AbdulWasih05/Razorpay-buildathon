import {
  SCENARIOS,
  type EvidencePackIngestInput,
  type GroundTruth,
  type Rail,
  type ScenarioClass,
} from '@praman/core';

import { atOffset, createRng, hashSeed, MINUTES_PER_DAY, shift, type Rng } from './rng.js';
import type { GeneratorConfig } from './configs.js';
import { razorpayShapedId } from './ids.js';

/**
 * Generates one complete transaction: the parties, the order, the payment, the
 * fulfilment, and -- on the agentic rail -- the mandate, conversation trace and
 * orchestration log that a dispute will later be defended with.
 *
 * Everything is derived from `config.seed` plus the scenario class plus the
 * index. No `Math.random()`, no `Date.now()`. Reseeding produces a logically
 * identical transaction, which is what the determinism test asserts.
 *
 * The ground-truth label is **derived from the evidence actually generated**,
 * never asserted separately. If the generator makes an a1 with a delivery proof,
 * that case is winnable *because* the proof exists. This matters: a label chosen
 * independently of the data would let the corpus disagree with itself, and the
 * eval would then be measuring the generator's mood.
 */

export interface ScenarioFacts {
  scenarioClass: ScenarioClass;
  rail: Rail;
  groundTruth: GroundTruth;
  groundTruthRationale: string;
  delivered: boolean;
  hasDeliveryProof: boolean;
  refundIssued: boolean;
  genuineDuplicate: boolean;
  mandateValidAtPayment: boolean;
  withinMandateLimit: boolean;
  customerConfirmedInTrace: boolean;
  anomalousAgentBehaviour: boolean;
}

export interface GeneratedTransaction {
  index: number;
  configName: string;
  seed: string;
  scenarioClass: ScenarioClass;
  rail: Rail;
  facts: ScenarioFacts;
  pack: EvidencePackIngestInput;
  /** Domain time the payment was captured; the dispute is dated from it. */
  capturedAt: Date;
  amount: number;
  currency: string;
}

function amountFor(rng: Rng, config: GeneratorConfig, item: GeneratorConfig['items'][number]): number {
  const low = Math.max(item.minAmount, config.orderValue.min);
  const high = Math.min(item.maxAmount, config.orderValue.max);
  const min = Math.min(low, high);
  const max = Math.max(low, high);
  // Round to whole rupees: real order values are not sub-rupee.
  return Math.round(rng.int(min, max) / 100) * 100;
}

interface TraceTurnSpec {
  role: 'customer' | 'agent' | 'system';
  content: string;
}

/**
 * Template conversation for the dev corpus. The held-out corpus replaces this
 * wording entirely via a different model (P1.3) -- these templates are exactly
 * the distribution the holdout is meant to be out of.
 */
function buildTraceTurns(
  scenarioClass: ScenarioClass,
  itemName: string,
  amountRupees: string,
  confirmed: boolean,
  anomalous: boolean,
): TraceTurnSpec[] {
  const turns: TraceTurnSpec[] = [
    { role: 'customer', content: `I need to reorder ${itemName.toLowerCase()} this week.` },
    { role: 'agent', content: `I found ${itemName} at Rs ${amountRupees}. Shall I place the order?` },
  ];

  if (anomalous) {
    turns.push(
      { role: 'system', content: 'Session origin changed mid-conversation; device fingerprint does not match the enrolled device.' },
      { role: 'customer', content: 'yes place it now and also order three more, quickly' },
      { role: 'agent', content: `Placing the order for ${itemName} at Rs ${amountRupees}.` },
    );
    return turns;
  }

  if (confirmed) {
    turns.push(
      { role: 'customer', content: `Yes, go ahead and order ${itemName} for Rs ${amountRupees}.` },
      { role: 'agent', content: `Confirmed. Paying Rs ${amountRupees} using your saved mandate.` },
      { role: 'system', content: 'Customer confirmation recorded against the mandate.' },
    );
  } else {
    // No explicit confirmation: the agent proceeded on an implied instruction.
    turns.push(
      { role: 'customer', content: 'Whatever you think is best, just sort it out.' },
      { role: 'agent', content: `Proceeding with ${itemName} at Rs ${amountRupees}.` },
    );
  }

  if (scenarioClass === 'b4') {
    turns.push({
      role: 'agent',
      content: confirmed
        ? 'Ordered exactly the variant you confirmed.'
        : 'The requested variant was unavailable, so I selected the closest alternative.',
    });
  }

  return turns;
}

export function generateTransaction(
  config: GeneratorConfig,
  scenarioClass: ScenarioClass,
  index: number,
): GeneratedTransaction {
  const scenario = SCENARIOS[scenarioClass];
  const rail = scenario.rail;
  const label = `${config.name}:${scenarioClass}:${index}`;
  const rng = createRng(`${config.seed}::${label}`);

  const merchant = rng.pick(config.merchants);
  const customerName = rng.pick(config.customerNames);
  // Sell what the merchant actually sells. Falling back to the full catalogue
  // keeps a config with an unmatched category working rather than throwing.
  const matching = config.items.filter((entry) => entry.category === merchant.category);
  const item = rng.pick(matching.length > 0 ? matching : config.items);
  const platform = rng.pick(config.agentPlatforms);

  // --- timeline, all offsets from the fixed corpus epoch ---------------------
  const baseMinutes = index * 137 + rng.int(0, 600);
  const consentAt = atOffset(baseMinutes);
  const placedAt = shift(consentAt, rng.int(60, 20 * MINUTES_PER_DAY));
  const capturedAt = shift(placedAt, rng.int(1, 6));

  const amount = amountFor(rng, config, item);
  const quantity = rng.int(1, 2);
  const amountRupees = (amount / 100).toLocaleString('en-IN');

  // --- scenario-determined facts --------------------------------------------
  let delivered = false;
  let hasDeliveryProof = false;
  let refundIssued = false;
  let genuineDuplicate = false;
  let mandateValidAtPayment = true;
  let withinMandateLimit = true;
  let customerConfirmedInTrace = true;
  let anomalousAgentBehaviour = false;

  switch (scenarioClass) {
    case 'a1': {
      // Three genuinely different evidentiary positions, not one happy path.
      const roll = rng.next();
      if (roll < 0.5) {
        delivered = true;
        hasDeliveryProof = true;
      } else if (roll < 0.8) {
        delivered = true;
        hasDeliveryProof = false;
      }
      break;
    }
    case 'a2':
      delivered = true;
      hasDeliveryProof = rng.bool(0.35);
      break;
    case 'a3':
      delivered = true;
      hasDeliveryProof = rng.bool(0.7);
      genuineDuplicate = rng.bool(0.55);
      break;
    case 'a4':
      delivered = true;
      hasDeliveryProof = rng.bool(0.6);
      refundIssued = rng.bool(0.45);
      break;
    case 'b1':
      delivered = true;
      hasDeliveryProof = rng.bool(0.8);
      customerConfirmedInTrace = rng.bool(0.8);
      break;
    case 'b2':
      delivered = true;
      hasDeliveryProof = rng.bool(0.7);
      withinMandateLimit = false;
      break;
    case 'b3':
      delivered = true;
      hasDeliveryProof = rng.bool(0.7);
      mandateValidAtPayment = false;
      break;
    case 'b4':
      delivered = true;
      hasDeliveryProof = rng.bool(0.75);
      customerConfirmedInTrace = rng.bool(0.5);
      break;
    case 'b5':
      delivered = true;
      hasDeliveryProof = rng.bool(0.5);
      anomalousAgentBehaviour = true;
      customerConfirmedInTrace = false;
      break;
  }

  // --- mandate window and cap, arranged to match the facts above ------------
  const validFrom = shift(consentAt, 0);
  const validUntil = mandateValidAtPayment
    ? shift(capturedAt, rng.int(5, 60) * MINUTES_PER_DAY)
    : // Expired: the window closed before the payment was captured.
      shift(capturedAt, -rng.int(1, 21) * MINUTES_PER_DAY);

  const maxAmount = withinMandateLimit
    ? amount + rng.int(50000, 400000)
    : // Breach: the cap sits below the charged amount.
      Math.max(10000, amount - rng.int(20000, Math.max(30000, Math.floor(amount * 0.4))));

  const mandateStatus = !mandateValidAtPayment ? 'expired' : !withinMandateLimit ? 'exhausted' : 'active';

  // --- ground truth, derived from the evidence just generated ---------------
  let groundTruth: GroundTruth;
  let groundTruthRationale: string;

  switch (scenarioClass) {
    case 'a1':
      if (delivered && hasDeliveryProof) {
        groundTruth = 'winnable';
        groundTruthRationale = 'Delivered with a delivery-confirmation reference on the fulfilment record.';
      } else if (delivered) {
        groundTruth = 'ambiguous';
        groundTruthRationale = 'Marked shipped, but no delivery confirmation exists to evidence receipt.';
      } else {
        groundTruth = 'unwinnable';
        groundTruthRationale = 'Never shipped: the customer is right and there is nothing to contest.';
      }
      break;
    case 'a2':
      if (hasDeliveryProof) {
        groundTruth = 'ambiguous';
        groundTruthRationale =
          'Delivery is evidenced, but an ordinary checkout leaves no authorisation log tying the customer to the purchase.';
      } else {
        groundTruth = 'unwinnable';
        groundTruthRationale =
          'No authorisation evidence and no delivery proof; a human checkout leaves nothing to establish consent.';
      }
      break;
    case 'a3':
      if (genuineDuplicate) {
        groundTruth = 'unwinnable';
        groundTruthRationale = 'Two captured payments against a single order: a real duplicate charge.';
      } else {
        groundTruth = 'winnable';
        groundTruthRationale = 'Two separate orders with distinct order records; not a duplicate.';
      }
      break;
    case 'a4':
      if (refundIssued) {
        groundTruth = 'winnable';
        groundTruthRationale = 'The refund was issued and is evidenced on the order record.';
      } else {
        groundTruth = 'unwinnable';
        groundTruthRationale = 'The refund was owed and never processed; contesting would be a bluff.';
      }
      break;
    case 'b1':
      if (customerConfirmedInTrace) {
        groundTruth = 'winnable';
        groundTruthRationale =
          'Mandate valid and in-window, amount within the cap, and the trace carries an explicit customer confirmation with an orchestration log of the payment call.';
      } else {
        groundTruth = 'ambiguous';
        groundTruthRationale =
          'Mandate valid and in-limit, but the trace shows only an implied instruction, never an explicit confirmation of this purchase.';
      }
      break;
    case 'b2':
      groundTruth = 'unwinnable';
      groundTruthRationale = `Charged ${amount} against a mandate cap of ${maxAmount}: authorisation did not cover the amount.`;
      break;
    case 'b3':
      groundTruth = 'unwinnable';
      groundTruthRationale =
        'Payment captured after the mandate validity window closed; no valid consent covered the charge.';
      break;
    case 'b4':
      if (customerConfirmedInTrace) {
        groundTruth = 'winnable';
        groundTruthRationale = 'The trace shows the customer confirming the specific item that was delivered.';
      } else {
        groundTruth = 'unwinnable';
        groundTruthRationale =
          'The agent substituted a different item without confirmation; the captured trace evidences that against us.';
      }
      break;
    case 'b5':
      groundTruth = 'unwinnable';
      groundTruthRationale =
        'Orchestration log shows a mid-session origin change and anomalous ordering behaviour consistent with a compromised agent. Defense-only: this is not ours to contest.';
      break;
  }

  // --- assemble the capture envelope ----------------------------------------
  const isAgentic = rail === 'agentic';
  const agentId = `${platform.agentPrefix}_${String(index).padStart(4, '0')}`;
  const payerVpa = `${customerName.split(' ')[0]?.toLowerCase() ?? 'user'}${index}@okpraman`;

  const shippedAt = delivered ? shift(capturedAt, rng.int(60, 2 * MINUTES_PER_DAY)) : null;
  const deliveredAt = delivered ? shift(shippedAt ?? capturedAt, rng.int(60, 3 * MINUTES_PER_DAY)) : null;

  const traceTurns = isAgentic
    ? buildTraceTurns(scenarioClass, item.name, amountRupees, customerConfirmedInTrace, anomalousAgentBehaviour)
    : [];

  const traceStartedAt = shift(placedAt, -rng.int(5, 45));

  const orchestrationActions: { action: string; actor: string; detail: Record<string, unknown> }[] = isAgentic
    ? [
        { action: 'intent_received', actor: agentId, detail: { channel: platform.platform } },
        { action: 'catalogue_searched', actor: agentId, detail: { query: item.name, results: rng.int(2, 9) } },
        { action: 'item_selected', actor: agentId, detail: { sku: item.sku, quantity, amount } },
        {
          action: 'mandate_checked',
          actor: 'mandate_service',
          detail: {
            maxAmount,
            requestedAmount: amount,
            withinLimit: withinMandateLimit,
            validUntil: validUntil.toISOString(),
            withinWindow: mandateValidAtPayment,
          },
        },
        {
          action: 'payment_initiated',
          actor: agentId,
          detail: { protocol: platform.protocol, protocolVersion: platform.version, amount },
        },
        {
          action: 'payment_captured',
          actor: 'psp',
          detail: { amount, method: 'upi', status: 'captured' },
        },
      ]
    : [];

  if (anomalousAgentBehaviour) {
    orchestrationActions.splice(1, 0, {
      action: 'session_anomaly_detected',
      actor: 'risk_service',
      detail: {
        signal: 'session_origin_changed',
        enrolledDevice: false,
        velocity: 'elevated',
      },
    });
  }

  const pack: EvidencePackIngestInput = {
    externalId: `evp_${config.name}_${scenarioClass}_${index}`,
    rail,
    capturedAt: capturedAt.toISOString(),
    occurredAt: capturedAt.toISOString(),

    merchant: {
      externalId: `mrc_${config.name}_${merchant.name.replace(/\W+/g, '_').toLowerCase()}`,
      name: merchant.name,
      category: merchant.category,
      occurredAt: atOffset(0).toISOString(),
    },
    customer: {
      externalId: `cst_${config.name}_${index}`,
      name: customerName,
      email: `${customerName.split(' ')[0]?.toLowerCase() ?? 'user'}.${index}@${config.emailDomain}`,
      contact: `+919${String(100000000 + hashSeed(label) % 899999999).slice(0, 9)}`,
      occurredAt: shift(consentAt, -MINUTES_PER_DAY).toISOString(),
    },
    order: {
      externalId: `ord_${config.name}_${scenarioClass}_${index}`,
      amount,
      currency: 'INR',
      status: refundIssued ? 'refunded' : 'confirmed',
      items: [{ sku: item.sku, name: item.name, quantity, amount }],
      placedAt: placedAt.toISOString(),
      occurredAt: placedAt.toISOString(),
    },
    payment: {
      externalId: `pmt_${config.name}_${scenarioClass}_${index}`,
      razorpayPaymentId: razorpayShapedId('pay_', `${config.seed}:pay:${label}`),
      amount,
      currency: 'INR',
      method: isAgentic ? 'upi' : rng.pick(['upi', 'card', 'netbanking']),
      status: 'captured',
      vpa: isAgentic ? payerVpa : null,
      capturedAt: capturedAt.toISOString(),
      occurredAt: capturedAt.toISOString(),
    },
    fulfillment: {
      externalId: `ful_${config.name}_${scenarioClass}_${index}`,
      status: delivered ? 'delivered' : 'pending',
      carrier: delivered ? rng.pick(['Bluedart', 'Delhivery', 'Ekart']) : null,
      trackingId: delivered ? razorpayShapedId('trk_', `${config.seed}:trk:${label}`) : null,
      shippedAt: shippedAt ? shippedAt.toISOString() : null,
      deliveredAt: deliveredAt ? deliveredAt.toISOString() : null,
      proofRef: hasDeliveryProof ? razorpayShapedId('pod_', `${config.seed}:pod:${label}`) : null,
      occurredAt: (deliveredAt ?? shippedAt ?? capturedAt).toISOString(),
    },

    mandate: isAgentic
      ? {
          externalId: `mdt_${config.name}_${scenarioClass}_${index}`,
          agentId,
          agentPlatform: platform.platform,
          payerVpa,
          consentAt: consentAt.toISOString(),
          validFrom: validFrom.toISOString(),
          validUntil: validUntil.toISOString(),
          maxAmount,
          currency: 'INR',
          status: mandateStatus,
          occurredAt: consentAt.toISOString(),
        }
      : null,

    agentic: isAgentic
      ? {
          agentId,
          agentPlatform: platform.platform,
          protocol: platform.protocol,
          protocolVersion: platform.version,
          protocolMetadata: {
            mandateRef: `mdt_${config.name}_${scenarioClass}_${index}`,
            payerVpa,
            consentChannel: platform.platform,
            agentSessionId: razorpayShapedId('ses_', `${config.seed}:ses:${label}`),
          },
        }
      : null,

    conversationTrace: isAgentic
      ? {
          externalId: `trc_${config.name}_${scenarioClass}_${index}`,
          startedAt: traceStartedAt.toISOString(),
          occurredAt: traceStartedAt.toISOString(),
          turns: traceTurns.map((turn, seq) => ({
            externalId: `trn_${config.name}_${scenarioClass}_${index}_${seq}`,
            seq,
            role: turn.role,
            content: turn.content,
            occurredAt: shift(traceStartedAt, seq * 2).toISOString(),
          })),
        }
      : null,

    orchestrationLogs: orchestrationActions.map((entry, seq) => ({
      externalId: `log_${config.name}_${scenarioClass}_${index}_${seq}`,
      seq,
      action: entry.action,
      actor: entry.actor,
      detail: entry.detail,
      occurredAt: shift(traceStartedAt, seq * 3).toISOString(),
    })),
  };

  return {
    index,
    configName: config.name,
    seed: config.seed,
    scenarioClass,
    rail,
    capturedAt,
    amount,
    currency: 'INR',
    facts: {
      scenarioClass,
      rail,
      groundTruth,
      groundTruthRationale,
      delivered,
      hasDeliveryProof,
      refundIssued,
      genuineDuplicate,
      mandateValidAtPayment,
      withinMandateLimit,
      customerConfirmedInTrace,
      anomalousAgentBehaviour,
    },
    pack,
  };
}
