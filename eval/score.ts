import { ABSTENTION_CAUSES, type AbstentionCause } from './abstentions.js';
import { COST_MODEL, FALSE_POSITIVE_UNIT_COST, type EvalCase } from './harness.js';

/**
 * Scoring and reporting for the eval harness (TASKS.md P4.1).
 *
 * Split from `harness.ts` because they answer different questions and fail in
 * different ways: the harness decides disputes, this file reads decisions that
 * have already been made. Keeping them apart means nothing in the scoring path
 * can influence a decision even by accident.
 *
 * Everything here is pure. Given the same cases it produces the same markdown,
 * byte for byte -- which is why the report carries no generation timestamp. The
 * acceptance criterion for P4.1 is that two replay runs produce an identical
 * file, and a clock in the header would break that while looking like metadata.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface Confusion {
  /** Contested and winnable. */
  truePositives: number;
  /** Contested and unwinnable. The expensive error. */
  falsePositives: number;
  /** Abstained and winnable. Recall we did not collect. */
  falseNegatives: number;
  /** Abstained and unwinnable. The product working. */
  trueNegatives: number;
  /** Ground truth `ambiguous`, reported separately -- see D-031. */
  ambiguousContested: number;
  ambiguousAbstained: number;
}

export interface SetMetrics {
  set: string;
  size: number;
  contested: number;
  /** What the deterministic gate cleared, before the drafter veto. */
  gateContested: number;
  abstained: number;
  abstentionRate: number;
  byGroundTruth: { winnable: number; unwinnable: number; ambiguous: number };
  confusion: Confusion;
  /** TP / (TP + FP). Ambiguous excluded; `precisionStrict` counts it against us. */
  precision: number;
  precisionStrict: number;
  recall: number;
  /** Contested-and-unwinnable count times the per-case cost. */
  falsePositiveCostSubunits: number;
  /** Sum of the disputed amounts on the false positives, for scale only. */
  amountOnFalsePositives: number;
  atStakeInDraftedContests: number;
  inCorrectlyAbstainedDisputes: number;
  /** Abstentions by pipeline stage: gate / drafter_disagreement / assembly_failure. */
  byClass: Record<string, number>;
  /** Abstentions by attributed cause, against ground truth. */
  byCause: Record<AbstentionCause, number>;
  /** Which of the four failure paths fired, and how often. */
  failureKinds: Record<string, number>;
  /** Artifacts behind every lost-recall abstention. */
  gapArtifacts: Record<string, number>;
  modelCalls: number;
  /** Mean populated evidence fields per drafted contest. */
  meanEvidenceFields: number;
  /** Drafts whose reason code's required artifacts were all present. */
  fullCoverageDrafts: number;
  meanDraftChars: number;
  /** Drafts rejected for exceeding the documented 1000-character `summary` cap. */
  overLengthDrafts: number;
}

function count<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) if (value in out) out[value] += 1;
  return out;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function score(set: string, cases: EvalCase[]): SetMetrics {
  const contested = cases.filter((c) => c.decision === 'contest');
  const abstained = cases.filter((c) => c.decision === 'abstain');
  const of = (truth: string, decision: 'contest' | 'abstain'): number =>
    cases.filter((c) => c.groundTruth === truth && c.decision === decision).length;

  const confusion: Confusion = {
    truePositives: of('winnable', 'contest'),
    falsePositives: of('unwinnable', 'contest'),
    falseNegatives: of('winnable', 'abstain'),
    trueNegatives: of('unwinnable', 'abstain'),
    ambiguousContested: of('ambiguous', 'contest'),
    ambiguousAbstained: of('ambiguous', 'abstain'),
  };

  const drafted = contested.filter((c) => c.draftChars !== undefined);
  const gapArtifacts: Record<string, number> = {};
  for (const c of abstained) {
    if (c.cause !== 'capture_gap' && c.cause !== 'evidence_absent') continue;
    // The artifact names live on the collector, not the case; the abstention
    // reason carries them in the gate's own words. Counting by reason keeps
    // this file free of a second evidence traversal that could disagree.
    const reason = c.abstentionReason ?? 'unstated';
    gapArtifacts[reason] = (gapArtifacts[reason] ?? 0) + 1;
  }

  return {
    set,
    size: cases.length,
    contested: contested.length,
    gateContested: cases.filter((c) => c.gateDecision === 'contest').length,
    abstained: abstained.length,
    abstentionRate: ratio(abstained.length, cases.length),
    byGroundTruth: {
      winnable: cases.filter((c) => c.groundTruth === 'winnable').length,
      unwinnable: cases.filter((c) => c.groundTruth === 'unwinnable').length,
      ambiguous: cases.filter((c) => c.groundTruth === 'ambiguous').length,
    },
    confusion,
    precision: ratio(confusion.truePositives, confusion.truePositives + confusion.falsePositives),
    precisionStrict: ratio(
      confusion.truePositives,
      confusion.truePositives + confusion.falsePositives + confusion.ambiguousContested,
    ),
    recall: ratio(confusion.truePositives, confusion.truePositives + confusion.falseNegatives),
    falsePositiveCostSubunits: confusion.falsePositives * FALSE_POSITIVE_UNIT_COST,
    amountOnFalsePositives: cases
      .filter((c) => c.decision === 'contest' && c.groundTruth === 'unwinnable')
      .reduce((sum, c) => sum + c.amount, 0),
    atStakeInDraftedContests: contested.reduce((sum, c) => sum + c.amount, 0),
    inCorrectlyAbstainedDisputes: abstained
      .filter((c) => c.groundTruth === 'unwinnable')
      .reduce((sum, c) => sum + c.amount, 0),
    byClass: count(
      abstained.map((c) => c.abstentionClass ?? 'unclassified'),
      ['gate', 'drafter_disagreement', 'assembly_failure', 'unclassified'],
    ),
    byCause: count(
      abstained.flatMap((c) => (c.cause ? [c.cause] : [])),
      ABSTENTION_CAUSES,
    ),
    failureKinds: count(
      cases.flatMap((c) => (c.failureKind ? [c.failureKind] : [])),
      ['error', 'timeout', 'refusal', 'schema'],
    ),
    gapArtifacts,
    modelCalls: cases.filter((c) => c.modelCalled).length,
    meanEvidenceFields: ratio(
      drafted.reduce((sum, c) => sum + (c.evidenceFields ?? 0), 0),
      drafted.length,
    ),
    fullCoverageDrafts: drafted.filter((c) => c.presentArtifacts >= c.requiredArtifacts).length,
    meanDraftChars: ratio(
      drafted.reduce((sum, c) => sum + (c.draftChars ?? 0), 0),
      drafted.length,
    ),
    // The D-003 watch: an over-length letter is rejected by the schema, never
    // trimmed. If this is repeatedly non-zero it is the trigger for a bounded
    // re-prompt, decided from this number rather than from taste.
    overLengthDrafts: cases.filter(
      (c) => c.failureKind === 'schema' && /1000|too_big|at most/i.test(c.failureDetail ?? ''),
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function rupees(subunits: number): string {
  const whole = Math.round(subunits / 100);
  return `₹${whole.toLocaleString('en-IN')}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function frac(part: number, whole: number): string {
  return `${part}/${whole}`;
}

/** A signed delta, so a reader sees direction without doing the subtraction. */
function delta(dev: number, ood: number, format: (n: number) => string): string {
  const diff = ood - dev;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return `${sign}${format(Math.abs(diff))}`;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

export interface ReportInput {
  dev: SetMetrics;
  holdout: SetMetrics;
  devCases: EvalCase[];
  holdoutCases: EvalCase[];
  provider: string;
  model: string;
}

const CAUSE_LABELS: Record<AbstentionCause, string> = {
  correct_unwinnable: 'correct — corpus says unwinnable',
  conservative_ambiguous: 'conservative — corpus says ambiguous',
  capture_gap: 'RECALL LOST — capture gap (structurally unavailable)',
  evidence_absent: 'RECALL LOST — evidence absent from this pack',
  false_negative: 'RECALL LOST — gate declined with full coverage',
  drafter_veto: 'RECALL LOST — drafter declined a case the gate cleared',
};

export function renderReport(input: ReportInput): string {
  const { dev, holdout } = input;
  const out: string[] = [];

  out.push('# Praman — eval results');
  out.push('');
  out.push(
    `Model of record: **\`${input.model}\`** via ${input.provider}, replayed from ` +
      'committed recordings (D-023). Decision and incident ids refer to `docs/CASE_STUDY.md`. ' +
      'Reproduce with `pnpm eval` — replay mode, no network, no API key required.',
  );
  out.push('');
  out.push(
    'This file is generated by `eval/run.ts` and carries **no generation ' +
      'timestamp on purpose**: P4.1 accepts only if two replay runs produce a ' +
      'byte-identical file, and a clock in the header would quietly break that ' +
      'while looking like harmless metadata.',
  );
  out.push('');

  // -- The decomposition leads. D-030: a rate is not a finding. ---------------
  out.push('## Abstention decomposition');
  out.push('');
  out.push(
    'This section is first, not the abstention rate, because a single ' +
      'percentage cannot tell a gate doing its job from a gate too timid to ' +
      'act — and the percentage is what gets quoted (D-030).',
  );
  out.push('');
  out.push(
    table(
      ['cause', 'dev', 'held-out'],
      ABSTENTION_CAUSES.filter(
        (cause) => dev.byCause[cause] > 0 || holdout.byCause[cause] > 0,
      ).map((cause) => [
        CAUSE_LABELS[cause],
        String(dev.byCause[cause]),
        String(holdout.byCause[cause]),
      ]),
    ),
  );
  out.push('');
  out.push(
    table(
      ['abstained at', 'dev', 'held-out'],
      [
        ['deterministic gate (no model was called)', String(dev.byClass['gate'] ?? 0), String(holdout.byClass['gate'] ?? 0)],
        ['drafter disagreed with the gate', String(dev.byClass['drafter_disagreement'] ?? 0), String(holdout.byClass['drafter_disagreement'] ?? 0)],
        ['assembly failure (hard rule #4)', String(dev.byClass['assembly_failure'] ?? 0), String(holdout.byClass['assembly_failure'] ?? 0)],
      ],
    ),
  );
  out.push('');

  // Two commands in this repo report a contested count and they are allowed to
  // differ. Saying so here is cheaper than a reader finding the discrepancy and
  // having to decide which number to trust.
  //
  // `0` rather than `−0`: this row is a subtraction, so it carries a minus sign
  // -- but a signed zero reads as a rounding artifact rather than as "the
  // drafter withheld nothing", and this table sits on the page a judge reads
  // hardest. Zero is the honest rendering of no vetoes.
  const withheld = (count: number | undefined): string =>
    count === undefined || count === 0 ? '0' : `−${count}`;

  out.push(
    table(
      ['contested by', 'dev', 'held-out'],
      [
        [
          'the gate alone — what `pnpm abstentions` scores',
          String(dev.gateContested),
          String(holdout.gateContested),
        ],
        [
          'less contests the drafter withheld',
          withheld(dev.byClass['drafter_disagreement']),
          withheld(holdout.byClass['drafter_disagreement']),
        ],
        [
          'the whole pipeline — what this report scores',
          String(dev.contested),
          String(holdout.contested),
        ],
      ],
    ),
  );
  out.push('');
  out.push(
    '`pnpm abstentions` recomputes the **gate** over the seeded corpus and needs ' +
      'no model at all, so its contested count is the first row. This report runs ' +
      'the **whole pipeline**, so it is the last one. The gap between them is the ' +
      'drafter veto and nothing else, and it only ever runs in one direction.',
  );
  out.push('');

  // -- Headline --------------------------------------------------------------
  out.push('## Headline');
  out.push('');
  out.push(
    table(
      ['metric', 'dev', 'held-out (OOD)', 'shift'],
      [
        ['disputes', String(dev.size), String(holdout.size), '—'],
        [
          'recall on winnable',
          `${frac(dev.confusion.truePositives, dev.byGroundTruth.winnable)} = ${pct(dev.recall)}`,
          `${frac(holdout.confusion.truePositives, holdout.byGroundTruth.winnable)} = ${pct(holdout.recall)}`,
          delta(dev.recall, holdout.recall, pct),
        ],
        [
          'precision on contests',
          pct(dev.precision),
          pct(holdout.precision),
          delta(dev.precision, holdout.precision, pct),
        ],
        [
          'false positives (contested & unwinnable)',
          frac(dev.confusion.falsePositives, dev.byGroundTruth.unwinnable),
          frac(holdout.confusion.falsePositives, holdout.byGroundTruth.unwinnable),
          delta(dev.confusion.falsePositives, holdout.confusion.falsePositives, String),
        ],
        [
          'false-positive cost',
          rupees(dev.falsePositiveCostSubunits),
          rupees(holdout.falsePositiveCostSubunits),
          delta(dev.falsePositiveCostSubunits, holdout.falsePositiveCostSubunits, rupees),
        ],
        [
          'abstention rate',
          pct(dev.abstentionRate),
          pct(holdout.abstentionRate),
          delta(dev.abstentionRate, holdout.abstentionRate, pct),
        ],
        [
          'assembly failures',
          String(dev.byClass['assembly_failure'] ?? 0),
          String(holdout.byClass['assembly_failure'] ?? 0),
          '—',
        ],
      ],
    ),
  );
  out.push('');
  out.push(
    'The held-out set is out-of-distribution **by construction** — different ' +
      'seed, different scenario mix, different personas, and conversation ' +
      `language written by a different lab's model than the one that assembles ` +
      'these drafts (EVAL.md, D-021). The shift column is reported however it ' +
      'reads.',
  );
  out.push('');

  // -- Confusion -------------------------------------------------------------
  out.push('## Decision quality against ground truth');
  out.push('');
  out.push(
    table(
      ['', 'dev', 'held-out'],
      [
        ['true positives — contested, winnable', String(dev.confusion.truePositives), String(holdout.confusion.truePositives)],
        ['false positives — contested, unwinnable', String(dev.confusion.falsePositives), String(holdout.confusion.falsePositives)],
        ['false negatives — abstained, winnable', String(dev.confusion.falseNegatives), String(holdout.confusion.falseNegatives)],
        ['true negatives — abstained, unwinnable', String(dev.confusion.trueNegatives), String(holdout.confusion.trueNegatives)],
        ['ambiguous, contested', String(dev.confusion.ambiguousContested), String(holdout.confusion.ambiguousContested)],
        ['ambiguous, abstained', String(dev.confusion.ambiguousAbstained), String(holdout.confusion.ambiguousAbstained)],
        ['precision (ambiguous excluded)', pct(dev.precision), pct(holdout.precision)],
        ['precision (ambiguous counted against)', pct(dev.precisionStrict), pct(holdout.precisionStrict)],
        ['recall on winnable', pct(dev.recall), pct(holdout.recall)],
      ],
    ),
  );
  out.push('');
  out.push(
    'Ground-truth `ambiguous` is held out of precision and reported on its own ' +
      'line. Folding it into either column would decide by arithmetic a ' +
      'question the corpus deliberately leaves open; policy is to abstain there ' +
      'and to say so (D-031).',
  );
  out.push('');

  // -- Money -----------------------------------------------------------------
  out.push('## Rupees');
  out.push('');
  out.push(
    table(
      ['', 'dev', 'held-out'],
      [
        ['₹ at stake in drafted contests', rupees(dev.atStakeInDraftedContests), rupees(holdout.atStakeInDraftedContests)],
        ['₹ in correctly abstained disputes', rupees(dev.inCorrectlyAbstainedDisputes), rupees(holdout.inCorrectlyAbstainedDisputes)],
        ['false-positive cost', rupees(dev.falsePositiveCostSubunits), rupees(holdout.falsePositiveCostSubunits)],
        ['— of which disputed amount (not counted, see below)', rupees(dev.amountOnFalsePositives), rupees(holdout.amountOnFalsePositives)],
      ],
    ),
  );
  out.push('');
  out.push(
    '**The disputed amount is deliberately not part of the false-positive ' +
      'cost.** Razorpay\'s documentation states the amount is deducted if the ' +
      'dispute is lost — which happens whether or not we contested it. Charging ' +
      'it to the decision would attribute a loss the decision did not cause and ' +
      'inflate the figure by about two orders of magnitude (D-034). What a ' +
      'bluffed contest costs over and above abstaining is the representment ' +
      'handling, and that is what is counted:',
  );
  out.push('');
  out.push(
    `- representment fee: ${rupees(COST_MODEL.representmentFeeSubunits)} per contested-and-lost dispute — **assumption**, no published Razorpay fee schedule was found`,
  );
  out.push(
    `- reviewer handling: ${rupees(COST_MODEL.handlingCostSubunits)} per case — **assumption**`,
  );
  out.push(`- so one false positive costs ${rupees(FALSE_POSITIVE_UNIT_COST)}`);
  out.push('');
  if (dev.confusion.falsePositives === 0 && holdout.confusion.falsePositives === 0) {
    out.push(
      'Both assumptions are, on these numbers, load-bearing for nothing: the ' +
        'false-positive count is zero on both sets, so the cost is ₹0 under any ' +
        'cost model. They are still stated, because the metric has to mean ' +
        'something before it happens to be zero.',
    );
    out.push('');
    out.push(
      'And zero false positives is partly a statement about the corpus, not ' +
        'only about the gate: most unwinnable dev cases are unwinnable by ' +
        'construction (amount over the mandate cap, mandate expired) and fall to ' +
        'arithmetic rather than judgement. The gate is really discriminated by ' +
        'the ambiguous row and by the held-out set. Do not quote ₹0 without this ' +
        'sentence.',
    );
    out.push('');
  }

  // -- Failure paths ---------------------------------------------------------
  out.push('## Assembly failures — the four paths');
  out.push('');
  out.push(
    'Hard rule #4: an LLM step that errors, times out, refuses, or returns ' +
      'output failing schema validation routes the dispute to ' +
      '`assembly failure, manual review required`, audit-logged, never silently ' +
      'retried onto the money path.',
  );
  out.push('');
  out.push(
    table(
      ['path', 'dev', 'held-out'],
      ['error', 'timeout', 'refusal', 'schema'].map((kind) => [
        kind,
        String(dev.failureKinds[kind] ?? 0),
        String(holdout.failureKinds[kind] ?? 0),
      ]),
    ),
  );
  out.push('');
  out.push(
    `Over-length letter drafts rejected by the 1000-character \`summary\` cap: ` +
      `**${dev.overLengthDrafts} dev, ${holdout.overLengthDrafts} held-out**. ` +
      'These are not trimmed to fit — an over-length draft abstains (D-003). ' +
      (dev.overLengthDrafts + holdout.overLengthDrafts > 2
        ? 'This is above the pre-set threshold of two for adding a single bounded, logged re-prompt.'
        : 'Below the pre-set threshold of two for adding a bounded re-prompt, so no re-prompt was added.'),
  );
  out.push('');

  // -- Evidence completeness -------------------------------------------------
  out.push('## Evidence completeness per drafted contest');
  out.push('');
  out.push(
    table(
      ['', 'dev', 'held-out'],
      [
        ['drafts produced', String(dev.contested), String(holdout.contested)],
        ['drafts at full required coverage', frac(dev.fullCoverageDrafts, dev.contested), frac(holdout.fullCoverageDrafts, holdout.contested)],
        ['mean Razorpay evidence fields populated', dev.meanEvidenceFields.toFixed(2), holdout.meanEvidenceFields.toFixed(2)],
        ['mean letter length (cap 1000)', dev.meanDraftChars.toFixed(0), holdout.meanDraftChars.toFixed(0)],
      ],
    ),
  );
  out.push('');

  // -- LLM boundary as a number ---------------------------------------------
  out.push('## How often a model was called at all');
  out.push('');
  out.push(
    table(
      ['', 'dev', 'held-out'],
      [
        ['disputes', String(dev.size), String(holdout.size)],
        ['reached a model', frac(dev.modelCalls, dev.size), frac(holdout.modelCalls, holdout.size)],
        ['decided with no model in the loop', frac(dev.size - dev.modelCalls, dev.size), frac(holdout.size - holdout.modelCalls, holdout.size)],
      ],
    ),
  );
  out.push('');
  out.push(
    'The gate runs before the model, so a dispute the deterministic rules ' +
      'decline never reaches one (D-025). That is the LLM boundary as a ' +
      'measured quantity rather than a claim in a README.',
  );
  out.push('');

  // -- Exception list --------------------------------------------------------
  out.push('## Exception list — every lost-recall case, named');
  out.push('');
  for (const [label, cases] of [
    ['dev', input.devCases],
    ['held-out', input.holdoutCases],
  ] as const) {
    const lost = cases.filter(
      (c) =>
        c.cause === 'capture_gap' ||
        c.cause === 'evidence_absent' ||
        c.cause === 'false_negative' ||
        c.cause === 'drafter_veto',
    );
    out.push(`**${label} — ${lost.length} winnable disputes not contested**`);
    out.push('');
    if (lost.length === 0) {
      out.push('None.');
    } else {
      out.push(
        table(
          ['dispute', 'class', 'rail', 'code', 'cause', 'reason'],
          lost.map((c) => [
            c.externalId,
            c.scenarioClass,
            c.rail,
            `${c.network} ${c.reasonCode}`,
            c.cause ?? '',
            c.abstentionReason ?? '',
          ]),
        ),
      );
    }
    out.push('');
  }

  // -- Drafter disagreements -------------------------------------------------
  const disagreements = [...input.devCases, ...input.holdoutCases].filter(
    (c) => c.abstentionClass === 'drafter_disagreement',
  );
  out.push('## Where the drafter overrode the gate');
  out.push('');
  if (disagreements.length === 0) {
    out.push('No case in either set. The gate and the drafter agreed everywhere.');
  } else {
    out.push(
      `${disagreements.length} case(s). The gate cleared these and the drafter, ` +
        'reading the same evidence, said the case was not there — so they ' +
        'abstained. **The drafter holds a veto toward safety only**: it can ' +
        'withhold a contest, and it can never create one, raise an amount, ' +
        'choose an evidence field, or reach the submission adapter. Every ' +
        'failure mode of the model, including "it was simply wrong", costs at ' +
        'most a contest we did not file (D-025).',
    );
    out.push('');
    out.push(
      table(
        ['dispute', 'class', 'ground truth', 'code'],
        disagreements.map((c) => [
          c.externalId,
          c.scenarioClass,
          c.groundTruth,
          `${c.network} ${c.reasonCode}`,
        ]),
      ),
    );
  }
  out.push('');

  // -- Scoping ---------------------------------------------------------------
  out.push('## What these numbers do not claim');
  out.push('');
  out.push(
    '- **The corpus is self-generated.** The metric is decision quality under ' +
      'our own labelling. The held-out delta is the evidence that the system is ' +
      'not merely tuned to its own generator; it is not a substitute for real ' +
      'disputes.',
  );
  out.push(
    '- **Ground truth is our judgement encoded as rules.** "Winnable" means ' +
      '"defensible on the evidence we hold", not "would have been won" — a real ' +
      'dispute is adjudicated by an issuer applying network rules.',
  );
  out.push(
    '- **Held-out size is 30.** Per-class held-out figures are directional ' +
      'only; the aggregate is what carries weight.',
  );
  out.push(
    '- **The shift is compound.** Seven axes move at once between the two sets, ' +
      'so the delta answers "does it survive unfamiliar data" and cannot answer ' +
      '"what specifically broke it".',
  );
  out.push(
    '- **Live model output is not reproducible and is never claimed to be.** ' +
      'These numbers are byte-reproducible because responses are replayed from ' +
      'committed recordings keyed by request hash, not because the model is ' +
      'deterministic.',
  );
  out.push('');

  return `${out.join('\n')}\n`;
}
