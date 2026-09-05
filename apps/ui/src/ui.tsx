import { daysUntil, formatRupees } from './api.js';

/**
 * The small vocabulary the console is built from.
 *
 * Nothing here holds state or fetches anything -- these are the four or five
 * marks the rest of the UI reuses so that a state means the same thing in the
 * queue as it does in the workbench. When `present` is green in one place and
 * grey in another, a reviewer stops trusting colour and starts reading every
 * word, which is the failure this file exists to prevent.
 */

/**
 * The mark.
 *
 * Four squares: three filled, one hollow. Filled is evidence the merchant still
 * holds when the dispute arrives; hollow is evidence that lived with the agent
 * platform and is gone by then. The identity is the thesis rather than a shape
 * chosen to look like a logo, which is also why it can be enlarged into the
 * landing page's capture diagram without needing a second idea.
 */
export function Mark({ size = 7 }: { size?: number }) {
  const style = { width: size, height: size, borderRadius: Math.max(1, size / 5) };
  return (
    <span className="mark" aria-hidden="true">
      <i style={style} />
      <i style={style} />
      <i style={style} />
      <i className="hollow" style={style} />
    </span>
  );
}

/** A lifecycle or finding state, always rendered the same way. */
export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state}</span>;
}

/**
 * Ordinary or agentic.
 *
 * Deliberately asymmetric: `agentic` gets ink, `ordinary` stays quiet. The
 * agentic rail is the differentiated half of the product, and the asymmetry
 * makes the composition of the queue readable without counting.
 */
export function RailTag({ rail }: { rail: string }) {
  return <span className={`rail ${rail}`}>{rail}</span>;
}

/**
 * Which side of the LLM boundary a panel came from (CLAUDE.md hard rule #4).
 *
 * The boundary is the strongest AI-judgment claim the project makes and it used
 * to live only in prose. Marking each panel means a reader can point anywhere on
 * screen and know whether a model touched it -- including, and especially, the
 * places where one deliberately did not.
 */
export function Provenance({ kind }: { kind: 'deterministic' | 'llm' }) {
  return kind === 'llm' ? (
    <span className="prov llm" title="Drafted by a model, then mapped and gated by code.">
      llm
    </span>
  ) : (
    <span className="prov det" title="Computed by deterministic code. No model was consulted.">
      deterministic
    </span>
  );
}

/**
 * Time left to respond.
 *
 * The number is the truth and the bar is only an aid: it reads against a
 * fourteen-day reference window, which is a display convention and not a claim
 * about this dispute's actual window, so the `title` says so outright.
 *
 * `now` is where the count is measured from, and it is not optional. A deadline
 * is a subtraction, so a component that renders one while sourcing half the
 * subtraction from ambient global state can be wrong in a way that still looks
 * plausible -- which is exactly how F-024 shipped. The `title` names the instant
 * so a reader can check the arithmetic instead of trusting the badge.
 */
export function Deadline({
  respondBy,
  now,
  bare = false,
}: {
  respondBy: string;
  now: string | null;
  /** Skip the reference-window meter. The queue row is narrow and dense
   *  enough that the bar competes with the id and the amount for the same
   *  line's width without adding a fact the `Xd over`/`Xd left` text does
   *  not already state; the decision bar keeps the meter. */
  bare?: boolean;
}) {
  const days = daysUntil(respondBy, now);
  const fill = Math.max(0, Math.min(days, 14)) / 14;
  const tone = days < 0 ? 'passed' : days < 3 ? 'urgent' : 'normal';
  const label = days < 0 ? `${Math.abs(days)}d over` : `${days}d left`;
  const against = now === null ? 'the current time' : `${readableDate(now)} (simulated clock)`;
  return (
    <span
      className={`deadline ${tone}`}
      title={
        `respond_by ${respondBy}, counted from ${against}` +
        `. The bar reads against a 14-day reference window, not this dispute's own.`
      }
    >
      {bare ? null : (
        <span className="meter">
          <i style={{ ['--fill' as string]: `${(fill * 100).toFixed(0)}%` }} />
        </span>
      )}
      <span className="meter-label">{label}</span>
    </span>
  );
}

/** A section heading, with its provenance and an optional count. */
export function BlockHead({
  label,
  provenance,
  count,
}: {
  label: string;
  provenance?: 'deterministic' | 'llm';
  count?: string;
}) {
  return (
    <div className="block-head">
      <span className="label">{label}</span>
      {provenance ? <Provenance kind={provenance} /> : null}
      {count ? <span className="count">{count}</span> : null}
    </div>
  );
}

/** `₹1,654.00`, from subunits. Re-exported so panels import one module. */
export { formatRupees };

/** A date a person reads, for evidence values. Audit timestamps stay ISO. */
export function readableDate(iso: string | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}
