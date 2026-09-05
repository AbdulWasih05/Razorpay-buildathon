import { useCallback, useEffect, useState } from 'react';

import {
  approve,
  daysUntil,
  fetchDispute,
  fetchHealth,
  fetchQueue,
  releaseDispute,
  resetDemo,
  type DisputeDetail,
  type Health,
  type QueueItem,
} from './api.js';
import { DecisionBar } from './DecisionBar.js';
import { Detail } from './Detail.js';
import { Queue, type Filter } from './Queue.js';
import { Report } from './Report.js';
import { linkTo } from './router.js';
import { Mark, readableDate } from './ui.js';

/**
 * The review console (TASKS.md P3.3, redesigned).
 *
 * The layout is the argument. One viewport, three regions, no page scroll:
 *
 *   the simulated-data strip, which is never dismissible;
 *   the decision bar, which holds the dispute's identity, the gate's verdict
 *     and the single door that can submit -- and which cannot scroll away;
 *   the workspace, where a narrow queue spine sits beside the evidence the
 *     decision rests on.
 *
 * Three deliberate omissions, unchanged from the first build:
 *   - No ground truth. It exists in the corpus and would tell the reviewer the
 *     answer, which would make the review theatre.
 *   - No bulk approve. An approval authorises one dispute; a "select all"
 *     button is how one click becomes fifty submissions.
 *   - No simulated outcome anywhere (hard rule #6). The UI has nowhere to put
 *     one, which is the cheapest way to keep that true.
 */

const REVIEWERS = ['human:wasih', 'human:usman'];

/**
 * The console.
 *
 * `view` is a prop rather than state, and that is a bug fix rather than a style
 * preference. It was `useState(initialView)`, which seeds once and then ignores
 * the prop, so pressing back from `/eval` left the address bar saying `/app`
 * while the page still showed the eval report (FAILURES.md F-022).
 *
 * The route IS the view. There is now one place that knows which page is open,
 * and it is the URL.
 */
export function App({
  view,
  onView,
}: {
  view: 'queue' | 'metrics';
  onView: (next: 'queue' | 'metrics') => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [reviewer, setReviewer] = useState(REVIEWERS[0] as string);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [health, setHealth] = useState<Health | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(true);

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
    // The server decides whether this is a demo, not the UI. A banner the
    // front-end switches on for itself is a banner that can be wrong, and this
    // one is load-bearing for hard rule #6.
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    fetchDispute(selected)
      .then(setDetail)
      .catch((caught: Error) => setError(caught.message));
  }, [selected]);

  async function onDemo(action: 'release' | 'reset'): Promise<void> {
    setBusy(true);
    try {
      if (action === 'release') await releaseDispute();
      else await resetDemo();
      setSelected(null);
      setNotice(null);
      await reload();
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onApprove(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await approve(detail.externalId, reviewer);
      setError(null);
      await reload();
      setDetail(await fetchDispute(detail.externalId));
      // Inline, not `window.alert`. A modal dialog blocks the page until it is
      // dismissed, which makes the one action that matters the one thing a
      // screenshot, a screen recording or an automated click-through cannot get
      // past -- and it hides the state change it is announcing behind itself.
      setNotice(
        `Submitted via ${result.adapter}${result.simulated ? ' (simulated outcome)' : ''} ` +
          `with ${result.documentCount} document${result.documentCount === 1 ? '' : 's'}.`,
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visible = queue.filter((item) => filter === 'all' || item.state === filter);
  /*
    The abstained case to send a first-time reviewer to.

    Still computed from the queue rather than hardcoded, so it survives a reset
    or a reseed. What changed is which one: this was `find(state ===
    'abstained')` over a queue ordered by `respond_by` ascending, which means it
    always named the MOST OVERDUE abstention -- the reviewer was pointed at a
    case fifteen days past its deadline and told to start there. Now it prefers
    the soonest abstention still inside its window, and falls back to the plain
    soonest only if every abstention has passed. Same rule, one condition added;
    nothing is reordered and nothing is hidden.
  */
  const abstained = queue.filter((item) => item.state === 'abstained');
  const live = abstained.find((item) => daysUntil(item.respondBy, health?.simulatedNow ?? null) >= 0);
  const spotlightId = (live ?? abstained[0])?.externalId ?? null;
  const counts = queue.reduce<Record<string, number>>((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1;
    return acc;
  }, {});

  /*
    Open on the spotlighted case instead of on an empty workspace.

    The console's first frame was a queue beside a blank pane -- about seventy
    percent of the viewport white, with "Nothing selected" as its only content
    -- which is a poor first thirty seconds for a reviewer and a worse one for a
    judge. Selecting a dispute is a read: it fetches a detail, it changes no
    state, it writes no audit row, and it is not the door. So the console can
    open on one.

    `opened` guards it rather than `selected === null`, so this fires once for
    the session. Without that, a reviewer who deliberately clears a selection
    would be dragged straight back to the spotlight, and the effect would fight
    them every time the queue reloaded after an approval.
  */
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (opened || selected !== null || spotlightId === null) return;
    setSelected(spotlightId);
    setOpened(true);
  }, [opened, selected, spotlightId]);

  return (
    <div className="app">
      {health?.demoMode ? (
        <DemoStrip busy={busy} onRelease={() => void onDemo('release')} onReset={() => void onDemo('reset')} />
      ) : null}

      <ViewBar
        view={view}
        reviewer={reviewer}
        onView={onView}
        onReviewer={setReviewer}
        assemblyMode={health?.assemblyMode ?? null}
        simulatedNow={health?.simulatedNow ?? null}
      />

      {view === 'metrics' ? (
        <div className="reportwrap">
          <Report />
        </div>
      ) : (
        <>
          <DecisionBar
            detail={detail}
            busy={busy}
            reviewer={reviewer}
            now={health?.simulatedNow ?? null}
            onApprove={() => void onApprove()}
          />

          {error || notice ? (
            <div className="flash">
              {error ? <p className="error">{error}</p> : null}
              {notice ? <p className="notice">{notice}</p> : null}
            </div>
          ) : null}

          <div className={queueOpen ? 'workspace' : 'workspace queue-collapsed'}>
            <Queue
              items={visible}
              counts={counts}
              total={queue.length}
              filter={filter}
              selected={selected}
              now={health?.simulatedNow ?? null}
              open={queueOpen}
              spotlightId={spotlightId}
              onFilter={setFilter}
              onSelect={setSelected}
              onToggle={() => setQueueOpen((open) => !open)}
            />
            {detail ? (
              <Detail detail={detail} now={health?.simulatedNow ?? null} />
            ) : (
              <div className="work-empty">
                <h2>Nothing selected</h2>
                <p>
                  Pick a dispute from the queue to see the evidence it stands on, the rules the
                  gate evaluated, and the drafted contest where one exists.
                </p>
                <p>
                  Disputes are ordered by <code>respond_by</code>, soonest first. That ordering
                  is a property of the queue, not a view preference, so there is nothing here to
                  sort it away.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The top bar: what this is, which page, and who is reviewing.
 *
 * The reviewer selector lives here rather than beside the approve button on
 * purpose. Choosing who you are is a session-level act; doing it inches from the
 * control that submits invites choosing it in the same motion as approving.
 */
export function ViewBar({
  view,
  reviewer,
  onView,
  onReviewer,
  assemblyMode,
  simulatedNow,
}: {
  view: 'queue' | 'metrics';
  reviewer: string;
  onView: (next: 'queue' | 'metrics') => void;
  onReviewer: (next: string) => void;
  assemblyMode: 'live' | 'replay' | null;
  simulatedNow: string | null;
}) {
  return (
    <div className="viewbar">
      <a className="brand" {...linkTo('landing')} title="Back to the overview">
        <Mark />
        Praman
        <span className="thin">dispute evidence responder · defense only</span>
      </a>

      <button className={view === 'queue' ? 'chip on' : 'chip'} onClick={() => onView('queue')}>
        review queue
      </button>
      <button
        className={view === 'metrics' ? 'chip on' : 'chip'}
        onClick={() => onView('metrics')}
      >
        eval results
      </button>

      <span className="spacer" />

      {assemblyMode ? (
        <span className="label" title="Whether model calls are live or replayed from committed fixtures.">
          assembly: {assemblyMode}
        </span>
      ) : null}

      {/*
        The clock is part of the simulation, so it is labelled like the rest of
        it (hard rule #6). Every deadline on screen counts from this instant
        rather than from now, because every `respond_by` in the corpus is a fixed
        offset from a seeded epoch and reading them against real time measures
        the corpus's age instead of a reviewer's urgency (F-024).
      */}
      {simulatedNow ? (
        <span
          className="label"
          title={`Deadlines count from ${readableDate(simulatedNow)}, not from now. The corpus is seeded from a fixed epoch, so its clock is simulated too.`}
        >
          clock: simulated
        </span>
      ) : null}

      <label>
        reviewer
        <select value={reviewer} onChange={(event) => onReviewer(event.target.value)}>
          {REVIEWERS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The simulated-data strip (hard rule #6).
 *
 * It replaced a loud amber block, and the change is not cosmetic. A block that
 * shouts reads as an error state and gets dismissed by the eye after the first
 * screen; a permanent strip is in every screenshot, every frame of the demo
 * video and every scroll position. "Labelled wherever it is rendered" is a
 * property of the layout now, not of the reader's attention.
 *
 * It says three things a visitor would otherwise assume wrongly: this data is
 * simulated, the trigger writes to a shared instance, and there is a reset.
 */
export function DemoStrip({
  busy,
  onRelease,
  onReset,
}: {
  busy: boolean;
  onRelease: () => void;
  onReset: () => void;
}) {
  return (
    <div className="strip">
      <p>
        <b>SIMULATED</b> Seeded simulator data. No live Razorpay call is ever made. This instance
        is shared: what you release, the next visitor sees.
      </p>
      <span className="strip-actions">
        <button disabled={busy} onClick={onRelease}>
          release next dispute
        </button>
        <button disabled={busy} onClick={onReset}>
          reset
        </button>
      </span>
    </div>
  );
}
