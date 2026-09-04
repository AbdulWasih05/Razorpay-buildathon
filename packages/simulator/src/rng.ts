/**
 * Seeded pseudo-random generation.
 *
 * Two properties the eval depends on:
 *
 * 1. **Deterministic.** Same seed, same output, on any machine, forever.
 *    `Math.random()` appears nowhere in this package.
 *
 * 2. **Positionally independent.** Each item derives its own generator from
 *    `seed + label`, rather than drawing from one shared stream. This matters
 *    more than it looks: with a shared stream, adding a single field to
 *    scenario a1 would shift every subsequent draw and silently regenerate the
 *    entire corpus. Here, changing a1 changes a1.
 *
 * mulberry32 is used because it is ~10 lines, has no dependencies, and can be
 * explained from first principles at a panel. Cryptographic quality is not a
 * requirement; reproducibility is.
 */

/** FNV-1a, 32-bit. Turns a seed label into a numeric seed. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, done with shifts to stay inside int32.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  bool(probability: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** A new independent generator, derived from this one's seed plus a label. */
  derive(label: string): Rng;
}

export function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (probability) => next() < probability,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('cannot pick from an empty array');
      return items[Math.floor(next() * items.length)] as T;
    },
    derive: (label: string) => createRng(`${seed}::${label}`),
  };
}

/**
 * The corpus time origin. Fixed, never `Date.now()`.
 *
 * Every timestamp in a generated transaction is an offset from this instant, so
 * regenerating the corpus next Tuesday produces the same timestamps it produced
 * today. A wall-clock base would make every reseed differ, break the canonical
 * determinism check, and change LLM prompt hashes -- which silently invalidates
 * the committed replay fixtures. See DECISIONS.md D-007.
 */
export const CORPUS_EPOCH = new Date('2026-06-01T00:00:00.000Z');

/**
 * The instant the corpus is *read* from, as opposed to generated at.
 *
 * A deadline only means something relative to a now, and the corpus has no now:
 * every `respond_by` is a fixed offset from the epoch above, and real time keeps
 * walking away from it. Rendering a seeded corpus against `Date.now()` therefore
 * does not display urgency, it displays how long ago the corpus was generated --
 * which is why every dispute in the console read as months overdue (FAILURES.md
 * F-024). The data is simulated, so the clock it is read against has to be
 * simulated too, and labelled the same way (hard rule #6).
 *
 * **Why fifty days.** `respond_by` across the dev corpus runs from 35 to 147
 * days after the epoch. Fifty puts the reader inside that spread rather than
 * past the end of it: roughly one dispute in six is genuinely overdue, a handful
 * sit inside three days, and the rest have room. That is the shape of a real
 * response queue, and it is what makes the deadline ordering worth having --
 * a queue where every row is equally, hopelessly late is sorted by nothing.
 *
 * It is a constant rather than a percentile computed from the store, because a
 * clock derived from the rows would move whenever a dispute is released or
 * approved, and a demo clock that jumps backwards when you use the demo is
 * worse than one that is merely fixed. `CORPUS_NOW` is re-derived by hand if
 * the generator's timeline ever changes; `corpus.test.ts` fails if it drifts
 * out of the distribution.
 */
export const CORPUS_NOW = new Date(CORPUS_EPOCH.getTime() + 50 * 24 * 60 * 60_000);

/** An instant offset from the fixed corpus epoch. */
export function atOffset(minutes: number): Date {
  return new Date(CORPUS_EPOCH.getTime() + minutes * 60_000);
}

/** Offset from an arbitrary base instant. */
export function shift(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

export const MINUTES_PER_DAY = 60 * 24;
