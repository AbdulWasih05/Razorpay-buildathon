import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DecisionBar } from './DecisionBar.js';
import { Detail } from './Detail.js';
import type { DisputeDetail } from './api.js';
import { daysUntil, formatRupees } from './api.js';
import fixtures from './__fixtures__/disputes.json' with { type: 'json' };

/**
 * Does the review console actually render?
 *
 * The end-to-end call sequence (queue -> detail -> approve -> reload) was
 * verified against the running API, and the exact JSON those calls returned is
 * committed in `__fixtures__/`. What was NOT verified is the step in between:
 * whether React, handed that JSON, produces a page rather than throwing. Nobody
 * had looked at the rendered output, because the browser extension was not
 * connected -- so "the loop works" rested on the two ends of it.
 *
 * This closes the middle. It renders against the three real payloads -- a
 * drafted dispute, an abstained one, a submitted one -- and asserts the reviewer
 * can see what they need to decide. It cannot see layout, colour or a broken
 * stylesheet, and it does not pretend to; the point is that a demo cannot be met
 * by a blank screen from `detail.draft.summary` on a dispute that has no draft.
 *
 * Split across two components after the P5.9 redesign. The evidence, the rule
 * trace, the mandate arithmetic and the trail live in `Detail`; the dispute's
 * identity, the gate verdict and the one door that submits live in
 * `DecisionBar`. Every invariant the previous single-component suite asserted is
 * still asserted here, against whichever component now owns it -- the approve
 * door in particular, since that assertion IS the UI half of hard rule #2.
 *
 * The fixtures are captured API responses, not hand-written ones, so they carry
 * real letter text, real gate reasons and a real audit trail. They predate the
 * `gateRules` field the API now replays, so the trace and the unrecoverable-row
 * cases are exercised against explicitly synthesised payloads below, and marked
 * as such. They should be recaptured after the next reseed.
 *
 * Server rendering rather than jsdom: it needs no new dependency, and the
 * failure it is chasing -- reading a field that is null on some states --
 * happens during render, which is exactly what this runs.
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

// `NOW` is declared below and only read when this is called, which is after the
// module has finished evaluating. The audit trail needs it to tell a row written
// on the corpus's simulated clock from one written in real time.
function work(detail: DisputeDetail): string {
  return renderToStaticMarkup(createElement(Detail, { detail, now: NOW }));
}

// The instant the tests read deadlines from. Fixed, like the corpus it is
// reading -- a wall clock here would make the deadline assertions below drift
// with the calendar, which is the same mistake in the tests that F-024 was in
// the product.
const NOW = '2026-07-21T00:00:00.000Z';

function bar(detail: DisputeDetail | null, busy = false): string {
  return renderToStaticMarkup(
    createElement(DecisionBar, {
      detail,
      busy,
      reviewer: 'human:wasih',
      now: NOW,
      onApprove: () => undefined,
    }),
  );
}

describe('the workbench renders every lifecycle state it can be handed', () => {
  it('renders a drafted dispute with the letter and its character count', () => {
    const html = work(drafted!);
    expect(text(html)).toContain(drafted!.draft!.summary);
    // The count against the cap: a reviewer approving a letter needs to see it
    // is inside the 1000 Razorpay allows, not trust that it is.
    expect(html).toContain(`${drafted!.draft!.summary.length}/1000`);
  });

  it('renders an abstained dispute without reaching into a draft that is null', () => {
    // The crash this file exists to prevent. `detail.draft.summary.length` on
    // an abstention is a blank screen in the middle of a demo.
    expect(abstained!.draft).toBeNull();
    const html = work(abstained!);
    expect(html).not.toContain('/1000');
    expect(html).toContain('Evidence ledger');
  });

  it('renders a submitted dispute including the payload that was sent', () => {
    const html = work(submitted!);
    expect(submitted!.submittedRequest).toBeTruthy();
    expect(html).toContain('Submitted contest payload');
  });
});

describe('the decision bar carries the identity and the verdict', () => {
  it('names the dispute it would submit', () => {
    expect(bar(drafted!)).toContain(drafted!.disputeId);
  });

  it("shows the gate reason in the gate's own words, not a score", () => {
    expect(abstained!.gateReason).toBeTruthy();
    expect(text(bar(abstained!))).toContain(abstained!.gateReason as string);
  });

  it('says plainly when there is nothing to approve', () => {
    expect(text(bar(abstained!))).toContain('Nothing to approve');
  });

  it('names who approved a submitted dispute', () => {
    const html = bar(submitted!);
    expect(html).toContain('Submitted');
    expect(html).toContain(submitted!.approvedBy as string);
  });

  it('renders with nothing selected rather than assuming a dispute', () => {
    expect(bar(null)).toContain('Select a dispute');
  });
});

describe('what the reviewer must be able to see', () => {
  it('shows every evidence finding with its state', () => {
    const html = work(drafted!);
    expect(drafted!.collected!.findings.length).toBeGreaterThan(0);
    for (const finding of drafted!.collected!.findings) {
      expect(html, finding.artifact).toContain(finding.artifact);
      // The state used to ride on a `badge {state}` class. The ledger now says
      // it in the tag's own words -- `required · absent` -- which is what the
      // reviewer actually reads. Asserting on the visible text rather than on a
      // class name means a restyle cannot break this test, and losing the state
      // from the screen cannot pass it.
      expect(text(html), finding.artifact).toContain(
        `${finding.necessity} · ${finding.state}`,
      );
    }
  });

  it('shows the whole audit trail, not a summary of it', () => {
    const html = work(submitted!);
    for (const row of submitted!.timeline) {
      // The trail renders each entry's recorded ISO timestamp verbatim, which
      // is the first field of the rendered timeline line.
      expect(html).toContain(row.split(' ')[0]!);
    }
    expect(submitted!.timeline.length).toBeGreaterThanOrEqual(6);
  });

  it('names the typed Razorpay evidence fields the draft populated', () => {
    // Schema fidelity is a feature (CLAUDE.md §1). If the mapping panel stops
    // naming their fields it has stopped making the claim.
    const html = work(submitted!);
    for (const assignment of submitted!.draft!.assignments) {
      expect(html, assignment.field).toContain(assignment.field);
    }
    expect(html).toContain('access_activity_log');
  });

  it('marks which side of the LLM boundary each panel came from', () => {
    // Hard rule #4, on screen. The letter is the only panel a model wrote.
    const html = work(drafted!);
    expect(html).toContain('prov llm');
    expect(html).toContain('prov det');
  });
});

describe('the mandate arithmetic appears on the agentic rail and nowhere else', () => {
  it('shows the limit check as its terms on an agentic dispute', () => {
    expect(submitted!.collected!.rail).toBe('agentic');
    const html = text(work(submitted!));
    expect(html).toContain('Mandate arithmetic');
    // The reviewer must be able to redo the arithmetic, so both sides of the
    // comparison are on screen, not just `withinLimit: true`.
    expect(html).toContain(formatRupees(submitted!.collected!.mandate.chargedAmount!));
    expect(html).toContain(formatRupees(submitted!.collected!.mandate.maxAmount!));
  });

  it('omits it entirely on the ordinary rail', () => {
    expect(drafted!.collected!.rail).toBe('ordinary');
    expect(work(drafted!)).not.toContain('Mandate arithmetic');
  });
});

describe('the gate rule trace', () => {
  it('renders every rule the gate evaluated, passed and failed alike', () => {
    // Synthesised: the committed fixtures predate the API replaying this field.
    const withTrace: DisputeDetail = {
      ...abstained!,
      gateRules: {
        agrees: true,
        rules: [
          { id: 'required_coverage', passed: false, detail: 'holds 0 of 1 required artifacts' },
          { id: 'no_anomaly_signals', passed: true, detail: 'no anomaly signals on the log' },
        ],
      },
    };
    const html = text(work(withTrace));
    expect(html).toContain('required_coverage');
    expect(html).toContain('no_anomaly_signals');
    expect(html).toContain('holds 0 of 1 required artifacts');
    expect(html).toContain('1/2 rules passed');
  });

  it('says so loudly when a replayed trace disagrees with the recorded decision', () => {
    const disagreeing: DisputeDetail = {
      ...abstained!,
      gateRules: {
        agrees: false,
        rules: [{ id: 'required_coverage', passed: true, detail: 'all required present' }],
      },
    };
    expect(text(work(disagreeing))).toContain('different decision');
  });

  it('degrades to an explanation rather than an empty panel when there is no trace', () => {
    expect(text(work(abstained!))).toContain('No rule trace');
  });
});

describe('unrecoverable evidence states its own case', () => {
  it('explains why a structurally unavailable artifact is the thesis, not a gap', () => {
    // Synthesised: no committed fixture currently carries one.
    const gap: DisputeDetail = {
      ...abstained!,
      collected: {
        ...abstained!.collected!,
        structurallyUnavailable: ['authorisation_evidence'],
      },
    };
    const html = text(work(gap));
    expect(html).toContain('Unrecoverable at dispute time');
    expect(html).toContain('lives with the agent platform');
  });
});

describe('the approve button appears in exactly one state', () => {
  it('offers approval on a drafted dispute and nowhere else', () => {
    // The UI half of hard rule #2. An approve control on an abstained or
    // already-submitted dispute is a second door, however well guarded the
    // server is.
    expect(bar(drafted!)).toContain('Approve and submit');
    expect(bar(abstained!)).not.toContain('Approve and submit');
    expect(bar(submitted!)).not.toContain('Approve and submit');
    expect(bar(null)).not.toContain('Approve and submit');
  });

  it('names the reviewer on the button itself', () => {
    // So an approval is never made by an unnamed "you".
    expect(bar(drafted!)).toContain('Approve and submit as human:wasih');
  });

  it('disables the door while a submission is in flight', () => {
    // Double-submitting one dispute is the cheapest way to turn one door into
    // two, and it is a double click away without this.
    expect(bar(drafted!, true)).toContain('disabled');
  });

  it('exists in no other component', () => {
    // The workbench renders evidence. If an approve control ever appears in it,
    // the invariant has been broken by a refactor rather than by a decision.
    for (const detail of [drafted!, abstained!, submitted!]) {
      expect(work(detail)).not.toContain('Approve and submit');
    }
  });
});

describe('the console leaks no ground truth', () => {
  it('has no ground-truth field in any committed payload', () => {
    // D-027, asserted on the real API responses rather than on the route code.
    for (const detail of fixtures as unknown as Record<string, unknown>[]) {
      expect(Object.keys(detail)).not.toContain('groundTruth');
      expect(Object.keys(detail)).not.toContain('groundTruthRationale');
    }
  });

  it('renders no simulated outcome anywhere, in either component', () => {
    // Hard rule #6: a simulated outcome must never appear unlabelled, and the
    // simplest way to keep that true is that the UI has nowhere to put one.
    for (const detail of [drafted!, abstained!, submitted!]) {
      expect(work(detail)).not.toMatch(/\b(won|lost)\b/i);
      expect(bar(detail)).not.toMatch(/\b(won|lost)\b/i);
    }
  });
});

describe('the queue helpers', () => {
  it('formats rupees from subunits in the Indian numbering system', () => {
    expect(formatRupees(123456789)).toBe('₹12,34,567.89');
    expect(formatRupees(0)).toBe('₹0');
  });

  it('counts days to a deadline, and goes negative once it has passed', () => {
    const from = new Date(NOW).getTime();
    const soon = new Date(from + 2 * 86_400_000).toISOString();
    const past = new Date(from - 3 * 86_400_000).toISOString();
    expect(daysUntil(soon, NOW)).toBe(2);
    expect(daysUntil(past, NOW)).toBe(-3);
  });

  it('counts from the instant it is given, not from now (F-024)', () => {
    // The whole bug in one assertion. This deadline is in the past by the wall
    // clock and comfortably open against the corpus's own clock, and the only
    // difference between those two answers is which instant was passed in.
    const respondBy = '2026-07-28T00:00:00.000Z';
    expect(daysUntil(respondBy, NOW)).toBe(7);
    expect(daysUntil(respondBy, null)).toBeLessThan(0);
  });

  it('renders a corpus deadline as time remaining rather than as months overdue', () => {
    // The regression the reviewer actually sees. Every `respond_by` in the
    // corpus is a fixed offset from a seeded epoch, so against real time the
    // entire queue reads `Nd over` and the meter measures the corpus's age.
    const html = bar(drafted!);
    expect(html).toContain('d left');
    expect(html).not.toContain('d over');
  });
});
