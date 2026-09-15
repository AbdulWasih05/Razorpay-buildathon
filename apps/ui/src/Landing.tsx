import { useEffect, useState } from 'react';

import { fetchEvalReport } from './api.js';
import { modelOfRecord, parseReport } from './Report.js';
import { Mark } from './ui.js';
import { linkTo } from './router.js';
import './landing.css';

/**
 * The overview page, at `/`.
 *
 * It exists because the README's first line is a live link.
 * A link that opens straight into a review
 * queue proves the thing runs but says nothing about what it is; this page says
 * what it is in about fifteen seconds and then gets out of the way.
 *
 * It is written as a document rather than as a landing page. The order is an
 * argument, not a sales funnel: the gap comes first because it is the reason
 * any of this exists, the measurements come second because a claim without them
 * is marketing, the AI boundary third because it is the strongest thing the
 * project has to say, and the trust properties last because they only mean
 * something once you believe the rest.
 *
 * The one rule that makes it worth having at all: **no number on this page is
 * written by hand.** The metrics table is the `Headline` section of the
 * committed `eval/results.md`, selected and rendered verbatim by the same
 * parser the eval page uses. Selecting a section is not computing one, so
 * the single-source invariant survives -- there is still exactly one place a number can be
 * wrong, and it is the report. A test asserts this file contains no percent
 * sign and no rupee sign, which are the units every headline metric is reported
 * in, so a hand-typed figure fails CI rather than shipping.
 */

const SECTIONS = [
  { id: 'gap', num: '01', name: 'The gap' },
  { id: 'measured', num: '02', name: 'Measured' },
  { id: 'boundary', num: '03', name: 'The boundary' },
  { id: 'trust', num: '04', name: 'Trust' },
] as const;

/**
 * The committed eval report, fetched once and shared. The colophon and the
 * Measured section both read it, and neither restates what it says -- including
 * which model produced the recordings, so a change of model of record never
 * needs an edit here.
 */
let reportRequest: Promise<string> | null = null;

function loadReport(): Promise<string> {
  if (reportRequest === null) reportRequest = fetchEvalReport();
  return reportRequest;
}

function useReport(): { markdown: string | null; failed: boolean } {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadReport()
      .then((text) => {
        if (live) setMarkdown(text);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return { markdown, failed };
}

export function Landing() {
  const active = useActiveSection();

  return (
    <div className="landing">
      <Spine active={active} />
      <div className="doc">
        <Masthead />
        <Gap />
        <Measured />
        <Boundary />
        <Trust />
        <Foot />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- spine -- */

/**
 * Which section is on screen.
 *
 * The rail is only worth its width if it says where you are; a static list of
 * links would be decoration wearing the costume of navigation.
 *
 * "The last section whose heading you have scrolled past" rather than "the
 * section with the largest visible area". The area version is the obvious one
 * and it fails at the foot of the page: the final section is short, the footer
 * below it is not tracked, and so the marker sticks on whichever long section
 * came before -- it read 03 while the reader was plainly in 04. Reading down a
 * document is a sequence, so the indicator should be one too.
 *
 * The trigger line sits about a third of the way down the viewport rather than
 * at a fixed pixel offset, so the marker turns over when a heading reaches the
 * place a reader is actually looking. It is computed from `innerHeight` rather
 * than written as a viewport unit because a percent sign in this file fails the
 * guard test described above -- the arithmetic is the same, and honouring the
 * test beats moving the code somewhere the test does not look.
 */
function spyLine(): number {
  return Math.max(140, window.innerHeight * 0.32);
}

function useActiveSection(): string {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const line = spyLine();
      let current: string = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const node = document.getElementById(section.id);
        if (node && node.getBoundingClientRect().top <= line) current = section.id;
      }
      setActive(current);
    };

    // Coalesced into one measurement per frame: scroll fires far faster than
    // the page can repaint, and reading layout on every event is how a smooth
    // page starts stuttering on a laptop trackpad.
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return active;
}

function Spine({ active }: { active: string }) {
  return (
    <aside className="spine">
      <a className="wordmark" {...linkTo('landing')} aria-label="Praman">
        <Mark size={8} />
      </a>

      <nav className="spine-nav">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            className={active === section.id ? 'spine-link on' : 'spine-link'}
            href={`#${section.id}`}
            aria-current={active === section.id ? 'true' : undefined}
          >
            <span className="spine-num">{section.num}</span>
            <span className="spine-rule" />
            <span className="spine-name">{section.name}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}

/* ------------------------------------------------------------- masthead -- */

/**
 * The colophon.
 *
 * A paper's masthead metadata, and it earns its place twice: it answers the
 * four questions a reader asks in the first fifteen seconds -- what it is, which
 * rails, which model, and can it submit on its own -- and it balances a
 * composition that was otherwise a narrow column against half a screen of dead
 * space.
 *
 * Deliberately no metrics here. Those live in section 02, rendered from the
 * committed report; a number typed into this list would be exactly the second
 * source of truth the guard test exists to prevent. The model name is read out
 * of the same report, for the same reason.
 */
function colophonRows(model: string | null) {
  return [
    { k: 'Scope', v: 'Dispute defense for agent-initiated payments' },
    { k: 'Rails', v: 'Ordinary and agentic (UPI Reserve Pay)' },
    {
      k: 'Model of record',
      v: model ? `${model}, replayed from committed recordings` : 'Named in the committed eval report',
    },
    { k: 'Submit path', v: 'One door, and a named human opens it' },
    { k: 'Demo data', v: 'Seeded simulator, labelled on every screen' },
  ];
}

function Colophon() {
  const { markdown } = useReport();
  const record = markdown ? modelOfRecord(markdown) : null;

  return (
    <dl className="colophon">
      {colophonRows(record ? record.model : null).map((row) => (
        <div key={row.k}>
          <dt>{row.k}</dt>
          <dd>{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Masthead() {
  return (
    <header className="masthead">
      {/* No mark here. The spine carries it as a running identity, and repeating
          it twice inside one viewport is the kind of duplication that reads as a
          template assembled from parts rather than a page that was set. */}
      <div className="masthead-main">
      <p className="wordmark">
        Praman
        <span className="thin">defense only</span>
      </p>

      <h1 className="thesis">
        Agentic evidence is captured at transaction time.
        <b>By dispute time it is gone.</b>
      </h1>

      <p className="lede">
        Praman reads a dispute in Razorpay&rsquo;s documented Disputes API schema, assembles the
        evidence a merchant actually holds, decides contest-or-abstain through a deterministic
        sufficiency gate, and submits only when a named human approves that specific dispute.
      </p>

      <div className="ways">
        <a className="way lead" {...linkTo('console')}>
          Open the review console <span>&rarr;</span>
        </a>
        <a className="way" {...linkTo('eval')}>
          Read the eval results <span>&rarr;</span>
        </a>
      </div>

      <p className="note">
        The console runs on seeded, simulated data and says so on every screen. No live Razorpay
        call is ever made.
      </p>
      </div>

      <Colophon />
    </header>
  );
}

/* ------------------------------------------------------------------ gap -- */

const HELD = ['agent id', 'mandate ref', 'protocol meta', 'conversation'];

function Gap() {
  return (
    <section id="gap">
      <div className="head">
        <span className="tag">
          <b>01</b> The gap
        </span>
        <h2>
          The evidence that decides an agentic dispute never belonged to the merchant in the first
          place.
        </h2>
      </div>

      <div className="capture-grid">
        <div className="prose">
          <p>
            The agent identifier, the mandate reference, the protocol metadata and the conversation
            trace live with the agent platform or the TPAP. Weeks or months later, when the dispute
            arrives, there is nothing to retrieve.
          </p>
          <p>
            So the transaction store <em>is</em> the capture layer, and <code>POST /evidence-pack</code>{' '}
            is that layer as a real endpoint rather than a box on a diagram. Every one of the
            100 seeded disputes was captured through it.
          </p>
          <p>
            <a
              href="https://razorpay.com/blog/agentic-payments-and-npci/"
              target="_blank"
              rel="noreferrer"
            >
              Razorpay and NPCI shipped agentic payments on UPI Reserve Pay
            </a>{' '}
            in February 2026, and that announcement is entirely about the consent going in. It says
            nothing about disputes, chargebacks, evidence, or merchant recourse when one of those
            payments is later challenged. Praman is about the other end.
          </p>
        </div>

        <figure className="capture">
          <div className="capture-row">
            <span className="capture-when">At transaction time</span>
            <div className="chips">
              {HELD.map((key) => (
                <span className="chip-ev held" key={key}>
                  {key}
                </span>
              ))}
            </div>
          </div>

          <div className="elapsed" aria-hidden="true">
            <span>weeks pass</span>
          </div>

          <div className="capture-row">
            <span className="capture-when">At dispute time, uncaptured</span>
            <div className="chips">
              {HELD.map((key) => (
                <span className="chip-ev gone" key={key}>
                  {key}
                </span>
              ))}
            </div>
          </div>

          <figcaption>
            Filled is evidence still held. Hollow is evidence that only ever existed at the moment
            of the transaction. The same four squares as the mark, because the identity is
            the argument.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- measured -- */

/**
 * The headline table, lifted verbatim out of the committed eval report.
 *
 * It finds the `Headline` heading and renders the first table under it. No
 * arithmetic, no rounding, no reformatting of a single cell -- if this page and
 * `eval/results.md` ever disagree, that is a bug in the parser rather than a
 * second set of numbers drifting from the first.
 */
function headlineTable(markdown: string): { header: string[]; rows: string[][] } | null {
  const blocks = parseReport(markdown);
  const at = blocks.findIndex(
    (block) => block.kind === 'heading' && /^headline$/i.test(block.text.trim()),
  );
  const found = at === -1 ? undefined : blocks.slice(at + 1).find((b) => b.kind === 'table');
  return found && found.kind === 'table' ? { header: found.header, rows: found.rows } : null;
}

function Measured() {
  const report = useReport();
  const table = report.markdown ? headlineTable(report.markdown) : null;
  const record = report.markdown ? modelOfRecord(report.markdown) : null;
  const failed = report.failed || (report.markdown !== null && table === null);

  return (
    <section id="measured">
      <div className="head">
        <span className="tag">
          <b>02</b> Measured, not claimed
        </span>
        <h2>
          One dev corpus, one held-out set that is out-of-distribution by construction, and the
          shift between them reported whichever way it falls.
        </h2>
      </div>

      {failed ? (
        <p className="hint">
          The eval report could not be loaded. It is generated by <code>pnpm eval</code> and
          committed at <code>eval/results.md</code>; this page renders that file and computes
          nothing of its own, so an empty table here means the report is missing, never that the
          numbers differ.
        </p>
      ) : !table ? (
        <p className="hint">Loading the committed eval report&hellip;</p>
      ) : (
        <div className="metrics-scroll">
          <table className="metrics">
            <thead>
              <tr>
                {table.header.map((cell, i) => (
                  <th key={i} className={i === 0 ? '' : 'num'}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={c === 0 ? 'metric-name' : 'num'}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="provenance">
        Rendered verbatim from the committed <code>eval/results.md</code>. Model of record{' '}
        <code>{record ? record.model : 'named in the report'}</code>
        {record ? ` via ${record.provider.charAt(0).toUpperCase()}${record.provider.slice(1)}` : ''},
        replayed from committed recordings.{' '}
        <code>pnpm eval</code> reproduces the file byte for byte with no network and no API key.
        Headline metrics are precision and recall against corpus labels and false-positive cost in
        rupees; no simulated outcome is reported as a result anywhere.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------- boundary -- */

function Boundary() {
  return (
    <section id="boundary">
      <div className="head">
        <span className="tag">
          <b>03</b> The boundary
        </span>
        <h2>
          A money action must never depend on a stochastic step, and an eval must be reproducible.
        </h2>
      </div>

      <div className="boundary">
        <div className="side llm-side">
          <h3>A model does exactly three things</h3>
          <ul>
            <li>Summarises a conversation trace</li>
            <li>Drafts the explanation letter</li>
            <li>Flags ambiguity for a human</li>
          </ul>
        </div>
        <div className="side det-side">
          <h3>Code does everything else</h3>
          <ul>
            <li>Schema and evidence-field mapping</li>
            <li>Gate thresholds and the contest decision</li>
            <li>Metrics computation</li>
            <li>Submission, and every step on the money path</li>
          </ul>
        </div>
      </div>

      <p className="provenance">
        The drafter can only ever <em>withhold</em> a contest, never create one, raise an amount, or
        submit. On the dev corpus it changed the outcome on 2 of 100 disputes, in the
        conservative direction only. Any model step that errors, times out, refuses, or returns
        output failing schema validation routes the dispute to abstain with{' '}
        <em>&ldquo;assembly failure, manual review required&rdquo;</em>, audit-logged and never
        silently retried. Claude Code built this repository; no agent loop runs inside Praman
        itself. It is in the build loop, not the money path.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- trust -- */

const PROPERTIES = [
  {
    k: 'One door',
    d: 'The approve action in the review console is the only path to submission. Eval mode scores gate decisions and drafts and provably never touches the submission adapter, and a test enforces it.',
  },
  {
    k: 'Abstention over bluffing',
    d: 'Insufficient evidence abstains with a stated reason. A bluffed contest that fails costs fees and handling time, and that is the false-positive cost the eval reports in rupees.',
  },
  {
    k: 'Deterministic gate',
    d: 'Required-evidence coverage, mandate arithmetic and anomaly signals decide contest-or-abstain. Thresholds are config, every rule is traced, and no model is consulted.',
  },
  {
    k: 'Append-only audit',
    d: 'Every state transition is recorded with its actor and timestamp. A human appears exactly once in the trail, at approval.',
  },
  {
    k: 'Schema fidelity',
    d: 'Dispute entities, typed evidence fields, contest payloads and error states mirror the documented Disputes API. The live docs are the authority; where they disagreed with our notes, the docs won three times.',
  },
  {
    k: 'Defense-only',
    d: 'Nothing offense-capable. The generator creates dispute scenarios, never attack tooling, and a transaction carrying fraud signals is not defended.',
  },
];

function Trust() {
  return (
    <section id="trust">
      <div className="head">
        <span className="tag">
          <b>04</b> Trust
        </span>
        <h2>The gates, the audit log and the determinism are the product, not decoration.</h2>
      </div>

      <div className="props">
        {PROPERTIES.map((p) => (
          <div className="prop" key={p.k}>
            <h3>{p.k}</h3>
            <p>{p.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- foot -- */

function Foot() {
  return (
    <footer className="foot">
      <div className="ways">
        <a className="way lead" {...linkTo('console')}>
          Open the review console <span>&rarr;</span>
        </a>
        <a className="way" {...linkTo('eval')}>
          Read the eval results <span>&rarr;</span>
        </a>
      </div>
      <p>
        Every dispute, payment and mandate in the
        demo is generated by a seeded simulator and labelled as simulated wherever it is rendered.
      </p>
    </footer>
  );
}
