import type { CollectedEvidence } from './collector.js';
import { formatRupees } from './money.js';
import type { EvidenceArtifact } from './rubric.js';
import { formatInstant } from './when.js';

/**
 * The sufficiency gate (TASKS.md P3.1).
 *
 * Decides `contest` or `abstain(reason)` from the collector's report. It is
 * pure, deterministic, threshold-driven, and it runs BEFORE any model call.
 *
 * That ordering is the point, and it is a correction to how P2.3 shipped. In
 * the checkpoint build the letter drafter could return "the evidence does not
 * support a contest", which meant a model was effectively making the
 * contest/abstain call. CLAUDE.md hard rule #4 forbids exactly that: an LLM is
 * never used for "submission decisions, anything on the money path". Now the
 * gate decides, and the model is asked to write only for disputes the gate has
 * already cleared. See DECISIONS.md D-025.
 *
 * The model's own judgement is not discarded -- it becomes a second opinion. If
 * the gate says contest and the drafter says the evidence is insufficient, the
 * disagreement is surfaced and the dispute abstains conservatively. Two
 * independent readings that disagree is exactly when a human should look.
 */

export type GateDecision = 'contest' | 'abstain';

export interface GateRule {
  id: string;
  /** True when the rule is satisfied, i.e. it does NOT block a contest. */
  passed: boolean;
  /** Human-readable, always present -- an abstention with no reason is a bug. */
  detail: string;
}

export interface GateResult {
  disputeId: string;
  decision: GateDecision;
  /** Set whenever `decision` is `abstain`. Never empty. */
  reason?: string;
  /** Every rule evaluated, in order, whether it passed or not. */
  rules: GateRule[];
  requiredCoverage: number;
  missingRequired: EvidenceArtifact[];
  thresholds: GateThresholds;
}

export interface GateThresholds {
  /**
   * Fraction of REQUIRED rubric artifacts that must be present to contest.
   *
   * Defaults to 1.0: every artifact Razorpay's published guidance asks for.
   * Deliberately strict, because the cost of being wrong is asymmetric -- a
   * bluffed contest that loses costs the dispute fee plus handling time, and
   * that is the false-positive cost P4.1 reports in rupees. Exposed as a
   * threshold rather than hardcoded so the eval can show the sensitivity
   * instead of asserting the choice.
   */
  requiredCoverageRatio: number;
  /**
   * Whether a deterministic anomaly signal on the transaction blocks a contest.
   *
   * On by default. b5 is compromised-agent fraud, and defending genuine fraud
   * is the thing "defense-only" means we do not do.
   */
  anomalySignalsBlock: boolean;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  requiredCoverageRatio: 1.0,
  anomalySignalsBlock: true,
};

/**
 * Evaluate a dispute.
 *
 * Rules run in a fixed order and ALL of them are evaluated, even after one has
 * already blocked. A reviewer reading the audit trail should see every reason
 * the system had, not just the first one it hit.
 */
export function evaluateGate(
  collected: CollectedEvidence,
  thresholds: GateThresholds = DEFAULT_THRESHOLDS,
): GateResult {
  const rules: GateRule[] = [];
  const mandate = collected.mandate;

  // --- Mandate arithmetic. Agentic rail only, and it is decisive. -----------
  if (collected.rail === 'agentic') {
    rules.push({
      id: 'mandate_present',
      passed: mandate.present,
      detail: mandate.present
        ? 'a mandate record was captured for this transaction'
        : 'agentic transaction with no mandate record: no consent evidence exists',
    });

    if (mandate.present) {
      // Rupees, not the subunits the payload carries. A reviewer is invited to
      // re-derive these lines against the mandate panel directly above them, and
      // that panel is in rupees -- one fact written two ways on one screen is
      // the defect F-029 logs. `maxAmount` is always set when the mandate is
      // present (the collector sets both together); the fallback exists so the
      // string stays honest rather than printing a confident ₹0 if that ever
      // stops being true.
      const charged = formatRupees(mandate.chargedAmount);
      const cap = mandate.maxAmount === undefined ? 'uncaptured' : formatRupees(mandate.maxAmount);

      rules.push({
        id: 'within_mandate_limit',
        passed: mandate.withinLimit === true,
        detail:
          mandate.withinLimit === true
            ? `charged ${charged} against a ${cap} cap`
            : `charged ${charged}, which exceeds the ${cap} mandate cap: authorisation did not cover this charge`,
      });

      rules.push({
        id: 'within_validity_window',
        passed: mandate.withinValidityWindow === true,
        detail:
          mandate.withinValidityWindow === true
            ? `payment at ${formatInstant(mandate.paymentAt)} falls inside ${formatInstant(mandate.validFrom)} to ${formatInstant(mandate.validUntil)}`
            : `payment at ${formatInstant(mandate.paymentAt)} falls outside the mandate window ${formatInstant(mandate.validFrom)} to ${formatInstant(mandate.validUntil)}: no valid consent covered it`,
      });

      rules.push({
        id: 'consent_before_payment',
        passed: mandate.consentBeforePayment === true,
        detail:
          mandate.consentBeforePayment === true
            ? 'mandate consent was recorded before the payment'
            : 'the payment precedes the recorded consent',
      });

      rules.push({
        id: 'mandate_status_usable',
        passed: mandate.status === 'active' || mandate.status === 'exhausted',
        detail: `mandate status at capture: ${mandate.status ?? 'unknown'}`,
      });
    }
  }

  // --- Anomaly signals. Defense-only means we do not defend fraud. ----------
  const hasAnomaly = collected.anomalySignals.length > 0;
  rules.push({
    id: 'no_anomaly_signals',
    passed: !(thresholds.anomalySignalsBlock && hasAnomaly),
    detail: hasAnomaly
      ? `anomaly signals recorded on this transaction: ${collected.anomalySignals.join(', ')}`
      : 'no anomaly signals recorded on this transaction',
  });

  // --- Evidence coverage against the published rubric. ----------------------
  const coverage = collected.coverage.ratio;
  const meetsCoverage = coverage >= thresholds.requiredCoverageRatio;
  rules.push({
    id: 'required_evidence_coverage',
    passed: meetsCoverage,
    detail: meetsCoverage
      ? `holds ${collected.coverage.present} of ${collected.coverage.required} required artifacts`
      : `holds ${collected.coverage.present} of ${collected.coverage.required} required artifacts; missing ${collected.missingRequired.join(', ') || 'none'}`,
  });

  // Called out separately from plain absence: a requirement we can never meet
  // is a statement about our capture layer, not about this dispute.
  if (collected.structurallyUnavailable.length > 0) {
    rules.push({
      id: 'no_structurally_unavailable_requirements',
      passed: false,
      detail: `required evidence Praman cannot produce for any dispute: ${collected.structurallyUnavailable.join(', ')}`,
    });
  }

  const blocking = rules.filter((rule) => !rule.passed);
  const decision: GateDecision = blocking.length === 0 ? 'contest' : 'abstain';

  return {
    disputeId: collected.disputeId,
    decision,
    ...(decision === 'abstain'
      ? { reason: blocking.map((rule) => rule.detail).join('; ') }
      : {}),
    rules,
    requiredCoverage: coverage,
    missingRequired: collected.missingRequired,
    thresholds,
  };
}

/** The rules that blocked a contest. Empty when the gate said contest. */
export function blockingRules(result: GateResult): GateRule[] {
  return result.rules.filter((rule) => !rule.passed);
}
