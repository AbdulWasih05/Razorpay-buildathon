import type { Network } from '../domain/reason-codes.js';
import type { EvidenceArtifact } from '../domain/rubric.js';

/**
 * What the domain needs to know about a dispute provider, and nothing more.
 *
 * The split this file draws: the **domain** decides what evidence exists and
 * whether it is enough; a **provider** decides what that evidence is called on
 * the wire and how a contest payload is shaped. Before this, the second half
 * lived inside the rubric, so `packages/core`'s domain named Razorpay's fields
 * directly and a second provider had nowhere to go.
 *
 * Nothing here is a plugin system. It is two small interfaces and a union,
 * sized for the one thing that actually varies.
 */

export const PROVIDERS = ['razorpay', 'stripe'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Where one artifact lands in a provider's typed evidence fields. */
export interface FieldPlacement {
  /** The provider's own field name. */
  field: string;
  /**
   * A label the provider requires alongside the field, when it has a catch-all
   * bucket. Razorpay's `others` entries each carry a `type`.
   */
  othersType?: string;
}

/**
 * A provider's artifact-to-field table.
 *
 * Total over the artifacts the domain knows about: a provider that has nowhere
 * to put an artifact says so explicitly, rather than the mapper discovering a
 * hole at run time.
 */
export type ProviderFieldMap = Readonly<Record<EvidenceArtifact, FieldPlacement>>;

/**
 * A dispute from any provider, in the shape the pipeline works on.
 *
 * Produced by a provider's normaliser from that provider's own event, so the
 * collector, the gate and the review routes never read a provider's wire
 * format. Amounts stay in minor units, because that is what every provider
 * sends and converting early is how F-029 happened.
 */
export interface NormalizedDispute {
  provider: ProviderId;
  providerDisputeId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  /**
   * The card network or rail the reason code belongs to, when the provider
   * says. Razorpay does; a provider that does not leaves it null and its
   * rubric is keyed on the reason code alone.
   */
  network: Network | null;
  status: string;
  /** Razorpay's escalation phase. Null for providers without the concept. */
  phase: string | null;
  respondBy: Date;
  raisedAt: Date;
}
