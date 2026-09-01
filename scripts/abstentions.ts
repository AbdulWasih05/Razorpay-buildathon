import {
  attributeCorpus,
  recall,
  summarise,
  type AbstentionCause,
  type AttributedDispute,
} from '../eval/abstentions.js';

/**
 * Prints the abstention decomposition as plain text.
 *
 * `pnpm abstentions` -- dev corpus, 100 disputes, default thresholds. Reads the
 * seeded corpus and recomputes the gate; no database, no model call, no
 * network. Feeds the P4.1 report.
 */

const LABELS: Record<AbstentionCause, string> = {
  correct_unwinnable: 'correct: corpus says unwinnable',
  conservative_ambiguous: 'conservative: corpus says ambiguous',
  capture_gap: 'RECALL LOST -- capture gap (structurally unavailable)',
  evidence_absent: 'RECALL LOST -- evidence absent from this pack',
  false_negative: 'RECALL LOST -- gate declined with full coverage',
};

function rupees(subunits: number): string {
  return `Rs ${(subunits / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '-' : `${((part / whole) * 100).toFixed(0)}%`;
}

const rows: AttributedDispute[] = attributeCorpus();
const summary = summarise(rows);
const r = recall(rows);

console.log(`dev corpus, ${summary.total} disputes, default thresholds\n`);
console.log(`contested  ${summary.contested}  (${pct(summary.contested, summary.total)})`);
console.log(`abstained  ${summary.abstained}  (${pct(summary.abstained, summary.total)})\n`);

console.log('abstentions by cause');
for (const [cause, count] of Object.entries(summary.byCause)) {
  if (count === 0) continue;
  const key = cause as AbstentionCause;
  console.log(
    `  ${String(count).padStart(3)}  ${pct(count, summary.abstained).padStart(4)}  ` +
      `${rupees(summary.amountByCause[key]).padStart(12)}  ${LABELS[key]}`,
  );
}

const unwinnable = rows.filter((row) => row.groundTruth === 'unwinnable');
const falsePositives = unwinnable.filter((row) => row.decision === 'contest');
const ambiguous = rows.filter((row) => row.groundTruth === 'ambiguous');
const ambiguousAbstained = ambiguous.filter((row) => row.decision === 'abstain').length;

console.log(`\nrecall on winnable:  ${r.contested}/${r.winnable} = ${(r.ratio * 100).toFixed(0)}%`);
console.log(
  `false positives:     ${falsePositives.length}/${unwinnable.length} unwinnable disputes contested`,
);
console.log(
  `ambiguous cases:     ${ambiguousAbstained}/${ambiguous.length} abstained by policy (D-031)`,
);

// The caveat travels with the number, because the number is what gets quoted.
if (falsePositives.length === 0) {
  console.log(
    '\nnote: FP=0 on the dev set is partly a statement about the corpus. Most dev\n' +
      'unwinnables are structurally unwinnable by construction (D-011) -- amount\n' +
      'over cap, mandate expired -- and fall to arithmetic, not judgement. The\n' +
      'gate is really discriminated by the ambiguous row above and by the OOD\n' +
      'held-out set. Do not quote FP=0 without that sentence.',
  );
}

if (Object.keys(summary.gapArtifacts).length > 0) {
  console.log('\nartifacts behind the lost recall');
  for (const [artifact, count] of Object.entries(summary.gapArtifacts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${String(count).padStart(3)}  ${artifact}`);
  }
}

const lost = rows.filter(
  (row) =>
    row.cause === 'capture_gap' ||
    row.cause === 'evidence_absent' ||
    row.cause === 'false_negative',
);
if (lost.length > 0) {
  console.log('\nevery lost-recall case, named');
  for (const row of lost) {
    console.log(
      `  ${row.externalId}  ${row.scenarioClass}  ${row.rail.padEnd(8)}  ${row.cause}` +
        `  blocked_by=${row.blockedBy.join('+')}  missing=${row.missingRequired.join(',') || 'none'}`,
    );
  }
}
