import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pathOf, routeOf, type Route } from './router.js';

/**
 * The router, and the one invariant the landing page rests on.
 *
 * Three routes and no parameters, so there is not much to test -- except that
 * the mapping is total and reversible, which is exactly what broke: `view` was
 * held as component state seeded once from a prop, so the address bar and the
 * rendered page could disagree after a back button (FAILURES.md F-022). The
 * route is now the only thing that knows which page is open, and these tests pin
 * the mapping it depends on.
 */

const ROUTES: Route[] = ['landing', 'console', 'eval'];

describe('the route mapping is total and reversible', () => {
  it('round-trips every route through its path', () => {
    for (const route of ROUTES) {
      expect(routeOf(pathOf(route)), route).toBe(route);
    }
  });

  it('maps the three real paths', () => {
    expect(routeOf('/')).toBe('landing');
    expect(routeOf('/app')).toBe('console');
    expect(routeOf('/eval')).toBe('eval');
  });

  it('ignores a trailing slash, because a pasted link often carries one', () => {
    expect(routeOf('/app/')).toBe('console');
    expect(routeOf('/eval/')).toBe('eval');
    expect(routeOf('')).toBe('landing');
  });

  it('falls back to the overview for anything it does not recognise', () => {
    // The API's SPA fallback serves index.html for any extensionless GET, so
    // an unknown path reaches this code rather than 404ing. Landing on the
    // overview is the right answer: it explains what the thing is and links to
    // the console, which is what someone who mistyped a URL needs.
    expect(routeOf('/nope')).toBe('landing');
    expect(routeOf('/app/extra')).toBe('landing');
  });
});

describe('the landing page writes no metric of its own', () => {
  it('contains neither a percentage nor a rupee figure in its source', () => {
    // The landing page renders the `Headline` table out of the committed
    // `eval/results.md` verbatim. Percentages and rupee amounts are the units
    // every headline metric is reported in, so either character appearing in
    // this file means a number was typed by hand -- which is the second source
    // of truth P4.2 exists to prevent, arriving on a different page.
    const source = readFileSync(
      fileURLToPath(new URL('./Landing.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('%');
    expect(source).not.toContain('₹');
  });
});
