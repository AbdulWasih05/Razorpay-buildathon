import type { ModelCallTelemetry } from './client.js';

/**
 * Published per-token prices, for turning recorded usage into cost.
 *
 * A committed table, not a lookup at run time:
 *   - an eval's cost figure has to be reproducible, and a live price page
 *     changes without notice;
 *   - each entry says where it was read and when, so a stale price shows up
 *     as stale.
 *
 * A model with no public price (Groq lists some as "Contact sales") gets no
 * entry, and its cost is null rather than a guess.
 */

export interface ModelPrice {
  /** US dollars per million input tokens. */
  inputUsdPerMillion: number;
  /** US dollars per million output tokens. */
  outputUsdPerMillion: number;
  /** Where the price was read. */
  source: string;
  /** When it was read, as an ISO date. */
  retrievedOn: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'groq:qwen/qwen3.8-27b': {
    inputUsdPerMillion: 0.8,
    outputUsdPerMillion: 4.0,
    source: 'https://console.groq.com/docs/models',
    retrievedOn: '2026-09-15',
  },
};

export function priceFor(provider: string, model: string): ModelPrice | null {
  return MODEL_PRICES[`${provider}:${model}`] ?? null;
}

/**
 * Cost of one call in US dollars. Null when usage was not recorded or the model
 * has no published price: an unknown cost is reported as unknown.
 */
export function callCostUsd(
  call: Pick<ModelCallTelemetry, 'provider' | 'model' | 'usage'>,
): number | null {
  const price = priceFor(call.provider, call.model);
  if (!call.usage || !price) return null;
  return (
    (call.usage.inputTokens * price.inputUsdPerMillion +
      call.usage.outputTokens * price.outputUsdPerMillion) /
    1_000_000
  );
}
