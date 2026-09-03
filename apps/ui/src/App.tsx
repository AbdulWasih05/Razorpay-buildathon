import { useCallback, useEffect, useState } from 'react';

import {
  approve,
  daysUntil,
  fetchDispute,
  fetchQueue,
  formatRupees,
  type DisputeDetail,
  type QueueItem,
} from './api.js';
import { Report } from './Report.js';
import './styles.css';

/**
 * The review UI (TASKS.md P3.3).
 *
 * Plain functional table, per CLAUDE.md §4: clarity over polish. A reviewer
 * needs to see what the system decided, why, and what evidence it is standing
 * on -- and then approve or leave it. Anything else is decoration on a screen
 * whose whole job is making a money decision legible.
 *
 * Three deliberate omissions:
 *   - No ground truth. It exists in the corpus and would tell the reviewer the
 *     answer, which would make the review theatre.
 *   - No bulk approve. An approval authorises one dispute; a "select all"
 *     button is how one click becomes fifty submissions.
 *   - No simulated won/lost anywhere (hard rule #6).
 */

const REVIEWERS = ['human:wasih', 'human:usman'];

export function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [reviewer, setReviewer] = useState(REVIEWERS[0] as string);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'drafted' | 'abstained' | 'submitted'>('all');
  const [view, setView] = useState<'queue' | 'metrics'>('queue');

  const reload = useCallback(async () => {
    try {
      setQueue(await fetchQueue());
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    fetchDispute(selected)
      .then(setDetail)
      .catch((caught: Error) => setError(caught.message));
  }, [selected]);

  async function onApprove(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await approve(detail.externalId, reviewer);
      setError(null);
      await reload();
      setDetail(await fetchDispute(detail.externalId));
      window.alert(
        `Submitted via ${result.adapter}${result.simulated ? ' (simulated)' : ''} with ${result.documentCount} documents.`,
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visible = queue.filter((item) => filter === 'all' || item.state === filter);
  const counts = queue.reduce<Record<string, number>>((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1;
    return acc;
  }, {});

  if (view === 'metrics') {
    return (
      <main>
        <header>
          <h1>Praman — eval results</h1>
          <p className="sub">
            This page renders <code>eval/results.md</code> verbatim and computes nothing of its
            own, so it cannot disagree with the report (P4.2).
          </p>
        </header>
        <nav className="toolbar">
          <button className="chip" onClick={() => setView('queue')}>
            ← back to the review queue
          </button>
        </nav>
        <Report />
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>Praman — dispute review</h1>
        <p className="sub">
          Defense-only. Nothing is submitted without a named reviewer approving this specific
          dispute.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="toolbar">
        <label>
          Reviewer{' '}
          <select value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
            {REVIEWERS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="chip" onClick={() => setView('metrics')}>
          eval results
        </button>
        <span className="counts">
          {(['all', 'drafted', 'abstained', 'submitted'] as const).map((key) => (
            <button
              key={key}
              className={filter === key ? 'chip on' : 'chip'}
              onClick={() => setFilter(key)}
            >
              {key} {key === 'all' ? queue.length : (counts[key] ?? 0)}
            </button>
          ))}
        </span>
      </section>

      <div className="split">
        <table>
          <thead>
            <tr>
              <th>dispute</th>
              <th>rail</th>
              <th>code</th>
              <th className="num">amount</th>
              <th className="num">respond by</th>
              <th>decision</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const days = daysUntil(item.respondBy);
              return (
                <tr
                  key={item.externalId}
                  className={selected === item.externalId ? 'row on' : 'row'}
                  onClick={() => setSelected(item.externalId)}
                >
                  <td>
                    <code>{item.razorpayDisputeId}</code>
                    <div className="muted">{item.reasonDescription}</div>
                  </td>
                  <td>{item.rail}</td>
                  <td>{item.reasonCode}</td>
                  <td className="num">{formatRupees(item.amount)}</td>
                  <td className={days < 3 ? 'num urgent' : 'num'}>{days}d</td>
                  <td>
                    <StateBadge state={item.state} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <aside>
          {!detail ? (
            <p className="muted">Select a dispute.</p>
          ) : (
            <Detail
              detail={detail}
              busy={busy}
              reviewer={reviewer}
              onApprove={() => void onApprove()}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state}</span>;
}

export function Detail({
  detail,
  busy,
  reviewer,
  onApprove,
}: {
  detail: DisputeDetail;
  busy: boolean;
  reviewer: string;
  onApprove: () => void;
}) {
  return (
    <div>
      <h2>
        <code>{detail.disputeId}</code> <StateBadge state={detail.state} />
      </h2>
      <p className="muted">
        {detail.scenarioLabel} · {detail.rail} · reason {detail.reasonCode} · {detail.phase} ·{' '}
        {formatRupees(detail.amount)}
      </p>

      <h3>Gate</h3>
      <p>
        <strong>{detail.gateDecision ?? 'not run'}</strong>
        {detail.gateReason ? <span className="reason"> — {detail.gateReason}</span> : null}
      </p>
      {detail.abstentionClass ? (
        <p className="muted">
          abstention class: <code>{detail.abstentionClass}</code>
        </p>
      ) : null}

      <h3>Evidence</h3>
      {detail.collected ? (
        <table className="inner">
          <tbody>
            {detail.collected.findings.map((finding) => (
              <tr key={finding.artifact}>
                <td>
                  <code>{finding.artifact}</code>
                  {finding.necessity === 'supporting' ? (
                    <span className="muted"> (supporting)</span>
                  ) : null}
                </td>
                <td>
                  <span className={`badge ${finding.state}`}>{finding.state}</span>
                </td>
                <td className="muted">{finding.reason ?? finding.references.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">not collected</p>
      )}

      {detail.draft ? (
        <>
          <h3>Drafted explanation ({detail.draft.summary.length}/1000 chars)</h3>
          <blockquote>{detail.draft.summary}</blockquote>
          <p className="muted">
            fields:{' '}
            {detail.draft.assignments.map((assignment) => assignment.field).join(', ')}
          </p>
        </>
      ) : null}

      <h3>Audit trail</h3>
      <pre>{detail.timeline.join('\n')}</pre>

      {detail.state === 'drafted' ? (
        <div className="approve">
          <button disabled={busy} onClick={onApprove}>
            {busy ? 'Submitting…' : `Approve and submit as ${reviewer}`}
          </button>
          <p className="muted">
            This is the only action in the product that submits. It authorises this dispute
            only.
          </p>
        </div>
      ) : detail.state === 'submitted' ? (
        <p className="muted">
          Submitted. Approved by <code>{detail.approvedBy}</code>.
        </p>
      ) : (
        <p className="muted">Nothing to approve: this dispute was not contested.</p>
      )}
    </div>
  );
}
