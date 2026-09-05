import type { DisputeDetail } from './api.js';
import { Deadline, RailTag, StateBadge, formatRupees } from './ui.js';

/**
 * The decision bar (CLAUDE.md hard rule #2, made visible).
 *
 * The product's central claim is that the submit path has exactly one door. In
 * the first UI that door was a button at the bottom of a scrolling panel, so the
 * claim was true in the code and invisible on screen. Here the three things an
 * approval commits you to -- which dispute, how much, and what the gate decided
 * -- sit in the same never-scrolling bar as the button that commits them. You
 * cannot be reading evidence without also seeing what approving it would do.
 *
 * The button appears in exactly one state, `drafted`, and it names the reviewer
 * on its own face. Both of those are the UI half of the invariant: a control
 * that can approve an abstention is a second door however well the server is
 * guarded, and an approval made by an unnamed "you" is not an approval.
 */
export function DecisionBar({
  detail,
  busy,
  reviewer,
  now,
  onApprove,
}: {
  detail: DisputeDetail | null;
  busy: boolean;
  reviewer: string;
  /** The instant deadlines count from; null means wall-clock time (F-024). */
  now: string | null;
  onApprove: () => void;
}) {
  if (!detail) {
    return (
      <div className="decision empty">
        Select a dispute from the queue. Nothing is drafted, approved or submitted until you
        choose one.
      </div>
    );
  }

  const decision = detail.gateDecision ?? 'none';

  /*
    The clause under the verdict, and where it comes from.

    It used to be `gateReason` -- the string written into the row when the
    dispute was gated. That is the right thing to KEEP (it is the audit record,
    and the trail below still shows it verbatim) and the wrong thing to display
    here, because it is a snapshot of how the gate phrased itself at seed time.
    After F-029 reformatted money and instants, seeded rows still read `charged
    252900, which exceeds the 204588 mandate cap` while the replayed rule trace
    three hundred pixels below said `charged ₹2,529, which exceeds the ₹2,045.88
    mandate cap`. One fact, two renderings, on one screen -- the exact defect
    F-029 is about, reintroduced by a stale column.

    So the clause is now built from the SAME replayed trace the panel below
    renders: the failing rules, joined the way the gate itself joins them. The
    two cannot drift again because there is only one source.

    The exception is deliberate. If the replay DISAGREES with the recorded
    decision, the recorded one is authoritative and the replay is suspect, so the
    bar falls back to the stored reason and the trace panel raises its own loud
    error. A disagreement is not an occasion to prefer the newer computation.
  */
  const trace = detail.gateRules;
  const replayed =
    trace && trace.agrees
      ? trace.rules.filter((rule) => !rule.passed).map((rule) => rule.detail).join('; ')
      : '';

  return (
    <div className="decision">
      <div>
        <div className="identity">
          <span className="id">{detail.disputeId}</span>
          <RailTag rail={detail.rail} />
          <span className="amount">{formatRupees(detail.amount)}</span>
          <Deadline respondBy={detail.respondBy} now={now} />
          <span className="dot">·</span>
          <span className="meta">
            reason <code>{detail.reasonCode}</code> · phase <code>{detail.phase}</code> ·{' '}
            {detail.scenarioLabel ?? detail.scenarioClass}
          </span>
          <StateBadge state={detail.state} />
        </div>

        <div className="verdict">
          <span className={`word ${decision}`}>
            {decision === 'none' ? 'not gated' : `gate: ${decision}`}
          </span>
          <span className="clause">
            {replayed ||
              detail.gateReason ||
              (detail.collected
                ? `holds ${detail.collected.coverage.present} of ` +
                  `${detail.collected.coverage.required} required artifacts`
                : 'no evidence collected')}
          </span>
        </div>
      </div>

      <Door detail={detail} busy={busy} reviewer={reviewer} onApprove={onApprove} />
    </div>
  );
}

/**
 * The door itself.
 *
 * Three states and no fourth. A drafted dispute offers approval; a submitted one
 * names who approved it; anything else says plainly that there is nothing to
 * approve, rather than showing a disabled button a reviewer might wait on.
 */
function Door({
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
  if (detail.state === 'drafted') {
    return (
      <div className="door">
        <button disabled={busy} onClick={onApprove}>
          {busy ? 'Submitting…' : `Approve and submit as ${reviewer}`}
        </button>
        <span className="note">
          The only action in the product that submits. It authorises this dispute alone.
        </span>
      </div>
    );
  }

  if (detail.state === 'submitted') {
    return (
      <div className="door">
        <span className="settled">
          Submitted, approved by <code>{detail.approvedBy}</code>.
        </span>
      </div>
    );
  }

  // The verdict line already names the decision and the reason for it; this
  // used to restate both ("not contested (assembly)") a third time, next to
  // the state badge in the identity row and the "gate: abstain" word in the
  // verdict itself. Three spellings of one fact is not three confirmations of
  // it, it is one fact a reader has to reconcile three times. This says only
  // the one thing that is actually new here: there is no door to walk through.
  return (
    <div className="door">
      <span className="settled">Nothing to approve here.</span>
    </div>
  );
}
