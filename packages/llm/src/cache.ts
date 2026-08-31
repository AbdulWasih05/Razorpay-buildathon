import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelRequest, ModelResponse } from './provider.js';

/**
 * Record / replay (CLAUDE.md hard rule #5).
 *
 * Every model response is recorded under a SHA-256 of the request. Eval runs
 * replay from the committed fixture by default; `--live` re-records. This is
 * what makes gate decisions and metrics byte-reproducible without claiming that
 * live model output is reproducible, which it is not.
 *
 * The key includes provider, model, prompt id, prompt version, temperature and
 * the exact prompt text. Anything that would change the output changes the key,
 * so a stale recording can never be served for a changed request -- it simply
 * misses.
 *
 * Two lessons from earlier work are built in:
 *   - The cache is written after EVERY recording, not at the end of a run.
 *     F-007 lost an entire holdout generation to a rate limit because the file
 *     was written once at the end.
 *   - Prompt inputs are built only from seed-derived fields (D-007). If a
 *     server-generated id or a wall clock reached a prompt, every key would
 *     change on reseed and the eval would silently start calling live.
 */

export const DEFAULT_FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/assembly.json', import.meta.url),
);

export interface CacheEntry {
  key: string;
  provider: string;
  model: string;
  promptId: string;
  promptVersion: number;
  response: ModelResponse;
  /** When this recording was made. Metadata only; never part of the key. */
  recordedAt: string;
}

export function requestKey(
  provider: string,
  model: string,
  request: ModelRequest,
): string {
  const canonical = JSON.stringify([
    provider,
    model,
    request.promptId,
    request.promptVersion,
    request.temperature,
    request.maxOutputTokens,
    request.system,
    request.user,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export class ResponseCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly path: string = DEFAULT_FIXTURE_PATH) {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: CacheEntry[] };
    for (const entry of raw.entries ?? []) this.entries.set(entry.key, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  /** Records and persists immediately. See F-007. */
  record(entry: CacheEntry): void {
    this.entries.set(entry.key, entry);
    this.persist();
  }

  persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Sorted by key so the committed fixture has a stable diff.
    const entries = [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
    writeFileSync(this.path, `${JSON.stringify({ entries }, null, 2)}\n`);
  }
}

export class ReplayMissError extends Error {
  constructor(
    readonly key: string,
    readonly promptId: string,
  ) {
    super(
      `no recorded response for ${promptId} (key ${key.slice(0, 12)}...). ` +
        'Run with --live to record it. Replay mode never calls a model.',
    );
    this.name = 'ReplayMissError';
  }
}
