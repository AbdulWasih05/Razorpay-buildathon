import { describe, expect, it } from 'vitest';

import {
  ASSEMBLY_ABSTAIN_REASON,
  ASSEMBLY_FAILURE_KINDS,
  AssemblyClient,
  AssemblyFailure,
} from './client.js';
import { ResponseCache } from './cache.js';
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.js';
import { assembleDispute } from './assemble.js';
import { assertNotHoldoutFamily } from './config.js';
import type { CollectedEvidence } from '@praman/core';

/**
 * CLAUDE.md hard rule #4: "Tests cover all FOUR failure paths: error, timeout,
 * refusal, schema-validation failure."
 *
 * These are those tests. Each drives a real `AssemblyClient` through a fake
 * provider that fails in exactly one way, and asserts the dispute reaches
 * abstention with the verbatim reason -- never a retry, never a partial draft.
 */

/** A cache that records nothing, so live mode really calls the fake provider. */
function emptyCache(): ResponseCache {
  const cache = new ResponseCache('/nonexistent/never-written.json');
  // Recording would write to disk; these tests never take the success path.
  cache.record = () => {};
  return cache;
}

function clientWith(provider: ModelProvider, timeoutMs = 50): AssemblyClient {
  return new AssemblyClient({ provider, cache: emptyCache(), mode: 'live', timeoutMs });
}

const fake = (
  complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse>,
): ModelProvider => ({ name: 'fake', model: 'fake-1', complete });

/** A minimal collected-evidence report. Content is irrelevant to these paths. */
const collected: CollectedEvidence = {
  disputeId: 'disp_FailurePathTest',
  packExternalId: 'pack_test',
  rail: 'agentic',
  network: 'upi',
  reasonCode: '128',
  rubric: {
    network: 'upi',
    code: '128',
    category: 'fraud',
    hasPublishedGuidance: true,
    requires: [],
  },
  findings: [],
  missingRequired: [],
  structurallyUnavailable: [],
  coverage: { required: 0, present: 0, ratio: 1 },
  mandate: { present: false, chargedAmount: 224000 },
  anomalySignals: [],
};

const trace = { turns: [{ role: 'customer', content: 'Order the usual, please.' }] };

async function assembleWith(provider: ModelProvider, timeoutMs = 50) {
  return assembleDispute({
    client: clientWith(provider, timeoutMs),
    collected,
    trace,
    amount: 224000,
  });
}

describe('the four failure paths all reach the same door', () => {
  it('names exactly four', () => {
    expect([...ASSEMBLY_FAILURE_KINDS]).toEqual(['error', 'timeout', 'refusal', 'schema']);
  });

  it('PATH 1 -- provider error abstains', async () => {
    const result = await assembleWith(
      fake(async () => {
        throw new ProviderError('groq 500: upstream unavailable', 500);
      }),
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('error');
    expect(result.abstentionReason).toBe(ASSEMBLY_ABSTAIN_REASON);
  });

  it('PATH 2 -- timeout abstains, and is not miscounted as an error', async () => {
    const result = await assembleWith(
      fake(
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }),
      ),
      20,
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('timeout');
  });

  it('PATH 3a -- a provider refusal signal abstains', async () => {
    const result = await assembleWith(
      fake(async () => ({ text: '', providerRefused: true })),
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('refusal');
  });

  it('PATH 3b -- the documented {"refused": true} contract abstains', async () => {
    const result = await assembleWith(
      fake(async () => ({
        text: JSON.stringify({ refused: true, reason: 'the evidence does not support a contest' }),
        providerRefused: false,
      })),
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('refusal');
  });

  it('PATH 4a -- malformed output abstains', async () => {
    const result = await assembleWith(
      fake(async () => ({ text: 'Sure! Here is the summary you asked for.', providerRefused: false })),
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('schema');
  });

  it('PATH 4b -- F-002: HTTP 200 with an empty body abstains', async () => {
    // Named for the real incident. Groq returned 200 with content "" and
    // finish_reason "length" when the output budget was consumed by reasoning
    // tokens before any text was emitted. A provider success and an assembly
    // failure at the same time -- which is precisely why path 4 exists.
    const result = await assembleWith(fake(async () => ({ text: '', providerRefused: false })));
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('schema');
    expect(result.audit.some((entry) => entry.detail.includes('empty response body'))).toBe(true);
  });

  it('PATH 4c -- an over-length letter abstains rather than being truncated', async () => {
    // D-003: the drafter targets 1000 characters. Over-length is a schema
    // failure, not something to trim -- a letter cut mid-sentence would ship a
    // mangled argument wearing the appearance of success.
    const summariser = JSON.stringify({
      summary: 'The customer asked the agent to reorder and the agent placed the order.',
      confirmation: 'explicit',
      ambiguityFlags: [],
    });
    const overLong = JSON.stringify({ letter: 'x'.repeat(1001) });
    let call = 0;
    const result = await assembleWith(
      fake(async () => ({ text: call++ === 0 ? summariser : overLong, providerRefused: false })),
    );
    expect(result.outcome).toBe('abstained');
    expect(result.failureKind).toBe('schema');
    expect(result.audit.at(-2)?.detail).toMatch(/1000-character limit/);
  });
});

describe('what abstention does and does not do', () => {
  it('never retries a failed call', async () => {
    let calls = 0;
    await assembleWith(
      fake(async () => {
        calls += 1;
        throw new ProviderError('groq 500', 500);
      }),
    );
    expect(calls).toBe(1);
  });

  it('produces no draft when it abstains', async () => {
    const result = await assembleWith(fake(async () => ({ text: '{}', providerRefused: false })));
    expect(result.draft).toBeUndefined();
  });

  it('audit-logs the failure and the abstention, in that order', async () => {
    const result = await assembleWith(
      fake(async () => {
        throw new ProviderError('groq 429: rate limited', 429);
      }),
    );
    const steps = result.audit.map((entry) => entry.step);
    expect(steps).toContain('assembly_failed');
    expect(steps).toContain('abstained');
    expect(steps.indexOf('assembly_failed')).toBeLessThan(steps.indexOf('abstained'));
    expect(result.audit.find((entry) => entry.step === 'assembly_failed')?.detail).toContain('429');
  });

  it('uses the verbatim reason from CLAUDE.md, not a paraphrase', () => {
    expect(ASSEMBLY_ABSTAIN_REASON).toBe('assembly failure, manual review required');
  });

  it('carries the failing prompt id on the failure, so it is diagnosable', () => {
    const failure = new AssemblyFailure('schema', 'letter: too long', 'letter-draft');
    expect(failure.promptId).toBe('letter-draft');
    expect(failure.message).toContain('letter-draft');
  });
});

describe('the assembler refuses the model that wrote the holdout', () => {
  it('throws rather than quietly contaminating the OOD claim', () => {
    // Everything would still run. The numbers would still look fine. The claim
    // would just be false, silently -- so it is a hard failure.
    expect(() => assertNotHoldoutFamily('openai/gpt-oss-120b')).toThrow(/held-out corpus/);
    expect(() => assertNotHoldoutFamily('qwen/qwen3.8-27b')).not.toThrow();
  });
});
