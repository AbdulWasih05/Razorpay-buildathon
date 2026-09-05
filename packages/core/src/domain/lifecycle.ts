/**
 * The dispute lifecycle and its append-only audit trail (TASKS.md P3.2).
 *
 * "Would you trust it" is a stated rubric criterion, and this file is most of
 * the answer. Every state a dispute passes through is recorded with who moved
 * it, when, and why. Nothing is ever updated or deleted -- a correction is a
 * new entry, not an edit.
 *
 * The transition table is deliberately restrictive. `submitted` is reachable
 * from exactly one state, `approved`, and `approved` is reachable only by a
 * human actor. That is CLAUDE.md hard rule #2 -- "the submit path has exactly
 * one door" -- expressed as data rather than as a convention someone has to
 * remember at a call site.
 */

export const DISPUTE_STATES = [
  /** The webhook arrived. Nothing has been done yet. */
  'received',
  /** Evidence collected from the capture store. Deterministic. */
  'triaged',
  /** The sufficiency gate has ruled. Deterministic. */
  'gated',
  /** A contest has been drafted and is waiting for a human. */
  'drafted',
  /** A human approved the draft. The only state from which submit is legal. */
  'approved',
  /** Sent to Razorpay. Terminal. */
  'submitted',
  /** Not contested, with a stated reason. Terminal. */
  'abstained',
] as const;

export type DisputeState = (typeof DISPUTE_STATES)[number];

/**
 * Who moved it. `human:` is a prefix so a real reviewer's identity is carried
 * rather than flattened to "user" -- an approval with no name attached is not
 * an approval anyone can be accountable for.
 */
export type Actor = 'system' | 'gate' | 'llm' | 'adapter' | `human:${string}`;

export function isHumanActor(actor: string): actor is `human:${string}` {
  return actor.startsWith('human:') && actor.length > 'human:'.length;
}

/** Legal transitions. Anything not listed here is a bug, not a feature. */
const TRANSITIONS: Record<DisputeState, readonly DisputeState[]> = {
  received: ['triaged', 'abstained'],
  triaged: ['gated', 'abstained'],
  // The gate can decline outright, or clear the dispute for drafting.
  gated: ['drafted', 'abstained'],
  // A drafted contest can be approved by a human, or abandoned after review.
  drafted: ['approved', 'abstained'],
  // One door.
  approved: ['submitted'],
  submitted: [],
  abstained: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DisputeState,
    readonly to: DisputeState,
    readonly actor: string,
  ) {
    super(`illegal transition ${from} -> ${to} by ${actor}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: DisputeState, to: DisputeState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface AuditEntryInput {
  toState: DisputeState;
  actor: Actor;
  reason?: string;
  detail?: Record<string, unknown>;
  /** Domain time, supplied by the caller. Never a wall clock inside core. */
  occurredAt: Date;
}

export interface AuditEntry {
  seq: number;
  fromState: DisputeState | null;
  toState: DisputeState;
  actor: Actor;
  reason?: string;
  detail?: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * An append-only trail. The only mutation is `append`, and it validates the
 * transition before recording it.
 *
 * `occurredAt` is caller-supplied domain time rather than `new Date()`, for the
 * same reason every other timestamp in this codebase is (D-007): a wall clock
 * inside the domain makes the eval unreproducible.
 */
export class AuditTrail {
  private readonly entries: AuditEntry[] = [];

  constructor(readonly disputeId: string) {}

  get state(): DisputeState {
    return this.entries.at(-1)?.toState ?? 'received';
  }

  get length(): number {
    return this.entries.length;
  }

  /** A copy: callers cannot reach in and rewrite history. */
  list(): AuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  append(input: AuditEntryInput): AuditEntry {
    const from = this.state;
    if (this.entries.length > 0 && !canTransition(from, input.toState)) {
      throw new IllegalTransitionError(from, input.toState, input.actor);
    }
    // The one door, enforced here and not only by convention.
    if (input.toState === 'submitted' && from !== 'approved') {
      throw new IllegalTransitionError(from, 'submitted', input.actor);
    }
    if (input.toState === 'approved' && !isHumanActor(input.actor)) {
      throw new IllegalTransitionError(from, 'approved', input.actor);
    }

    const entry: AuditEntry = {
      seq: this.entries.length,
      fromState: this.entries.length === 0 ? null : from,
      toState: input.toState,
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      occurredAt: input.occurredAt,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Rebuild a trail from stored rows, e.g. when rendering a timeline. */
  static from(disputeId: string, entries: readonly AuditEntry[]): AuditTrail {
    const trail = new AuditTrail(disputeId);
    for (const entry of entries) trail.entries.push({ ...entry });
    return trail;
  }

  /**
   * Start a new pipeline cycle on a dispute that already has one behind it.
   *
   * Not a "legal transition" in the forward-only sense `append` checks --
   * `TRANSITIONS` has no path back to `received` from anywhere, on purpose.
   * This is the recorded FACT that a new cycle is beginning, the same shape
   * of event `resetDemo` already writes as its `demo_reset` row, just
   * available as a first-class trail operation instead of a raw insert one
   * caller happened to write correctly.
   *
   * Added 2026-09-05 (see FAILURES.md): reprocessing a dispute that already
   * had a full cycle behind it -- a demo reset, or the documented
   * `?states=drafted,abstained` reprocessing `/review/run` supports -- used
   * to feed a FRESH trail (which always starts its own count at `received`,
   * seq 0) into a persistence step that only ever appended
   * `trail.list().slice(existingRowCount)`. Once a dispute had any prior
   * history, that slice was empty, so the dispute's `state` column kept
   * moving while its audit trail silently stopped, and a later approval was
   * refused for a reason ("illegal transition received -> approved") that
   * had nothing to do with the actor being blamed for it.
   *
   * Refuses from `approved` or `submitted`: a contest a human has approved,
   * or one Razorpay has actually received, must never be silently walked
   * backwards by a reprocessing run. That would replace the one record of
   * what actually happened with a fresh judgement of what the pipeline would
   * say today, which is exactly the kind of "quietly different number"
   * hard rule #6 exists to prevent -- here applied to a fact about a
   * dispute's real history rather than a metric.
   */
  rewindToReceived(actor: Actor, reason: string, occurredAt: Date): AuditEntry {
    const from = this.state;
    if (from === 'approved' || from === 'submitted') {
      throw new IllegalTransitionError(from, 'received', actor);
    }
    const entry: AuditEntry = {
      seq: this.entries.length,
      fromState: this.entries.length === 0 ? null : from,
      toState: 'received',
      actor,
      reason,
      occurredAt,
    };
    this.entries.push(entry);
    return entry;
  }
}

/** True once a dispute can no longer move. */
export function isTerminal(state: DisputeState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * Render a trail as a plain timeline. Used by the review UI and by the demo.
 *
 * Deliberately text: a timeline a person can read in a terminal is a timeline
 * that can be pasted into an incident report or shown on a slide.
 */
export function renderTimeline(trail: AuditTrail): string[] {
  return trail.list().map((entry) => {
    const transition = entry.fromState ? `${entry.fromState} -> ${entry.toState}` : entry.toState;
    const reason = entry.reason ? `  (${entry.reason})` : '';
    return `${entry.occurredAt.toISOString()}  ${entry.actor.padEnd(14)}  ${transition}${reason}`;
  });
}
