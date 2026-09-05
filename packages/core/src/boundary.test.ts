import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md hard rule #4, and D-005: "the LLM boundary is enforced by the
 * linter, not by discipline." `eslint.config.js` restricts `packages/core`
 * from importing `@praman/llm` or a model SDK -- but ESLint's
 * `no-restricted-imports` `patterns` option matches the literal import
 * SPECIFIER string, which leaves two gaps an adversarial review found and
 * confirmed empirically (2026-09-05): a dynamic `await import('@praman/llm')`
 * and a relative-path import of the same module (e.g.
 * `'../../llm/src/assemble.js'`) both produce zero lint errors, while the
 * equivalent static specifier import correctly fails.
 *
 * This is a second, structurally different check on the same boundary,
 * mirroring the eval-cannot-import-adapter guard in
 * `packages/adapter/src/adapter.test.ts` and the holdout guard in `eval/`.
 * Deliberately not the same mechanism as the ESLint rule: a regex over
 * stripped source text, not an import-specifier matcher, so the two checks
 * do not share a blind spot. "Defense in depth is worth nothing if every
 * layer trusts the same string" (FAILURES.md F-013) applies here as much as
 * it did there.
 *
 * What this catches that the lint rule does not:
 *   - `import(...)` (dynamic) naming `@praman/llm` or a model SDK
 *   - any relative-path import/require whose path traverses into
 *     `packages/llm` -- `../llm/src/x.js`, `../../packages/llm/...`, etc.
 *
 * What it does not replace: the lint rule still runs on every save and every
 * static import, which is the common case and the one a reviewer sees first.
 * This is the check for the two cases that only get found by trying to break
 * the boundary on purpose.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function coreSources(): string[] {
  return globSync(['packages/core/src/**/*.ts'], { cwd: REPO_ROOT })
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => !path.endsWith('.test.ts'));
}

function code(relative: string): string {
  const source = readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const MODEL_SDK_NAMES = ['@anthropic-ai/', 'openai', 'groq-sdk', '@google/'];

describe('packages/core cannot reach the LLM boundary by any path (D-005, structural)', () => {
  it('finds the core sources (guard is not silently vacuous)', () => {
    // D-029: a guard over an empty glob is vacuously true. This file's own
    // sources are excluded (`.test.ts`), so the count also proves that
    // exclusion did not eat everything.
    expect(coreSources().length).toBeGreaterThan(10);
  });

  it('has no static or dynamic import of @praman/llm', () => {
    // Covers `import ... from '@praman/llm'`, `import('@praman/llm')`, and a
    // subpath import like `@praman/llm/client` -- all contain the same
    // literal string, which is exactly what the lint rule also matches. This
    // half is redundant with ESLint on purpose (see docblock).
    const offenders = coreSources().filter((relative) => /@praman\/llm/.test(code(relative)));
    expect(offenders).toEqual([]);
  });

  it('has no dynamic import() naming a model SDK', () => {
    // The confirmed gap: `no-restricted-imports` does not check
    // `ImportExpression` nodes by default, so a dynamic import of a model SDK
    // package sails through lint clean.
    const offenders = coreSources().filter((relative) => {
      const source = code(relative);
      return MODEL_SDK_NAMES.some((name) =>
        new RegExp(`import\\s*\\(\\s*['"\`]${name.replace('/', '\\/')}`, 'u').test(source),
      );
    });
    expect(offenders).toEqual([]);
  });

  it('has no relative-path import that traverses into packages/llm', () => {
    // The other confirmed gap: `import { x } from '../../llm/src/y.js'`
    // reaches the exact same module as `@praman/llm` without ever writing
    // that string, so a specifier-matching rule cannot see it. A relative
    // path is checked by shape (does it mention an `llm` package directory)
    // rather than by resolving it, which is enough to catch the case that
    // matters: nothing under packages/core has a legitimate reason to
    // traverse into a sibling package by relative path at all -- workspace
    // packages import each other by name.
    const offenders = coreSources().filter((relative) => {
      const source = code(relative);
      const importPaths = [
        ...source.matchAll(/from\s+['"`]([^'"`]+)['"`]/gu),
        ...source.matchAll(/import\s*\(\s*['"`]([^'"`]+)['"`]/gu),
        ...source.matchAll(/require\s*\(\s*['"`]([^'"`]+)['"`]/gu),
      ].map((match) => match[1] ?? '');
      return importPaths.some(
        (path) => path.startsWith('.') && /(^|\/)packages\/llm(\/|$)|(^|\/)llm\/src(\/|$)/u.test(path),
      );
    });
    expect(offenders).toEqual([]);
  });
});
