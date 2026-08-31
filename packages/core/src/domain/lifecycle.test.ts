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
