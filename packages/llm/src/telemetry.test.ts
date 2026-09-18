import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectedEvidence, GateResult } from '@praman/core';

import { assembleDispute } from './assemble.js';
import { ResponseCache, type CacheEntry } from './cache.js';
import { AssemblyClient, AssemblyFailure, PROMPTS, type ModelCallTelemetry } from './client.js';
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  type ModelProvider,
  type ModelRequest,
} from './provider.js';

/**
 * Model-call telemetry: tokens, latency and attempts per call.
 *
 * The property these tests exist to hold is the replay one. Telemetry is
 * measured once, when a call is made live, and stored with the recording; a
 * replayed run reads it back and measures nothing, so the same run reports the
 * same figures every time. Figures that were never recorded are null, never
 * zero.
 */

const SUMMARY = JSON.stringify({
  summary: 'The customer asked the agent to reorder the usual weekly groceries.',
  confirmation: 'explicit',
  ambiguityFlags: [],
});

/** A cache that keeps recordings in memory and never writes the fixture file. */
function memoryCache(): ResponseCache {
  const cache = new ResponseCache('/nonexistent/never-written.json');
  cache.persist = () => {};
  return cache;
}

const request: ModelRequest = {
  promptId: 'probe',
  promptVersion: 1,
  system: 'system',
  user: 'user',
  maxOutputTokens: 10,
  temperature: 0,
};

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('providers read token usage in their own vocabulary', () => {
  it('reads prompt_tokens / completion_tokens from an OpenAI-compatible response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: '{}' } }],
          usage: { prompt_tokens: 812, completion_tokens: 96 },
        }),
      ),
    );
    const provider = new OpenAiCompatibleProvider('groq', 'model', 'key', 'https://example.test');
    const response = await provider.complete(request, signal());
    expect(response.usage).toEqual({ inputTokens: 812, outputTokens: 96 });
  });

  it('reads input_tokens / output_tokens from an Anthropic response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 700, output_tokens: 80 },
        }),
      ),
    );
    const provider = new AnthropicProvider('model', 'key', 'https://example.test');
    const response = await provider.complete(request, signal());
    expect(response.usage).toEqual({ inputTokens: 700, outputTokens: 80 });
  });

  it('leaves usage absent, not zero, when the provider reports none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ choices: [{ message: { content: '{}' } }] })),
    );
    const provider = new OpenAiCompatibleProvider('groq', 'model', 'key', 'https://example.test');
    const response = await provider.complete(request, signal());
    expect(response.usage).toBeUndefined();
  });
});

describe('a live call is measured once, and the figures travel with the recording', () => {
  it('reports the call and stores the same figures in the recorded entry', async () => {
    const cache = memoryCache();
    const recorded: CacheEntry[] = [];
    const record = cache.record.bind(cache);
    cache.record = (entry) => {
      recorded.push(entry);
      record(entry);
    };
    const provider: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => ({
        text: SUMMARY,
        providerRefused: false,
        attempts: 1,
        usage: { inputTokens: 300, outputTokens: 40 },
      }),
    };

    const calls: ModelCallTelemetry[] = [];
    await new AssemblyClient({ provider, cache, mode: 'live' }).summariseTrace('a trace', calls);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      promptId: PROMPTS.traceSummary.id,
      promptVersion: PROMPTS.traceSummary.version,
      provider: 'fake',
      model: 'fake-1',
      source: 'live',
      transport: 'completed',
      attempts: 1,
      usage: { inputTokens: 300, outputTokens: 40 },
    });
    expect(calls[0]?.latencyMs).toEqual(expect.any(Number));
    expect(recorded[0]?.response.latencyMs).toBe(calls[0]?.latencyMs);
    expect(recorded[0]?.response.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
  });

  it('records a timeout with its latency and no usage', async () => {
    const provider: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: (_request, abort) =>
        new Promise((_resolve, reject) => {
          abort.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const client = new AssemblyClient({ provider, cache: memoryCache(), mode: 'live', timeoutMs: 20 });

    const calls: ModelCallTelemetry[] = [];
    await expect(client.summariseTrace('a trace', calls)).rejects.toBeInstanceOf(AssemblyFailure);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: 'live', transport: 'timeout', attempts: null, usage: null });
    expect(calls[0]?.latencyMs).toEqual(expect.any(Number));
  });
});

describe('replay reads the recorded figures and measures nothing', () => {
  it('reports identical telemetry on every replay, without calling the provider', async () => {
    const cache = memoryCache();
    const live: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => ({
        text: SUMMARY,
        providerRefused: false,
        attempts: 2,
        usage: { inputTokens: 5, outputTokens: 6 },
      }),
    };
    await new AssemblyClient({ provider: live, cache, mode: 'live' }).summariseTrace('same input');

    const never: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => {
        throw new Error('replay must never reach the provider');
      },
    };
    const replay = new AssemblyClient({ provider: never, cache, mode: 'replay' });
    const first: ModelCallTelemetry[] = [];
    const second: ModelCallTelemetry[] = [];
    await replay.summariseTrace('same input', first);
    await replay.summariseTrace('same input', second);

    expect(first[0]).toMatchObject({
      source: 'replay',
      transport: 'completed',
      attempts: 2,
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    expect(second).toEqual(first);
  });

  it('reports null, not zero, for a recording made before telemetry existed', async () => {
    const cache = memoryCache();
    const record = cache.record.bind(cache);
    // Store what an older fixture holds: the text and the refusal flag, nothing else.
    cache.record = (entry) =>
      record({
        ...entry,
        response: { text: entry.response.text, providerRefused: entry.response.providerRefused },
      });
    const provider: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => ({ text: SUMMARY, providerRefused: false }),
    };
    await new AssemblyClient({ provider, cache, mode: 'live' }).summariseTrace('old input');

    const calls: ModelCallTelemetry[] = [];
    await new AssemblyClient({ provider, cache, mode: 'replay' }).summariseTrace('old input', calls);

    expect(calls[0]).toMatchObject({ source: 'replay', attempts: null, usage: null, latencyMs: null });
  });
});

describe('telemetry reaches the assembled dispute', () => {
  const collected: CollectedEvidence = {
    disputeId: 'disp_TelemetryTest',
    packExternalId: 'pack_test',
    rail: 'agentic',
    network: 'upi',
    reasonCode: '128',
    rubric: { network: 'upi', code: '128', category: 'fraud', hasPublishedGuidance: true, requires: [] },
    findings: [],
    missingRequired: [],
    structurallyUnavailable: [],
    coverage: { required: 0, present: 0, ratio: 1 },
    mandate: { present: false, chargedAmount: 224000 },
    anomalySignals: [],
  };
  const gate = (decision: 'contest' | 'abstain'): GateResult => ({
    disputeId: collected.disputeId,
    decision,
    rules: [{ id: 'test_gate', passed: decision === 'contest', detail: 'set by this test' }],
    requiredCoverage: 1,
    missingRequired: [],
    thresholds: { requiredCoverageRatio: 1, anomalySignalsBlock: true },
    ...(decision === 'abstain' ? { reason: 'declined by this test' } : {}),
  });
  const trace = { turns: [{ role: 'customer', content: 'Order the usual, please.' }] };

  it('carries no model calls when the gate declined, because none were made', async () => {
    const provider: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => {
        throw new Error('a declined dispute must never reach a model');
      },
    };
    const assembled = await assembleDispute({
      client: new AssemblyClient({ provider, cache: memoryCache(), mode: 'live' }),
      collected,
      gate: gate('abstain'),
      trace,
      amount: 224000,
    });
    expect(assembled.modelCalls).toEqual([]);
  });

  it('keeps the telemetry of a call whose output then failed validation', async () => {
    const provider: ModelProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => ({
        text: 'not json',
        providerRefused: false,
        attempts: 1,
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    };
    const assembled = await assembleDispute({
      client: new AssemblyClient({ provider, cache: memoryCache(), mode: 'live' }),
      collected,
      gate: gate('contest'),
      trace,
      amount: 224000,
    });
    expect(assembled.outcome).toBe('abstained');
    expect(assembled.failureKind).toBe('schema');
    // The provider answered and was paid for; the answer was unusable. Both facts are kept.
    expect(assembled.modelCalls).toHaveLength(1);
    expect(assembled.modelCalls[0]).toMatchObject({
      transport: 'completed',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });
});
