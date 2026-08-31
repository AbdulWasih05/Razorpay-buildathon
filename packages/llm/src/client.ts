import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';

import { ReplayMissError, ResponseCache, requestKey } from './cache.js';
import { ProviderError, type ModelProvider, type ModelRequest } from './provider.js';
import {
  insufficientEvidenceSchema,
  letterDraftSchema,
  refusalSchema,
  traceSummarySchema,
} from './schemas.js';
import type { InsufficientEvidence, LetterDraft, TraceSummary } from './schemas.js';

/**
 * The single door to a model, with CLAUDE.md hard rule #4's failure policy
 * wired in.
 *
 * FOUR failure paths, all of which end the same way -- the dispute abstains
 * with "assembly failure, manual review required", audit-logged, never
 * silently retried onto the money path:
 *
 *   error   -- the provider errored, or the request failed outright.
 *   timeout -- the call exceeded its budget.
 *   refusal -- the model declined, either via the provider's own refusal signal
 *              or via our documented `{"refused": true}` contract.
 *   schema  -- the output did not satisfy its structured-output schema. This
 *              covers malformed JSON, missing fields, AND a letter over the
 *              documented 1000 characters. It is not repaired and not trimmed.
 *
 * A replay miss is deliberately NOT one of these. It is an operator error --
 * the fixture is stale or the prompt changed -- and it must fail loudly rather
 * than degrade a whole eval run into abstentions that look like model failures.
 */

export const ASSEMBLY_FAILURE_KINDS = ['error', 'timeout', 'refusal', 'schema'] as const;
export type AssemblyFailureKind = (typeof ASSEMBLY_FAILURE_KINDS)[number];

/** The one abstention reason every assembly failure produces. Verbatim. */
export const ASSEMBLY_ABSTAIN_REASON = 'assembly failure, manual review required';

export class AssemblyFailure extends Error {
  constructor(
    readonly kind: AssemblyFailureKind,
    readonly detail: string,
    readonly promptId: string,
  ) {
    super(`${kind} in ${promptId}: ${detail}`);
    this.name = 'AssemblyFailure';
  }
}

interface LoadedPrompt {
  id: string;
  version: number;
  body: string;
}

function loadPrompt(file: string): LoadedPrompt {
  const raw = readFileSync(fileURLToPath(new URL(`./prompts/${file}`, import.meta.url)), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`prompt ${file} has no frontmatter`);
  const [, frontmatter, body] = match;
  const id = /^id:\s*(.+)$/m.exec(frontmatter ?? '')?.[1]?.trim();
  const version = Number(/^version:\s*(\d+)$/m.exec(frontmatter ?? '')?.[1]);
  if (!id || !Number.isInteger(version)) {
    throw new Error(`prompt ${file} needs an id and an integer version`);
  }
  return { id, version, body: (body ?? '').trim() };
}

export const PROMPTS = {
  traceSummary: loadPrompt('trace-summary.md'),
  letterDraft: loadPrompt('letter-draft.md'),
};

export type ClientMode = 'replay' | 'live';

export interface AssemblyClientOptions {
  provider: ModelProvider;
  cache?: ResponseCache;
  mode?: ClientMode;
  timeoutMs?: number;
}

export class AssemblyClient {
  private readonly provider: ModelProvider;
  private readonly cache: ResponseCache;
  private readonly mode: ClientMode;
  private readonly timeoutMs: number;

  constructor(options: AssemblyClientOptions) {
    this.provider = options.provider;
    this.cache = options.cache ?? new ResponseCache();
    this.mode = options.mode ?? 'replay';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * (a) conversation trace -> neutral summary, and (c) ambiguity flags.
   *
   * One call, not two. Both outputs come from a single reading of the same
   * text, so a second call to re-read it for flags would double the cost, the
   * latency and the number of replay keys to buy nothing. See DECISIONS.md.
   */
  async summariseTrace(user: string): Promise<TraceSummary> {
    return this.call(PROMPTS.traceSummary, user, traceSummarySchema, 900);
  }

  /**
   * (b) explanation-letter draft, capped at the documented 1000 characters.
   *
   * May return `insufficientEvidence` instead of a letter. That is a judgement
   * on the merits, not a failure -- see FAILURES.md F-011 -- so it is returned
   * as a value rather than thrown as an `AssemblyFailure`.
   */
  async draftLetter(user: string): Promise<LetterDraft | InsufficientEvidence> {
    return this.call(PROMPTS.letterDraft, user, letterDraftSchema, 800, insufficientEvidenceSchema);
  }

  private async call<T, A = never>(
    prompt: LoadedPrompt,
    user: string,
    schema: z.ZodType<T>,
    maxOutputTokens: number,
    /** An additional accepted shape, returned as a value rather than thrown. */
    alternate?: z.ZodType<A>,
  ): Promise<T | A> {
    const request: ModelRequest = {
      promptId: prompt.id,
      promptVersion: prompt.version,
      system: prompt.body,
      user,
      maxOutputTokens,
      // Low, not zero: these are text transforms, and providers do not promise
      // determinism at zero anyway. Reproducibility comes from replay, not from
      // temperature -- the README says so plainly rather than implying that a
      // low temperature makes live output reproducible.
      temperature: 0.2,
    };

    const key = requestKey(this.provider.name, this.provider.model, request);
    const recorded = this.cache.lookup(key);

    let text: string;
    let providerRefused: boolean;

    if (recorded) {
      ({ text, providerRefused } = recorded.response);
    } else if (this.mode === 'replay') {
      throw new ReplayMissError(key, prompt.id);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.provider.complete(request, controller.signal);
        ({ text, providerRefused } = response);
        this.cache.record({
          key,
          provider: this.provider.name,
          model: this.provider.model,
          promptId: prompt.id,
          promptVersion: prompt.version,
          response,
          recordedAt: new Date().toISOString(),
        });
      } catch (error) {
        // PATH 2: timeout. Checked before the general error path, because an
        // abort surfaces as a generic error and would otherwise be miscounted.
        if (controller.signal.aborted) {
          throw new AssemblyFailure('timeout', `exceeded ${this.timeoutMs}ms`, prompt.id);
        }
        // PATH 1: error.
        const detail =
          error instanceof ProviderError ? error.message : (error as Error).message;
        throw new AssemblyFailure('error', detail, prompt.id);
      } finally {
        clearTimeout(timer);
      }
    }

    // PATH 3a: the provider itself signalled a refusal.
    if (providerRefused) {
      throw new AssemblyFailure('refusal', 'provider signalled a refusal', prompt.id);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(text));
    } catch {
      // PATH 4a: not JSON at all. An empty 200 lands here -- see F-002, which
      // is the incident this path was written for.
      throw new AssemblyFailure(
        'schema',
        text.trim() === '' ? 'empty response body' : 'response was not valid JSON',
        prompt.id,
      );
    }

    // PATH 3b: the model used our documented refusal contract.
    const refusal = refusalSchema.safeParse(parsed);
    if (refusal.success) {
      throw new AssemblyFailure('refusal', refusal.data.reason, prompt.id);
    }

    // A documented alternate outcome (today: "insufficient evidence") is a
    // legitimate answer, checked before the failure paths so that a correct
    // judgement is never filed as a malformed response.
    if (alternate) {
      const alternateResult = alternate.safeParse(parsed);
      if (alternateResult.success) return alternateResult.data;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      // PATH 4b: structurally wrong output. An over-length letter arrives here,
      // and it abstains rather than being truncated (D-003).
      throw new AssemblyFailure(
        'schema',
        result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        prompt.id,
      );
    }
    return result.data;
  }
}

/** Models wrap JSON in a fence often enough that not handling it is a bug. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
