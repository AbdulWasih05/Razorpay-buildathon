import { z } from 'zod';

import { EVIDENCE_SUMMARY_MAX_CHARS, disputeEntitySchema, evidenceOtherSchema } from './dispute.js';
import { amountInSubunits, documentId } from './ids.js';

/**
 * The WRITE side of the Disputes API: the contest payload we produce.
 *
 * Source of truth: https://razorpay.com/docs/api/disputes/contest/
 *   PATCH /v1/disputes/:id/contest
 * Verbatim request example: ../fixtures/dispute-contest-draft-request.json
 *
 * This is deliberately a separate schema from `disputeEvidenceSchema` in
 * dispute.ts, because read and write are not the same contract:
 *
 *   READ  -- every evidence key is present and nullable. We must parse whatever
 *            Razorpay returns, so nothing is optional and nothing is capped.
 *   WRITE -- every field is optional and omitted rather than sent as null, and
 *            `summary` IS capped, because here we are the ones producing the
 *            value. See DECISIONS.md D-003.
 *
 * Using one schema for both would mean either failing to parse a legitimate
 * response or failing to enforce a documented limit on our own output. Neither
 * is acceptable on the money path.
 */

/** Documented values for `action`. `draft` is the documented default. */
export const CONTEST_ACTIONS = ['draft', 'submit'] as const;
export type ContestAction = (typeof CONTEST_ACTIONS)[number];

/**
 * Every typed evidence field that carries a list of document ids. `summary`
 * (a string), `amount` (an integer) and `others` (a labelled list) are handled
 * separately below.
 *
 * Exported because the deterministic evidence mapper (P2.3) and the reason-code
 * rubric (P2.1) both need to enumerate these fields, and neither should keep
 * its own copy of the list that could drift from the schema.
 */
export const CONTEST_EVIDENCE_DOCUMENT_FIELDS = [
  'shipping_proof',
  'billing_proof',
  'cancellation_proof',
  'customer_communication',
  'proof_of_service',
  'explanation_letter',
  'refund_confirmation',
  'access_activity_log',
  'refund_cancellation_policy',
  'term_and_conditions',
] as const;

export type ContestEvidenceDocumentField = (typeof CONTEST_EVIDENCE_DOCUMENT_FIELDS)[number];

const documentIdListFields = Object.fromEntries(
  CONTEST_EVIDENCE_DOCUMENT_FIELDS.map((field) => [field, z.array(documentId).optional()]),
) as Record<ContestEvidenceDocumentField, z.ZodOptional<z.ZodArray<z.ZodString>>>;

/**
 * Anything shaped enough to count document ids in. Deliberately loose: this is
 * called both from inside the schema's own refinement (before a payload is
 * fully typed) and from the drafter and the gate.
 */
export interface ContestEvidenceOther {
  readonly document_ids: readonly string[];
  readonly [key: string]: unknown;
}

export interface ContestEvidenceDocuments {
  others?: readonly ContestEvidenceOther[] | undefined;
  readonly [field: string]: unknown;
}

/**
 * Total document ids across every evidence attribute.
 *
 * The docs say a submission needs "a minimum of one document id (across any of
 * the evidence object attributes)". `others` is an evidence object attribute
 * and its `document_ids` are document ids, so they count. That last step is our
 * reading of the sentence rather than a separate quote from the docs, and it is
 * flagged as such here so a reviewer can disagree with it in one place.
 */
export function countContestDocumentIds(request: ContestEvidenceDocuments): number {
  let count = 0;
  for (const field of CONTEST_EVIDENCE_DOCUMENT_FIELDS) {
    const value = request[field];
    if (Array.isArray(value)) count += value.length;
  }
  for (const other of request.others ?? []) {
    count += other.document_ids.length;
  }
  return count;
}

const contestRequestObject = z
  .object({
    // Optional; documented as defaulting to the full dispute amount. Whether it
    // exceeds the dispute amount cannot be judged from this payload alone --
    // see `contestRequestForDispute` below.
    amount: amountInSubunits.optional(),
    summary: z
      .string()
      .max(
        EVIDENCE_SUMMARY_MAX_CHARS,
        `summary exceeds the documented ${EVIDENCE_SUMMARY_MAX_CHARS}-character limit`,
      )
      .optional(),
    ...documentIdListFields,
    others: z.array(evidenceOtherSchema).optional(),
    action: z.enum(CONTEST_ACTIONS).default('draft'),
  })
  // We produce this payload, so an unknown key is our bug, not Razorpay's drift.
  .strict();

/**
 * The contest request as we send it.
 *
 * Enforces the one documented cross-field rule that is checkable from the
 * payload alone: `action: "submit"` requires at least one document id.
 */
export const contestRequestSchema = contestRequestObject.superRefine((request, ctx) => {
  if (request.action !== 'submit') return;
  if (countContestDocumentIds(request) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message:
        'submit requires a minimum of one document id across the evidence attributes; use action "draft" until evidence is attached',
    });
  }
});

/**
 * The same request, additionally checked against the dispute it contests.
 *
 * Split out because `amount` cannot exceed the dispute amount, and that fact
 * lives on the dispute, not in the payload. Kept as a second schema rather than
 * folded in, so that parsing a payload in isolation is still possible and the
 * two rules stay separately explainable.
 */
export function contestRequestForDispute(dispute: { readonly amount: number }) {
  return contestRequestSchema.superRefine((request, ctx) => {
    if (request.amount !== undefined && request.amount > dispute.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: `contest amount ${request.amount} exceeds the disputed amount ${dispute.amount}`,
      });
    }
  });
}

/**
 * A successful contest returns the full dispute entity with `evidence`
 * populated -- the same shape the read path already models, so it is aliased
 * rather than duplicated. The alias exists so call sites read honestly.
 */
export const contestResponseSchema = disputeEntitySchema;

export type ContestRequest = z.infer<typeof contestRequestSchema>;
export type ContestRequestInput = z.input<typeof contestRequestSchema>;
export type ContestResponse = z.infer<typeof contestResponseSchema>;
