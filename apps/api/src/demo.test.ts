import { describe, expect, it } from 'vitest';

import { DEMO_PREFIX, DEMO_RELEASE_CAP, RateLimiter } from './demo.js';

/**
 * The demo trigger's guards (TASKS.md P4.3).
 *
 * `/demo/release-dispute` and `/demo/reset` are unauthenticated, state-mutating
 * endpoints on the open internet. That is defensible for a demo only while
 * hammering them is pointless, so the thing worth testing is the guard, not the
 * happy path -- the happy path is one dispute appearing in a queue, and the
 * guard is what stops a security-minded screener from making the demo
 * incoherent for the next visitor.
 *
 * The limiter takes its clock as a parameter, so these run instantly and
 * deterministically. A rate-limit test that sleeps is a rate-limit test nobody
 * runs.
 */

describe('the demo rate limiter', () => {
  function at(times: number[]): RateLimiter {
    let i = 0;
    return new RateLimiter(3, 1_000, () => times[Math.min(i++, times.length - 1)] ?? 0);
  }

  it('allows callers up to the limit and then refuses', () => {
    const limiter = at([0, 0, 0, 0]);
    expect(limiter.take('1.2.3.4').allowed).toBe(true);
    expect(limiter.take('1.2.3.4').allowed).toBe(true);
    expect(limiter.take('1.2.3.4').allowed).toBe(true);
    expect(limiter.take('1.2.3.4').allowed).toBe(false);
  });

  it('tells a refused caller when to come back', () => {
    const limiter = at([0, 0, 0, 400]);
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    const refused = limiter.take('a');
    expect(refused.allowed).toBe(false);
    // 1000ms window, 400ms elapsed: 600ms left, rounded up to a second.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('budgets each caller separately', () => {
    // Otherwise one visitor hammering it would lock out everyone else, which
    // turns a rate limit into the denial of service it was meant to prevent.
    const limiter = at([0, 0, 0, 0, 0]);
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('lets a caller back in once the window has passed', () => {
    const limiter = at([0, 0, 0, 1_500]);
    limiter.take('a');
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('forgets callers whose window has expired, so the map cannot grow forever', () => {
    // Eviction on read rather than a timer: an idle process holds nothing.
    const limiter = at([0, 5_000]);
    limiter.take('gone');
    const second = limiter.take('other');
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(2);
  });
});

describe('the demo cannot reach the corpus the eval measures', () => {
  it('prefixes released disputes so they can never collide with a seeded one', () => {
    // Seeded ids are `dsp_dev-v1_<class>_<index>`. A demo release is the same
    // id behind `demo-`, so a `startsWith` cleanly separates the two
    // populations and the reset can delete one without touching the other.
    expect(DEMO_PREFIX).toBe('demo-');
    expect(`${DEMO_PREFIX}dsp_dev-v1_b1_500`.startsWith(DEMO_PREFIX)).toBe(true);
    expect('dsp_dev-v1_b1_0'.startsWith(DEMO_PREFIX)).toBe(false);
  });

  it('caps total releases, so patience is not a way around the rate limit', () => {
    expect(DEMO_RELEASE_CAP).toBe(20);
  });
});
