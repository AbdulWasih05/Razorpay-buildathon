import { describe, expect, it } from 'vitest';

import { MODEL_PRICES, callCostUsd, priceFor } from './pricing.js';

describe('call cost comes from recorded usage and a cited price', () => {
  it('prices a call from its recorded tokens', () => {
    const cost = callCostUsd({
      provider: 'groq',
      model: 'qwen/qwen3.8-27b',
      usage: { inputTokens: 812, outputTokens: 96 },
    });
    // 812 x $0.80/M + 96 x $4.00/M
    expect(cost).toBeCloseTo(0.0010336, 10);
  });

  it('is null, not zero, when usage was not recorded', () => {
    expect(callCostUsd({ provider: 'groq', model: 'qwen/qwen3.8-27b', usage: null })).toBeNull();
  });

  it('is null, not a guess, for a model with no published price', () => {
    expect(priceFor('groq', 'llama-3.3-70b-versatile')).toBeNull();
    expect(
      callCostUsd({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    ).toBeNull();
  });

  it('cites a source and a retrieval date for every price', () => {
    const entries = Object.values(MODEL_PRICES);
    expect(entries.length).toBeGreaterThan(0);
    for (const price of entries) {
      expect(price.source).toMatch(/^https:\/\//);
      expect(price.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
