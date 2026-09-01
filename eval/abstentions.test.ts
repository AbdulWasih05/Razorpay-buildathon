import { describe, expect, it } from 'vitest';

import { attributeCorpus, recall, summarise } from './abstentions.js';

/**
 * The decomposition is a claim about the product, so it is tested like one.
 *
 * These assertions are deliberately about SHAPE, not about the specific numbers
 * on today's corpus -- P4.0 is expected to move the counts, and a test that
 * pins 11 capture-gap abstentions would have to be edited to let the repair
 * land, which makes it a rubber stamp rather than a check.
 *
 * The one number pinned hard is false positives on unwinnable disputes: that
 * must stay zero, and if a change makes it non-zero the eval should fail loudly
 * rather than report a slightly worse figure in a table nobody re-reads.
 */

const rows = attributeCorpus();
const summary = summarise(rows);

describe('every abstention is attributed', () => {
  it('gives a cause to every abstention and none to any contest', () => {
    for (const row of rows) {
      if (row.decision === 'abstain') expect(row.cause, row.externalId).toBeDefined();
      else expect(row.cause, row.externalId).toBeUndefined();
    }
  });

  it('accounts for the whole corpus', () => {
    const causeTotal = Object.values(summary.byCause).reduce((a, b) => a + b, 0);
    expect(causeTotal).toBe(summary.abstained);
    expect(summary.contested + summary.abstained).toBe(summary.total);
  });

  it('is byte-identical across runs on one seed', () => {
    expect(summarise(attributeCorpus())).toEqual(summary);
  });
});

describe('the buckets mean what they say', () => {
  it('never files a winnable dispute as a correct abstention', () => {
    // The bucket that would flatter the numbers if it were loose.
    for (const row of rows) {
      if (row.cause !== 'correct_unwinnable') continue;
      expect(row.groundTruth, row.externalId).toBe('unwinnable');
    }
  });

  it('files capture_gap only when EVERY missing artifact is structurally unavailable', () => {
    // Otherwise "capture gap" becomes a place to put any abstention we would
    // rather not call a miss.
    for (const row of rows) {
      if (row.cause !== 'capture_gap') continue;
      expect(row.missingRequired.length, row.externalId).toBeGreaterThan(0);
      for (const artifact of row.missingRequired) {
        expect(row.structurallyUnavailable, `${row.externalId}/${artifact}`).toContain(artifact);
      }
    }
  });

  it('files false_negative only where coverage was already complete', () => {
    for (const row of rows) {
      if (row.cause !== 'false_negative') continue;
      expect(row.missingRequired, row.externalId).toEqual([]);
      expect(row.groundTruth, row.externalId).toBe('winnable');
    }
  });
});

describe('the numbers that must not regress', () => {
  it('contests no dispute the corpus calls unwinnable', () => {
    // Zero false positives, therefore zero false-positive cost in rupees. This
    // is the headline the track bar scores, and it is a hard floor.
    const contested = rows.filter(
      (row) => row.decision === 'contest' && row.groundTruth === 'unwinnable',
    );
    expect(contested.map((row) => row.externalId)).toEqual([]);
  });

  it('has recall on winnable disputes no worse than it does today', () => {
    // A floor, not a target. P4.0 should push this up; nothing should push it
    // down without the drop being visible here first.
    expect(recall(rows).ratio).toBeGreaterThanOrEqual(0.68);
  });

  it('loses recall only to named capture gaps, never to a gate misjudgement', () => {
    // The claim this whole decomposition exists to support. If a
    // false_negative ever appears, the gate declined a dispute whose evidence
    // it already held, and that is a different and worse problem than a thin
    // capture layer.
    expect(summary.byCause.false_negative).toBe(0);
  });
});
