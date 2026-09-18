import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Detail } from './Detail.js';
import type { DisputeDetail, ModelCall } from './api.js';
import fixtures from './__fixtures__/disputes.json' with { type: 'json' };

/**
 * The model-calls panel in the review console.
 *
 * What it must never do is fill a gap with a number. Recordings made before
 * telemetry existed carry no tokens, latency or attempts, and the panel says so
 * in words; a zero there would be a false measurement on the one screen a
 * reviewer uses to judge the model's part in a decision.
 */

const [drafted] = fixtures as unknown as DisputeDetail[];
const NOW = '2026-07-21T00:00:00.000Z';

function render(detail: DisputeDetail): string {
  return renderToStaticMarkup(createElement(Detail, { detail, now: NOW }));
}

const predatesTelemetry: ModelCall = {
  promptId: 'letter-draft',
  promptVersion: 2,
  provider: 'groq',
  model: 'qwen/qwen3.8-27b',
  source: 'replay',
  transport: 'completed',
  attempts: null,
  usage: null,
  latencyMs: null,
};

describe('the model-calls panel', () => {
  it('is absent when no model was called', () => {
    expect(render({ ...drafted!, modelCalls: [] })).not.toContain('Model calls');
  });

  it('says "not recorded" for figures a recording predates, never zero', () => {
    const html = render({ ...drafted!, modelCalls: [predatesTelemetry] });
    expect(html).toContain('Model calls');
    expect(html).toContain('letter-draft v2');
    expect(html).toContain('not recorded');
    expect(html).not.toContain('0 ms');
  });

  it('shows the recorded tokens, latency and attempts', () => {
    const html = render({
      ...drafted!,
      modelCalls: [
        {
          ...predatesTelemetry,
          attempts: 1,
          usage: { inputTokens: 812, outputTokens: 96 },
          latencyMs: 1430,
        },
      ],
    });
    expect(html).toContain('812 / 96');
    expect(html).toContain('1430 ms');
    expect(html).not.toContain('not recorded');
  });
});
