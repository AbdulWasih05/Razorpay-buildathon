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
            {detail.gateReason ??
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

  return (
    <div className="door">
      <span className="settled">
        Nothing to approve: this dispute was not contested
        {detail.abstentionClass ? (
          <>
            {' '}
            (<code>{detail.abstentionClass}</code>)
          </>
        ) : null}
        .
      </span>
    </div>
  );
}
