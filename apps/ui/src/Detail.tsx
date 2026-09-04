import type {
  AuditEntry,
  Collected,
  DisputeDetail,
  FieldAssignment,
  Finding,
  GateRule,
  MandateChecks,
} from './api.js';
import { BlockHead, formatRupees, readableDate } from './ui.js';

/**
 * The evidence workbench.
 *
 * Six panels, in the order the pipeline actually ran: what evidence was
 * collected, what the mandate arithmetic says, what rules the gate evaluated,
 * what the model drafted, where that landed in Razorpay's typed fields, and what
 * the audit trail recorded. Reading top to bottom is reading the decision being
 * made.
 *
 * Every panel is marked with the side of the LLM boundary it came from. Five of
 * the six are `deterministic`, and that ratio is the point: the model writes one
 * paragraph, and code does the collecting, the arithmetic, the gating, the
 * mapping and the recording.
 */
export function Detail({ detail }: { detail: DisputeDetail }) {
  const collected = detail.collected;

  return (
    <div className="work">
      {collected ? <Ledger collected={collected} /> : null}
      {collected?.rail === 'agentic' ? <Mandate mandate={collected.mandate} /> : null}
      <RuleTrace detail={detail} />
      {detail.draft ? <Letter summary={detail.draft.summary} /> : null}
      {detail.draft ? <Mapping assignments={detail.draft.assignments} /> : null}
      <Trail detail={detail} />
      {detail.submittedRequest ? <Payload request={detail.submittedRequest} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------- ledger -- */

/**
 * The evidence ledger.
 *
 * Required artifacts first, then supporting, because the gate only ever blocks
 * on a required one -- ordering them together hid which absences actually
 * mattered. Each row carries Razorpay's own published wording for the artifact,
 * so a reviewer can see that `delivery_proof` is our name for their "Proof of
 * service/product delivery" rather than a category we invented.
 *
 * The `not_capturable` rows are the thesis. A required artifact that could never
 * have been held is not a gap in our data collection -- it is evidence that
 * lives with the agent platform and is gone by dispute time, which is the whole
 * argument for capturing at transaction time. Those rows say so on their face.
 */
function Ledger({ collected }: { collected: Collected }) {
  const phrase = new Map(collected.rubric.requires.map((r) => [r.artifact, r.sourcePhrase]));
  const unrecoverable = new Set(collected.structurallyUnavailable ?? []);
  const order = (f: Finding) => (f.necessity === 'required' ? 0 : 1);
  const rows = [...collected.findings].sort((a, b) => order(a) - order(b));
  const { present, required } = collected.coverage;

  return (
    <section className="block">
      <BlockHead
        label="Evidence ledger"
        provenance="deterministic"
        count={`${present}/${required} required present · reason ${collected.rubric.code} · ${collected.rubric.network}`}
      />
      <p className="hint">
        Artifacts the reason-code rubric asks for, and whether the capture store holds them.
        Quoted wording is Razorpay&rsquo;s own, from the submit-evidence documentation.
      </p>

      <table className="grid">
        <thead>
          <tr>
            <th>artifact</th>
            <th>need</th>
            <th>held</th>
            <th>what the rubric asks for</th>
            <th>references</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((finding) => {
            const lost = unrecoverable.has(finding.artifact);
            const classes = [
              finding.necessity === 'supporting' ? 'supporting' : 'required',
              lost ? 'unrecoverable' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <tr key={finding.artifact} className={classes}>
                <td className="artifact">
                  {finding.artifact}
                  {lost ? (
                    <span className="unrecoverable-note">
                      Unrecoverable at dispute time — this evidence lives with the agent
                      platform, not the merchant. Capturing it at transaction time is the only
                      moment it exists to be captured.
                    </span>
                  ) : null}
                </td>
                <td>{finding.necessity}</td>
                <td>
                  <span className={`badge ${finding.state}`}>{finding.state}</span>
                </td>
                <td className="why">
                  {finding.reason ?? phrase.get(finding.artifact) ?? '—'}
                </td>
                <td className="refs">{finding.references.join(' ') || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {collected.anomalySignals.length > 0 ? (
        <p className="warnbox" style={{ marginTop: 10 }}>
          Anomaly signals on the orchestration log:{' '}
          <code>{collected.anomalySignals.join(', ')}</code>. Defending a transaction that looks
          like genuine fraud is the thing defense-only means we do not do.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------ mandate -- */

/**
 * Mandate arithmetic, agentic rail only.
 *
 * `withinLimit: true` is a claim. `₹1,654.00 against a ₹2,456.35 limit` is a
 * check the reviewer can redo in their head, and that difference is most of what
 * "would you trust it" means. Each cell shows the terms, not the conclusion.
 */
function Mandate({ mandate }: { mandate: MandateChecks }) {
  if (!mandate.present) {
    return (
      <section className="block">
        <BlockHead label="Mandate arithmetic" provenance="deterministic" />
        <p className="warnbox">
          Agentic transaction with no mandate record captured. There is no consent evidence to
          reason about, which is decisive on this rail.
        </p>
      </section>
    );
  }

  const tone = (ok: boolean | undefined) => (ok === undefined ? '' : ok ? 'pass' : 'fail');

  return (
    <section className="block">
      <BlockHead
        label="Mandate arithmetic"
        provenance="deterministic"
        count={mandate.status ? `mandate ${mandate.status}` : undefined}
      />
      <p className="hint">
        The three checks the gate ran on the Reserve Pay mandate, shown as their terms rather
        than their verdicts.
      </p>

      <div className="mandate">
        <div className={`check ${tone(mandate.withinLimit)}`}>
          <span className="label">Within limit</span>
          <span className="value">
            {formatRupees(mandate.chargedAmount ?? 0)}
            <span className="op">≤</span>
            {mandate.maxAmount === undefined ? '—' : formatRupees(mandate.maxAmount)}
          </span>
        </div>

        <div className={`check ${tone(mandate.withinValidityWindow)}`}>
          <span className="label">Within validity window</span>
          <span className="value">
            {readableDate(mandate.paymentAt)}
            <span className="op">∈</span>
            {readableDate(mandate.validFrom)}
            <span className="op">→</span>
            {readableDate(mandate.validUntil)}
          </span>
        </div>

        <div className={`check ${tone(mandate.consentBeforePayment)}`}>
          <span className="label">Consent before payment</span>
          <span className="value">
            consent {readableDate(mandate.validFrom)}
            <span className="op">&lt;</span>
            charge {readableDate(mandate.paymentAt)}
          </span>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- rule trace -- */

/**
 * The gate's rule-by-rule trace.
 *
 * Every rule is shown, passed or failed, because the gate evaluates all of them
 * rather than stopping at the first blocker -- a reviewer should see every
 * reason the system had, not just the earliest one.
 *
 * The trace is replayed by the API from stored evidence rather than read from a
 * column. `agrees: false` means that replay reached a different decision than
 * the one recorded when the dispute was gated, which would mean something moved
 * underneath a decision already acted on. It is surfaced loudly instead of
 * being smoothed over.
 */
function RuleTrace({ detail }: { detail: DisputeDetail }) {
  const trace = detail.gateRules;
  const rules: GateRule[] = trace?.rules ?? [];
  const passed = rules.filter((rule) => rule.passed).length;

  return (
    <section className="block">
      <BlockHead
        label="Gate rule trace"
        provenance="deterministic"
        count={rules.length > 0 ? `${passed}/${rules.length} rules passed` : undefined}
      />

      {trace && !trace.agrees ? (
        <p className="error" style={{ marginBottom: 10 }}>
          This trace was replayed from the stored evidence and reached a different decision than
          the one recorded when the dispute was gated. Treat the recorded decision as
          authoritative and the trace below as suspect.
        </p>
      ) : null}

      {rules.length === 0 ? (
        <p className="hint">
          No rule trace: the gate did not run, or the stored evidence could not be replayed.
          {detail.abstentionClass === 'assembly' ? (
            <>
              {' '}
              This dispute abstained on an assembly failure, which happens before the gate has
              anything to evaluate.
            </>
          ) : null}
        </p>
      ) : (
        <div className="rules">
          {rules.map((rule) => (
            <div key={rule.id} className={rule.passed ? 'rule pass' : 'rule fail'}>
              <span className="mark">{rule.passed ? '✓' : '✕'}</span>
              <span className="rid">{rule.id}</span>
              <span className="detail">{rule.detail}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- letter -- */

/**
 * The drafted explanation, and the only panel a model wrote.
 *
 * The character count against Razorpay's 1000-character cap on `summary` is
 * shown because a reviewer approving a letter needs to see it is inside the
 * limit, not trust that it is.
 */
function Letter({ summary }: { summary: string }) {
  const used = summary.length;
  return (
    <section className="block">
      <BlockHead label="Drafted explanation" provenance="llm" />
      <p className="hint">
        Written by a model from the collected evidence, then gated, mapped and recorded by code.
        A model can withhold a contest here; it can never create one, raise an amount, or submit.
      </p>
      <blockquote className="letter">{summary}</blockquote>
      <div className="cap">
        <span className="bar">
          <i style={{ ['--fill' as string]: `${Math.min(100, (used / 1000) * 100).toFixed(0)}%` }} />
        </span>
        <span className="count">{used}/1000 chars</span>
        <span>Razorpay caps `summary` at 1000 characters.</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ mapping -- */

/**
 * Where the evidence landed in Razorpay's typed contest fields.
 *
 * This is the schema-fidelity panel and it is deliberately unglamorous: the
 * field names are theirs, `others` carries its `othersType`, and every field
 * names the artifacts and document references that populated it. The mapping is
 * code, never a model -- which is the point of showing it next to the letter
 * that was.
 */
function Mapping({ assignments }: { assignments: FieldAssignment[] }) {
  return (
    <section className="block">
      <BlockHead
        label="Typed evidence fields"
        provenance="deterministic"
        count={`${assignments.length} field${assignments.length === 1 ? '' : 's'} populated`}
      />
      <p className="hint">
        The contest payload&rsquo;s typed fields, in Razorpay&rsquo;s own names. Which artifact
        goes in which field is a lookup table, not a judgment call.
      </p>
      <div>
        {assignments.map((assignment) => (
          <div className="map-row" key={assignment.field}>
            <span className="map-field">
              {assignment.field}
              {assignment.othersType ? (
                <span className="others">othersType: {assignment.othersType}</span>
              ) : null}
            </span>
            <span className="map-from">
              from {assignment.artifacts.map((a) => <code key={a}>{a} </code>)}
              {assignment.references && assignment.references.length > 0 ? (
                <>
                  <br />
                  {assignment.references.length} document reference
                  {assignment.references.length === 1 ? '' : 's'}:{' '}
                  {assignment.references.join(', ')}
                </>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------- audit trail -- */

/**
 * The append-only trail, as a timeline rather than a blob of text.
 *
 * Same rows, same order, nothing summarised. Laying the actor out in its own
 * column is the whole reason for the change: read down it and a human appears
 * exactly once, at `approved`, which is the claim the product makes about
 * itself. In a `<pre>` that fact was there and unreadable.
 *
 * Timestamps stay in full ISO on purpose. This is the audit record, and an
 * auditor wants the value that was written, not a prettier rendering of it.
 */
function Trail({ detail }: { detail: DisputeDetail }) {
  const entries: AuditEntry[] = detail.auditLogs ?? [];

  return (
    <section className="block">
      <BlockHead
        label="Audit trail"
        provenance="deterministic"
        count={`${entries.length || detail.timeline.length} entries, append-only`}
      />
      {entries.length === 0 ? (
        <pre className="raw">{detail.timeline.join('\n')}</pre>
      ) : (
        <div className="trail">
          {entries.map((entry) => (
            <div className="tstep" key={entry.seq}>
              <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
              <span className={entry.actor.startsWith('human:') ? 'actor human' : 'actor'}>
                {entry.actor}
              </span>
              <span className="move">
                {entry.fromState ? `${entry.fromState} → ` : ''}
                <span className="to">{entry.toState}</span>
                {entry.reason ? <span className="reason"> — {entry.reason}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ payload -- */

/** The exact request handed to the adapter, once a dispute has been submitted. */
function Payload({ request }: { request: Record<string, unknown> }) {
  return (
    <section className="block">
      <BlockHead label="Submitted contest payload" provenance="deterministic" />
      <p className="hint">
        The request as it was sent, recorded at submission. Not regenerated for display.
      </p>
      <pre className="raw">{JSON.stringify(request, null, 2)}</pre>
    </section>
  );
}
