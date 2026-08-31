import { z } from 'zod';
import { EVIDENCE_SUMMARY_MAX_CHARS } from '@praman/core';

/**
 * Structured-output contracts for every model call.
 *
 * These are the fourth failure path in CLAUDE.md hard rule #4: output that does
 * not satisfy the schema is a failure, not something to be coerced, repaired or
 * retried into the money path. `letterDraftSchema` in particular enforces the
 * documented 1000-character ceiling on the produced letter -- an over-length
 * draft is a schema-validation failure and the dispute abstains. It is never
 * truncated. See DECISIONS.md D-003.
 */

export const CONFIRMATION_SIGNALS = ['explicit', 'implied', 'absent', 'contradicted'] as const;
export type ConfirmationSignal = (typeof CONFIRMATION_SIGNALS)[number];

export const traceSummarySchema = z
  .object({
    summary: z.string().min(20).max(1200),
    confirmation: z.enum(CONFIRMATION_SIGNALS),
    ambiguityFlags: z.array(z.string().max(120)).max(5),
  })
  .strict();

export const letterDraftSchema = z
  .object({
    letter: z
      .string()
      .min(40)
      .max(
        EVIDENCE_SUMMARY_MAX_CHARS,
        `draft exceeds the documented ${EVIDENCE_SUMMARY_MAX_CHARS}-character limit`,
      ),
  })
  .strict();

/**
 * The shape a model returns when it declines. Declining is a legitimate
 * outcome -- it routes to a human -- so it is modelled rather than treated as
 * malformed output.
 */
export const refusalSchema = z
  .object({
    refused: z.literal(true),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * "The evidence does not support a contest."
 *
 * Deliberately NOT the refusal contract. A model declining to draft because the
 * evidence is thin is doing its job -- it is abstention on the merits, and the
 * project's own rule is abstention over bluffing. Routing it to "assembly
 * failure, manual review required" would file a correct judgement under a
 * broken-plumbing label and corrupt the abstention-reason breakdown that P4.1
 * reports. See FAILURES.md F-011.
 */
export const insufficientEvidenceSchema = z
  .object({
    insufficientEvidence: z.literal(true),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type InsufficientEvidence = z.infer<typeof insufficientEvidenceSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type LetterDraft = z.infer<typeof letterDraftSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
