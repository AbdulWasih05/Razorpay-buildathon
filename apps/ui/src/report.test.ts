import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportView, parseReport } from './Report.js';

/**
 * The metrics page, tested against the real report rather than a sample.
 *
 * P4.2's acceptance criterion is that the page "matches `eval/results.md`
 * numbers exactly", and the design meets it by rendering that file instead of
 * recomputing anything. So the thing worth testing is not arithmetic -- there
 * is none -- but that the renderer does not silently DROP content. A parser
 * that skipped a table would produce a page that is wrong in the one way this
 * design was supposed to make impossible, and it would look fine.
 *
 * Hence the shape of these assertions: every table in the source appears in the
 * output, every row of every table appears, and the sentences that must travel
 * with the numbers (hard rule #6) are present in the rendered page.
 */

const REPORT = fileURLToPath(new URL('../../../eval/results.md', import.meta.url));
const markdown = readFileSync(REPORT, 'utf8');

function render(): string {
  return renderToStaticMarkup(createElement(ReportView, { markdown }));
}

describe('the report parses without losing anything', () => {
  it('finds every table the markdown contains', () => {
    // Counted from the source: a table starts at a header row followed by a
    // `| --- |` divider, which is unambiguous and cheap to count independently.
    const dividers = markdown.split(/\r?\n/).filter((line) => /^\|[\s|:-]+\|$/.test(line)).length;
    const tables = parseReport(markdown).filter((block) => block.kind === 'table');
    expect(tables.length).toBe(dividers);
    expect(tables.length).toBeGreaterThan(8);
  });

  it('keeps every row of every table', () => {
    const sourceRows = markdown
      .split(/\r?\n/)
      .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line)).length;
    const parsedRows = parseReport(markdown)
      .filter((block) => block.kind === 'table')
      .reduce((sum, block) => sum + (block.kind === 'table' ? block.rows.length + 1 : 0), 0);
    expect(parsedRows).toBe(sourceRows);
  });

  it('keeps every heading', () => {
    const sourceHeadings = markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line)).length;
    const parsed = parseReport(markdown).filter((block) => block.kind === 'heading').length;
    expect(parsed).toBe(sourceHeadings);
  });
});

describe('the numbers arrive with the sentences that qualify them', () => {
  it('shows the headline metrics', () => {
    const html = render();
    // Dev and held-out recall, as fractions rather than only percentages.
    expect(html).toContain('31/38');
    expect(html).toContain('7/9');
  });

  it('carries the caveat that must never be separated from FP = 0', () => {
    // Hard rule #6. A dashboard is exactly where this sentence gets dropped,
    // because a chart has nowhere to put it. This page has, because it renders
    // the prose too.
    expect(render()).toContain('Do not quote');
  });

  it('names the model of record on the page, not in a footnote', () => {
    expect(render()).toContain('qwen/qwen3.8-27b');
  });

  it('renders no won or lost outcome anywhere', () => {
    // The same assertion the review panel carries: a simulated outcome must
    // never appear unlabelled, and the simplest guarantee is that neither
    // surface has anywhere to put one.
    expect(render()).not.toMatch(/\bsimulated win/i);
  });
});
