/**
 * Rendering an instant for a person to read.
 *
 * Same reasoning as `money.ts`, and the same constraint: hand-rolled rather than
 * `toLocaleString`, because `Intl` output depends on the runtime's ICU data and
 * these strings are pinned by a snapshot test and rendered in a console beside
 * values formatted by the UI. Two formatters that agree on one machine and
 * disagree on another are worse than no formatter at all.
 *
 * Everything is UTC, deliberately. A dispute deadline read in the reviewer's
 * local zone is a different instant from the one the API recorded, and the
 * console already labels its clock as simulated -- adding a second unstated
 * transformation on top of that is how a reviewer ends up checking arithmetic
 * that cannot be checked.
 *
 * Audit-trail timestamps stay full ISO and are not passed through this. An
 * auditor wants the value that was written, not a prettier rendering of it.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `2026-06-09T22:05:00.000Z` -> `09 Jun 2026, 22:05 UTC`.
 *
 * The zone is written out because these strings sit in a rule trace a reviewer
 * is invited to re-derive by hand, next to a mandate window they are comparing
 * it against. An unlabelled wall time in a system whose clock is simulated is
 * exactly the ambiguity F-024 was about.
 *
 * An unparseable value is returned unchanged rather than rendered as
 * `Invalid Date`: the raw string is at least evidence of what was stored.
 */
export function formatInstant(iso: string | undefined): string {
  if (!iso) return 'not captured';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return (
    `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}
