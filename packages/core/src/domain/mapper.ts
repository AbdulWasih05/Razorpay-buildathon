import type { ContestEvidenceField } from '../schema/contest.js';
import type { CollectedEvidence } from './collector.js';
import { ARTIFACTS, type EvidenceArtifact } from './rubric.js';

/**
 * Deterministic evidence -> Razorpay field mapping (TASKS.md P2.3).
 *
 * This is code, not a model call, and that is the point. The mapping from an
 * artifact to a typed evidence field is fully specified by Razorpay's docs: it
 * has one correct answer, so a model could only introduce variance into it.
 * The rubric already records which field each artifact belongs in; this walks
 * the collector's findings and groups them.
 *
 * It runs AFTER the LLM step and takes no model output except the letter text,
 * which lands in `summary`. Nothing a model produced decides where anything
 * goes.
 */

export interface EvidenceFieldAssignment {
  field: ContestEvidenceField;
  /** Razorpay requires a `type` label on every `others` entry. */
  othersType?: string;
  artifacts: EvidenceArtifact[];
  /** Capture-store ids backing this field, for the audit trail. */
  references: string[];
}

/**
 * Group every artifact the collector actually holds into the contest field it
 * belongs in. Artifacts that are absent or unobtainable are not mapped -- an
 * empty field is honest, a field claiming evidence we do not have is not.
 */
export function mapEvidenceToContestFields(
  collected: CollectedEvidence,
): EvidenceFieldAssignment[] {
  const byField = new Map<string, EvidenceFieldAssignment>();

  for (const finding of collected.findings) {
    if (finding.state !== 'present') continue;
    const definition = ARTIFACTS[finding.artifact];
    // `others` entries are separated by their type label: Razorpay treats each
    // as its own labelled item, not one bucket.
    const key =
      definition.contestField === 'others'
        ? `others:${definition.othersType}`
        : definition.contestField;

    const existing = byField.get(key);
    if (existing) {
      existing.artifacts.push(finding.artifact);
      existing.references.push(...finding.references);
      continue;
    }
    byField.set(key, {
      field: definition.contestField,
      ...(definition.othersType ? { othersType: definition.othersType } : {}),
      artifacts: [finding.artifact],
      references: [...finding.references],
    });
  }

  // Stable order, so a draft is byte-identical across runs.
  return [...byField.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, assignment]) => assignment);
}

/**
 * A contest ready for review, short of document ids.
 *
 * It is deliberately NOT a `ContestRequest` yet. Every typed evidence field is
 * a list of `doc_` ids, and those ids exist only once evidence is uploaded
 * through the Documents API -- which is P3.4. Minting plausible-looking ids
 * here to make the type check would be inventing data, so the draft carries
 * capture-store references and the adapter exchanges them for real ids later.
 */
export interface ContestDraft {
  disputeId: string;
  /** Subunits. The amount contested, never more than the disputed amount. */
  amount: number;
  /** The drafted explanation. Goes in `summary`; already length-validated. */
  summary: string;
  action: 'draft';
  assignments: EvidenceFieldAssignment[];
  /** Every capture-store id this draft rests on, deduplicated. */
  references: string[];
}

export function buildContestDraft(
  collected: CollectedEvidence,
  summary: string,
  amount: number,
): ContestDraft {
  const assignments = mapEvidenceToContestFields(collected);
  return {
    disputeId: collected.disputeId,
    amount,
    summary,
    action: 'draft',
    assignments,
    references: [...new Set(assignments.flatMap((assignment) => assignment.references))].sort(),
  };
}
