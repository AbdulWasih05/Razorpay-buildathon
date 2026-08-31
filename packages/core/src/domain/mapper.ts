import { contestRequestSchema, type ContestEvidenceField, type ContestRequestInput } from '../schema/contest.js';
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
  /** Subunits. The amount contested. Razorpay caps this at `disputedAmount`. */
  amount: number;
  /**
   * Subunits. What the customer disputed.
   *
   * Carried separately from `amount` even though today they are always equal,
   * because the adapter's ceiling check compares the two -- and a check that
   * compares a value to itself is worse than no check, since it reads as a
   * guard and enforces nothing. Partial contests become expressible here.
   */
  disputedAmount: number;
  /** The drafted explanation. Goes in `summary`; already length-validated. */
  summary: string;
  action: 'draft';
  assignments: EvidenceFieldAssignment[];
  /** Every capture-store id this draft rests on, deduplicated. */
  references: string[];
}

/**
 * Exchange capture-store references for real Razorpay document ids and produce
 * the contest request body.
 *
 * The `documents` map comes from whoever uploaded the evidence -- the
 * Documents API in production, the simulator in eval. This function NEVER mints
 * an id: a missing mapping throws. Inventing a plausible `doc_` id to make the
 * type check would be exactly the fabrication CLAUDE.md hard rule #1 forbids,
 * and it would fail at Razorpay rather than here, where it is diagnosable.
 *
 * `action` is hardcoded to `draft`. Submission is a separate, human-approved
 * step: this function cannot produce a submit payload at all (hard rule #2).
 */
export function materialiseContest(
  draft: ContestDraft,
  documents: ReadonlyMap<string, string>,
): ContestRequestInput {
  const request: Record<string, unknown> = {
    amount: draft.amount,
    summary: draft.summary,
    action: 'draft',
  };
  const others: { type: string; document_ids: string[] }[] = [];

  for (const assignment of draft.assignments) {
    const documentIds = assignment.references.map((reference) => {
      const documentId = documents.get(reference);
      if (!documentId) {
        throw new Error(
          `no uploaded document for capture reference "${reference}" (${assignment.artifacts.join(', ')}); ` +
            'upload the evidence before materialising the contest -- ids are never invented here',
        );
      }
      return documentId;
    });
    if (documentIds.length === 0) continue;

    if (assignment.field === 'others') {
      others.push({
        type: assignment.othersType ?? 'other_evidence',
        document_ids: documentIds,
      });
      continue;
    }
    const existing = (request[assignment.field] as string[] | undefined) ?? [];
    request[assignment.field] = [...existing, ...documentIds];
  }

  if (others.length > 0) request['others'] = others;
  // Validate against the contract types before this leaves the domain.
  return contestRequestSchema.parse(request) as ContestRequestInput;
}

export function buildContestDraft(
  collected: CollectedEvidence,
  summary: string,
  disputedAmount: number,
  /** Defaults to contesting the full disputed amount. */
  contestAmount: number = disputedAmount,
): ContestDraft {
  const assignments = mapEvidenceToContestFields(collected);
  return {
    disputeId: collected.disputeId,
    amount: contestAmount,
    disputedAmount,
    summary,
    action: 'draft',
    assignments,
    references: [...new Set(assignments.flatMap((assignment) => assignment.references))].sort(),
  };
}
