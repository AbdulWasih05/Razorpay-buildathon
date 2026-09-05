import type { QueueItem } from './api.js';
import { Deadline, RailTag, StateBadge, formatRupees } from './ui.js';

export type Filter = 'all' | 'received' | 'drafted' | 'abstained' | 'submitted';

/**
 * `received` is here because the demo can create one and nothing could reach it.
 * "Release next dispute" puts a dispute in `received`, which appeared under
 * `all` and under no filter of its own -- so the one state a visitor can
 * actually cause was the one the queue could not show them on its own.
 */
export const FILTERS: readonly Filter[] = [
  'all',
  'received',
  'drafted',
  'abstained',
  'submitted',
] as const;

/**
 * `disp_SIMedC3oB4ZSps` -> `disp_SIMedC3o…`.
 *
 * The narrow rail truncates with CSS ellipsis too, but that cuts wherever the
 * container happens to run out of width -- sometimes mid-`SIM`, which is the
 * one substring hard rule #6 needs a reviewer to actually see. Truncating in
 * JS to a fixed point past the marker keeps it intact at every rail width;
 * the full id still lives in `title` for anyone who needs to read all of it.
 */
function truncateId(id: string): string {
  const marker = id.indexOf('SIM');
  if (marker === -1) return id.length > 16 ? `${id.slice(0, 16)}…` : id;
  const cut = marker + 'SIM'.length + 5;
  return id.length > cut ? `${id.slice(0, cut)}…` : id;
}

/**
 * The queue spine.
 *
 * Rows, not a six-column table. The old table gave dispute id, rail, code,
 * amount, deadline and decision equal weight and made the reviewer scan
 * sideways across all six to place one dispute. A row here answers two questions
 * in two lines -- what is this, and what did the system decide -- and the whole
 * row is one target.
 *
 * Ordering is the API's (`respond_by` ascending) and is not re-sorted here.
 * The most urgent dispute being first is a property of the queue, not a view
 * preference, and a UI that lets you sort it away is a UI that lets you miss a
 * deadline.
 *
 * There is deliberately no select-all and no bulk approve. An approval
 * authorises one dispute; a checkbox column is how one click becomes fifty
 * submissions.
 */
export function Queue({
  items,
  counts,
  total,
  filter,
  selected,
  now,
  open,
  spotlightId,
  onFilter,
  onSelect,
  onToggle,
}: {
  items: QueueItem[];
  counts: Record<string, number>;
  total: number;
  filter: Filter;
  selected: string | null;
  /** The instant deadlines count from; null means wall-clock time (F-024). */
  now: string | null;
  /** Whether the rail is expanded. Collapsing it is a reader's choice, not a
   *  narrower default -- the queue stays at its full width open, and folds
   *  down to a strip that names what it is hiding rather than vanishing. */
  open: boolean;
  /** externalId of the soonest-deadline abstained case, or null. Marked
   *  "start here" so a reviewer skimming for the first time can find the
   *  honest-refusal example without scanning the whole queue. */
  spotlightId: string | null;
  onFilter: (next: Filter) => void;
  onSelect: (externalId: string) => void;
  onToggle: () => void;
}) {
  if (!open) {
    return (
      <div className="queue queue-closed">
        <button className="queue-reopen" onClick={onToggle} title="Open the review queue">
          <span className="queue-reopen-label">Queue</span>
          <span className="label">{total}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="queue">
      <div className="queue-head">
        <div className="queue-title">
          <span className="label">Review queue</span>
          <span className="queue-title-right">
            <span className="label">
              {items.length} of {total}
            </span>
            <button className="queue-toggle" onClick={onToggle} title="Collapse the review queue">
              ‹
            </button>
          </span>
        </div>
        <div className="filters">
          {FILTERS.map((key) => (
            <button
              key={key}
              className={filter === key ? 'chip on' : 'chip'}
              aria-pressed={filter === key}
              onClick={() => onFilter(key)}
            >
              {key}
              <span className="n">{key === 'all' ? total : (counts[key] ?? 0)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="queue-list">
        {items.length === 0 ? (
          <p className="queue-empty">
            No disputes in <code>{filter}</code>.
          </p>
        ) : (
          items.map((item) => (
            <button
              key={item.externalId}
              className={selected === item.externalId ? 'qrow on' : 'qrow'}
              aria-current={selected === item.externalId}
              onClick={() => onSelect(item.externalId)}
            >
              {item.externalId === spotlightId ? (
                <span
                  className="qrow-spotlight"
                  title="Abstained with a stated reason -- the honest-refusal case"
                >
                  start here
                </span>
              ) : null}
              <span className="qrow-top">
                <span className="qrow-id" title={item.razorpayDisputeId}>
                  {truncateId(item.razorpayDisputeId)}
                </span>
                <span className="qrow-amount">{formatRupees(item.amount)}</span>
              </span>
              <span className="qrow-what">
                <RailTag rail={item.rail} /> {item.reasonCode} · {item.reasonDescription}
              </span>
              <span className="qrow-bottom">
                <StateBadge state={item.state} />
                <Deadline respondBy={item.respondBy} now={now} bare />
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
