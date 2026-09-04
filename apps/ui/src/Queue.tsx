import type { QueueItem } from './api.js';
import { Deadline, RailTag, StateBadge, formatRupees } from './ui.js';

export type Filter = 'all' | 'drafted' | 'abstained' | 'submitted';

export const FILTERS: readonly Filter[] = ['all', 'drafted', 'abstained', 'submitted'] as const;

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
  onFilter,
  onSelect,
}: {
  items: QueueItem[];
  counts: Record<string, number>;
  total: number;
  filter: Filter;
  selected: string | null;
  /** The instant deadlines count from; null means wall-clock time (F-024). */
  now: string | null;
  onFilter: (next: Filter) => void;
  onSelect: (externalId: string) => void;
}) {
  return (
    <div className="queue">
      <div className="queue-head">
        <div className="queue-title">
          <span className="label">Review queue</span>
          <span className="label">
            {items.length} of {total}
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
              <span className="qrow-top">
                <span className="qrow-id">{item.razorpayDisputeId}</span>
                <span className="qrow-amount">{formatRupees(item.amount)}</span>
              </span>
              <span className="qrow-bottom">
                <span className="qrow-what">
                  <RailTag rail={item.rail} /> {item.reasonCode} · {item.reasonDescription}
                </span>
              </span>
              <span className="qrow-bottom">
                <StateBadge state={item.state} />
                <Deadline respondBy={item.respondBy} now={now} />
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
