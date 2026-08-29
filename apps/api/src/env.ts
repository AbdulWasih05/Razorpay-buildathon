import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Load the repo-root `.env`, wherever the process was started from.
 *
 * `process.loadEnvFile('.env')` resolves against the *current working
 * directory*, so it works when the API is started from the repo root and throws
 * ENOENT when pnpm starts it from `apps/api`. Since the API will be launched
 * both ways -- directly, and via `pnpm --filter` -- the path has to be found
 * rather than assumed. See FAILURES.md F-006.
 *
 * Walking up from this file rather than from `process.cwd()` means the answer
 * does not depend on how the process was launched at all.
 */
export function loadRootEnv(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Not an error: in a deployed environment the variables come from the
  // platform, and there is no .env file at all.
  return null;
}
