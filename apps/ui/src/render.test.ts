import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Detail } from './App.js';
import type { DisputeDetail } from './api.js';
import { daysUntil, formatRupees } from './api.js';
import fixtures from './__fixtures__/disputes.json' with { type: 'json' };

/**
 * Does the review panel actually render?
 *
 * The end-to-end call sequence (queue -> detail -> approve -> reload) was
 * verified against the running API, and the exact JSON those calls returned is
 * committed in `__fixtures__/`. What was NOT verified is the step in between:
 * whether React, handed that JSON, produces a page rather than throwing. Nobody
 * had looked at the rendered output, because the browser extension was not
 * connected -- so "the loop works" rested on the two ends of it.
 *
 * This closes the middle. It renders the panel to static markup against the
 * three real payloads -- a drafted dispute, an abstained one, a submitted one --
 * and asserts the reviewer can see what they need to decide. It cannot see
 * layout, colour or a broken stylesheet, and it does not pretend to; the point
 * is that a demo cannot be met by a blank screen from `detail.draft.summary` on
 * a dispute that has no draft.
 *
 * The fixtures are captured API responses, not hand-written ones, so they carry
 * real letter text, real gate reasons and a real audit trail -- including their
 * exact wording at capture time. Nothing here asserts on that wording (a
 * reworded audit reason is not a rendering bug), but they should be recaptured
 * after the P4.0 reseed so the committed sample matches what the product now
 * emits.
 *
 * Server rendering rather than jsdom: it needs no new dependency the day before
 * a feature freeze, and the failure it is chasing -- reading a field that is
 * null on some states -- happens during render, which is exactly what this runs.
 */

const [drafted, abstained, submitted] = fixtures as unknown as DisputeDetail[];

/**
 * React escapes `'`, `&`, `<` and `>` in text nodes, so markup does not
 * contain the letter verbatim even when it renders it perfectly. Decode before
 * comparing against source text, or the test fails on the escaping rather than
 * on anything a reviewer would notice.
 */
function text(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function render(detail: DisputeDetail): string {
  return renderToStaticMarkup(
    createElement(Detail, {
      detail,
      busy: false,
      reviewer: 'human:wasih',
      onApprove: () => undefined,
    }),
  );
}

describe('the panel renders every lifecycle state it can be handed', () => {
  it('renders a drafted dispute with the letter and its character count', () => {
    const html = render(drafted!);
    expect(html).toContain(drafted!.disputeId);
    expect(text(html)).toContain(drafted!.draft!.summary);
    // The count against the cap: a reviewer approving a letter needs to see it
    // is inside the 1000 Razorpay allows, not trust that it is.
    expect(html).toContain(`${drafted!.draft!.summary.length}/1000`);
  });

  it('renders an abstained dispute without reaching into a draft that is null', () => {
    // The crash this file exists to prevent. `detail.draft.summary.length` on
    // an abstention is a blank screen in the middle of a demo.
    expect(abstained!.draft).toBeNull();
    const html = render(abstained!);
    expect(html).toContain('Nothing to approve');
    expect(html).not.toContain('/1000');
  });

  it('renders a submitted dispute naming who approved it', () => {
    const html = render(submitted!);
    expect(html).toContain('Submitted');
    expect(html).toContain(submitted!.approvedBy as string);
  });
});

describe('what the reviewer must be able to see', () => {
  it('shows the gate reason in the gate\'s own words, not a score', () => {
    const html = render(abstained!);
    expect(abstained!.gateReason).toBeTruthy();
    expect(text(html)).toContain(abstained!.gateReason as string);
  });

  it('shows every evidence finding with its state', () => {
    const html = render(drafted!);
    expect(drafted!.collected!.findings.length).toBeGreaterThan(0);
    for (const finding of drafted!.collected!.findings) {
      expect(html, finding.artifact).toContain(finding.artifact);
      expect(html, finding.artifact).toContain(`badge ${finding.state}`);
    }
  });

  it('shows the whole audit trail, not a summary of it', () => {
    const html = render(submitted!);
    for (const row of submitted!.timeline) {
      // Rendered inside a <pre>, so the text survives verbatim except for
      // HTML-escaped characters; the actor and transition are what matter.
      expect(html).toContain(row.split(' ')[0]!);
    }
    expect(submitted!.timeline.length).toBeGreaterThanOrEqual(6);
  });
});

describe('the approve button appears in exactly one state', () => {
  it('offers approval on a drafted dispute and nowhere else', () => {
    // The UI half of hard rule #2. An approve control on an abstained or
    // already-submitted dispute is a second door, however well guarded the
    // server is.
    expect(render(drafted!)).toContain('Approve and submit');
    expect(render(abstained!)).not.toContain('Approve and submit');
    expect(render(submitted!)).not.toContain('Approve and submit');
  });

  it('names the reviewer on the button itself', () => {
    // So an approval is never made by an unnamed "you".
    expect(render(drafted!)).toContain('Approve and submit as human:wasih');
  });
});

describe('the panel leaks no ground truth', () => {
  it('has no ground-truth field in any committed payload', () => {
    // D-027, asserted on the real API responses rather than on the route code.
    for (const detail of fixtures as unknown as Record<string, unknown>[]) {
      expect(Object.keys(detail)).not.toContain('groundTruth');
      expect(Object.keys(detail)).not.toContain('groundTruthRationale');
    }
  });

  it('renders no won or lost outcome anywhere', () => {
    // Hard rule #6: a simulated outcome must never appear unlabelled, and the
    // simplest way to keep that true is that the UI has nowhere to put one.
    for (const detail of [drafted!, abstained!, submitted!]) {
      const html = render(detail);
      expect(html).not.toMatch(/\b(won|lost)\b/i);
    }
  });
});

describe('the queue helpers', () => {
  it('formats rupees from subunits in the Indian numbering system', () => {
    expect(formatRupees(123456789)).toBe('₹12,34,567.89');
    expect(formatRupees(0)).toBe('₹0');
  });

  it('counts days to a deadline, and goes negative once it has passed', () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(daysUntil(soon)).toBe(2);
    expect(daysUntil(past)).toBe(-3);
  });
});
