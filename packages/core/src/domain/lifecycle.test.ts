import { describe, expect, it } from 'vitest';

import {
  AuditTrail,
  DISPUTE_STATES,
  IllegalTransitionError,
  canTransition,
  isHumanActor,
  isTerminal,
  renderTimeline,
} from './lifecycle.js';

/**
 * TASKS.md P3.2 acceptance: "audit trail for any dispute renders as a complete
 * timeline".
 *
 * The transitions carry CLAUDE.md hard rule #2 -- one door to submit -- so most
 * of these tests are about what the lifecycle REFUSES to do.
 */

const T = (minutes: number) => new Date(Date.UTC(2026, 5, 1, 12, minutes, 0));

function contestedToApproval(): AuditTrail {
  const trail = new AuditTrail('disp_Lifecycle');
  trail.append({ toState: 'received', actor: 'system', occurredAt: T(0) });
  trail.append({ toState: 'triaged', actor: 'system', occurredAt: T(1) });
  trail.append({ toState: 'gated', actor: 'gate', reason: 'all rules passed', occurredAt: T(2) });
  trail.append({ toState: 'drafted', actor: 'llm', occurredAt: T(3) });
  return trail;
}

describe('the happy path', () => {
  it('walks received -> triaged -> gated -> drafted -> approved -> submitted', () => {
    const trail = contestedToApproval();
    trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) });
    trail.append({ toState: 'submitted', actor: 'adapter', occurredAt: T(5) });

    expect(trail.state).toBe('submitted');
    expect(trail.list().map((entry) => entry.toState)).toEqual([
      'received',
      'triaged',
      'gated',
      'drafted',
      'approved',
      'submitted',
    ]);
  });

  it('numbers entries from zero and records where each came from', () => {
    const trail = contestedToApproval();
    const entries = trail.list();
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(entries[0]?.fromState).toBeNull();
    expect(entries[3]?.fromState).toBe('gated');
  });

  it('renders a complete timeline a person can read', () => {
    const trail = contestedToApproval();
    trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) });
    const lines = renderTimeline(trail);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('gate');
    expect(lines[2]).toContain('triaged -> gated');
    expect(lines[2]).toContain('all rules passed');
    expect(lines[4]).toContain('human:wasih');
  });
});

describe('the one door to submit', () => {
  it('refuses to submit from anything but approved', () => {
    const trail = contestedToApproval();
    expect(() =>
      trail.append({ toState: 'submitted', actor: 'adapter', occurredAt: T(4) }),
    ).toThrow(IllegalTransitionError);
  });

  it('refuses to approve unless a human did it', () => {
    // Hard rule #2 as data: no system actor can produce the state that submit
    // requires, so there is no code path that submits without a person.
    const trail = contestedToApproval();
    for (const actor of ['system', 'gate', 'llm', 'adapter'] as const) {
      expect(() => trail.append({ toState: 'approved', actor, occurredAt: T(4) })).toThrow(
        IllegalTransitionError,
      );
    }
    expect(() =>
      trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) }),
    ).not.toThrow();
  });

  it('records who approved, not merely that someone did', () => {
    const trail = contestedToApproval();
    const entry = trail.append({ toState: 'approved', actor: 'human:reviewer-2', occurredAt: T(4) });
    expect(entry.actor).toBe('human:reviewer-2');
    expect(isHumanActor(entry.actor)).toBe(true);
    expect(isHumanActor('human:')).toBe(false);
  });

  it('has exactly one state that can reach submitted', () => {
    const canReach = DISPUTE_STATES.filter((state) => canTransition(state, 'submitted'));
    expect(canReach).toEqual(['approved']);
  });
});

describe('the trail is append-only', () => {
  it('does not let a caller rewrite history through the returned list', () => {
    const trail = contestedToApproval();
    const stolen = trail.list();
    stolen[0]!.toState = 'submitted';
    stolen.push({
      seq: 99,
      fromState: null,
      toState: 'submitted',
      actor: 'system',
      occurredAt: T(9),
    });
    expect(trail.list()[0]?.toState).toBe('received');
    expect(trail.length).toBe(4);
  });

  it('refuses illegal transitions and names both ends', () => {
    const trail = new AuditTrail('disp_X');
    trail.append({ toState: 'received', actor: 'system', occurredAt: T(0) });
    try {
      trail.append({ toState: 'drafted', actor: 'llm', occurredAt: T(1) });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe('received');
      expect((error as IllegalTransitionError).to).toBe('drafted');
    }
  });

  it('cannot move a terminal dispute', () => {
    const trail = new AuditTrail('disp_Y');
    trail.append({ toState: 'received', actor: 'system', occurredAt: T(0) });
    trail.append({ toState: 'abstained', actor: 'gate', reason: 'no evidence', occurredAt: T(1) });
    expect(isTerminal('abstained')).toBe(true);
    expect(() => trail.append({ toState: 'triaged', actor: 'system', occurredAt: T(2) })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('abstention is reachable from every non-terminal state', () => {
  it('so a dispute can always stop, whatever went wrong', () => {
    for (const state of DISPUTE_STATES) {
      if (isTerminal(state) || state === 'approved') continue;
      expect(canTransition(state, 'abstained'), state).toBe(true);
    }
  });

  it('but an approved dispute cannot silently become an abstention', () => {
    // Once a human has approved, the only forward move is submission. Quietly
    // dropping an approved contest would lose a decision someone made.
    expect(canTransition('approved', 'abstained')).toBe(false);
  });
});

describe('reconstruction from stored rows', () => {
  it('restores state and sequence', () => {
    const original = contestedToApproval();
    const restored = AuditTrail.from('disp_Lifecycle', original.list());
    expect(restored.state).toBe('drafted');
    expect(restored.length).toBe(4);
    expect(renderTimeline(restored)).toEqual(renderTimeline(original));
  });

  it('continues appending correctly after restoration', () => {
    const restored = AuditTrail.from('disp_Lifecycle', contestedToApproval().list());
    const entry = restored.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) });
    expect(entry.seq).toBe(4);
    expect(entry.fromState).toBe('drafted');
  });
});

describe('starting a new cycle on a dispute that already has one (2026-09-05 fix)', () => {
  // Found live: reprocessing a dispute after a demo reset (or, identically,
  // via the documented `?states=drafted,abstained` reprocessing `/review/run`
  // supports) left `dispute.state` at "drafted" while the persisted trail
  // still ended at the reset's own row -- because the fresh trail
  // `processDispute` builds always starts at seq 0, and the old
  // count-based `slice(existingRowCount)` diffing silently dropped
  // everything once a dispute had ANY prior history. A real approval was
  // then refused with "illegal transition received -> approved", blaming the
  // actor for a desync that was never about the actor.

  it('appends a rewind row, then continues seq numbering rather than restarting at 0', () => {
    const trail = contestedToApproval(); // received, triaged, gated, drafted -- seq 0..3
    expect(trail.state).toBe('drafted');

    const rewind = trail.rewindToReceived('system', 're-run: capture gap closed', T(10));
    expect(rewind.seq).toBe(4);
    expect(rewind.fromState).toBe('drafted');
    expect(rewind.toState).toBe('received');
    expect(trail.state).toBe('received');

    // The second cycle continues from seq 5, not seq 0 -- this is the entire
    // fix. The old bug's shape was indistinguishable from silence: no error,
    // just rows that were never written.
    const second = trail.append({ toState: 'triaged', actor: 'system', occurredAt: T(11) });
    expect(second.seq).toBe(5);
    expect(second.fromState).toBe('received');
    expect(trail.length).toBe(6);
  });

  it('reproduces the exact live sequence and shows a real human can approve afterwards', () => {
    // 1. A dispute goes through a full cycle and lands at `drafted`.
    const trail = contestedToApproval();
    // 2. A demo reset (or a reprocessing run) rewinds it.
    trail.rewindToReceived('system', 'demo reset requested', T(10));
    // 3. It is reprocessed: triaged -> gated -> drafted again, seq continuing.
    trail.append({ toState: 'triaged', actor: 'system', occurredAt: T(11) });
    trail.append({ toState: 'gated', actor: 'gate', reason: 'all rules passed', occurredAt: T(12) });
    trail.append({ toState: 'drafted', actor: 'llm', occurredAt: T(13) });
    expect(trail.state).toBe('drafted');
    expect(trail.length).toBe(8); // 4 from the first cycle + rewind + 3 from the second

    // 4. This is the assertion that was failing live: a real human CAN now
    // approve it, because the trail's state genuinely reflects `drafted`
    // rather than being stuck at the reset's `received` row.
    const approval = trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(14) });
    expect(approval.fromState).toBe('drafted');
    expect(trail.state).toBe('approved');
  });

  it('refuses to rewind an approved dispute', () => {
    const trail = contestedToApproval();
    trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) });
    expect(() => trail.rewindToReceived('system', 're-run', T(5))).toThrow(IllegalTransitionError);
  });

  it('refuses to rewind a submitted dispute', () => {
    const trail = contestedToApproval();
    trail.append({ toState: 'approved', actor: 'human:wasih', occurredAt: T(4) });
    trail.append({ toState: 'submitted', actor: 'adapter', occurredAt: T(5) });
    expect(() => trail.rewindToReceived('system', 're-run', T(6))).toThrow(IllegalTransitionError);
  });

  it('is a no-op concern on a fresh dispute: never called when already at received', () => {
    // Documented via the guard in `runPipeline` (`trail.length > 0 && trail.state
    // !== 'received'`) rather than in this class -- a brand-new dispute's
    // first cycle should never call rewindToReceived at all. This test pins
    // that rewinding FROM received, while not something the caller should do,
    // does not corrupt seq numbering if it ever happened.
    const trail = new AuditTrail('disp_fresh');
    const entry = trail.rewindToReceived('system', 'no-op', T(0));
    expect(entry.seq).toBe(0);
    expect(entry.fromState).toBeNull();
    expect(trail.state).toBe('received');
  });
});
