import type { Network } from './reason-codes.js';
import type { Rail } from '../capture/ingest.js';

/**
 * The dispute scenario classes the corpus is generated from.
 *
 * Rail A -- ordinary e-commerce. The today-problem wedge: these disputes exist
 * now, in volume, and a merchant bleeds on them today.
 *
 * Rail B -- agent-initiated under a UPI Reserve Pay mandate. The differentiated
 * module: the dispute class Razorpay's own agentic pilots are creating.
 *
 * The same pipeline handles both. That is the point -- the agentic evidence pack
 * is an additional source of evidence, not a separate product.
 */

export const GROUND_TRUTH_LABELS = ['winnable', 'unwinnable', 'ambiguous'] as const;
export type GroundTruth = (typeof GROUND_TRUTH_LABELS)[number];

export const SCENARIO_CLASSES = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'b5'] as const;
export type ScenarioClass = (typeof SCENARIO_CLASSES)[number];

export interface ScenarioDefinition {
  id: ScenarioClass;
  rail: Rail;
  label: string;
  /** What the customer is actually claiming. */
  claim: string;
  network: Network;
  reasonCode: string;
  /**
   * Whether this class is *inherently* defensible, before looking at the
   * specific transaction. Individual cases still vary -- an a1 with no delivery
   * proof is not winnable -- so the generator decides each case's ground truth
   * from the evidence it actually created. This is the prior, not the answer.
   */
  disposition: 'usually_winnable' | 'usually_unwinnable' | 'mixed';
  /** Why that disposition holds. Written out because the panel will ask. */
  rationale: string;
}

export const SCENARIOS: Record<ScenarioClass, ScenarioDefinition> = {
  // --- Rail A: ordinary e-commerce ------------------------------------------
  a1: {
    id: 'a1',
    rail: 'ordinary',
    label: 'Service or goods not received',
    claim: 'The customer says the order never arrived.',
    network: 'upi',
    reasonCode: '1064',
    disposition: 'mixed',
    rationale:
      'Turns entirely on fulfilment evidence. Delivered with a proof reference is defensible; ' +
      'never shipped is not; shipped without delivery confirmation is genuinely ambiguous.',
  },
  a2: {
    id: 'a2',
    rail: 'ordinary',
    label: 'Unrecognised charge',
    claim: 'The customer does not recognise the transaction.',
    network: 'upi',
    reasonCode: '128',
    disposition: 'mixed',
    rationale:
      'A human checkout leaves thinner evidence than an agentic one. Without authorisation logs ' +
      'this is close to undefendable, which is exactly the contrast the agentic rail draws.',
  },
  a3: {
    id: 'a3',
    rail: 'ordinary',
    label: 'Duplicate charge',
    claim: 'The customer says they were charged twice for one purchase.',
    network: 'upi',
    reasonCode: '1084',
    disposition: 'mixed',
    rationale:
      'A factual question with a factual answer. Two payments against one order is a real ' +
      'duplicate and must not be contested; two distinct orders is defensible with order records.',
  },
  a4: {
    id: 'a4',
    rail: 'ordinary',
    label: 'Credit not processed',
    claim: 'The customer says a promised refund never arrived.',
    network: 'upi',
    reasonCode: '1061',
    disposition: 'mixed',
    rationale:
      'Defensible only where a refund genuinely was issued and can be evidenced. Where the ' +
      'refund was owed and never processed, the honest action is to abstain and pay.',
  },

  // --- Rail B: agent-initiated ----------------------------------------------
  b1: {
    id: 'b1',
    rail: 'agentic',
    label: 'Valid agent purchase the customer does not remember',
    claim: 'The customer says they never authorised this purchase.',
    network: 'upi',
    reasonCode: '128',
    disposition: 'usually_winnable',
    rationale:
      'The flagship case. Razorpay documents the required evidence for UPI 128 as "internal logs ' +
      'to show authorisation was obtained". For an agent purchase those logs exist and are strong: ' +
      'a consent-timestamped mandate, an in-limit amount inside its validity window, a conversation ' +
      'trace showing the customer confirming, and an orchestration log of the payment call. ' +
      'The customer genuinely does not remember; the evidence genuinely shows they consented.',
  },
  b2: {
    id: 'b2',
    rail: 'agentic',
    label: 'Mandate limit breach',
    claim: 'The agent spent more than the customer authorised.',
    network: 'upi',
    reasonCode: '1085',
    disposition: 'usually_unwinnable',
    rationale:
      'Arithmetic decides this, and it decides against the merchant. Amount exceeds the mandate ' +
      'cap, so authorisation did not cover the charge. Contesting is a bluff that loses and costs ' +
      'the dispute fee. This class exists in the corpus to be abstained on.',
  },
  b3: {
    id: 'b3',
    rail: 'agentic',
    label: 'Expired mandate',
    claim: 'The customer says the standing authorisation had lapsed.',
    network: 'upi',
    reasonCode: '128',
    disposition: 'usually_unwinnable',
    rationale:
      'The payment falls outside the mandate validity window, so no valid consent covered it. ' +
      'Same reason code as b1 and the opposite outcome -- which is the case for a deterministic ' +
      'gate that reads the mandate rather than a classifier that reads the reason code.',
  },
  b4: {
    id: 'b4',
    rail: 'agentic',
    label: 'Wrong item selected by agent',
    claim: 'The agent ordered something other than what was asked for.',
    network: 'upi',
    reasonCode: '1062',
    disposition: 'mixed',
    rationale:
      'Depends on what the trace shows. If the customer confirmed the specific item, the trace ' +
      'defends the merchant. If the agent substituted without confirmation, it does not -- and the ' +
      'trace is the evidence against us. Captured evidence cuts both ways, honestly.',
  },
  b5: {
    id: 'b5',
    rail: 'agentic',
    label: 'Compromised agent fraud',
    claim: 'A third party drove the agent to make purchases.',
    network: 'upi',
    reasonCode: '128',
    disposition: 'usually_unwinnable',
    rationale:
      'Genuine fraud. Defense-only means we do not defend it: the trace shows anomalous behaviour ' +
      'and the correct action is to abstain. A system that contested these would be a liability, ' +
      'not a product.',
  },
};

export const RAIL_A_CLASSES: readonly ScenarioClass[] = ['a1', 'a2', 'a3', 'a4'];
export const RAIL_B_CLASSES: readonly ScenarioClass[] = ['b1', 'b2', 'b3', 'b4', 'b5'];

export function scenariosForRail(rail: Rail): ScenarioDefinition[] {
  return SCENARIO_CLASSES.map((id) => SCENARIOS[id]).filter((s) => s.rail === rail);
}
