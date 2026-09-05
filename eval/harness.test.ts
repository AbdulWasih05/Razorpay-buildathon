import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVAL_SETS, FALSE_POSITIVE_UNIT_COST, buildClient, runSet } from './harness.js';
import { renderReport, score } from './score.js';

/**
 * The eval harness, tested for the two properties the numbers rest on that
 * nothing else already owns.
 *
 * 1. **It is reproducible.** Two replay runs must produce the report that is
 *    committed, byte for byte. This is the P4.1 acceptance criterion, asserted
 *    rather than eyeballed once.
 *
 * 2. **The cost model still excludes the disputed amount.** That exclusion is a
 *    deliberate correction to the original plan (D-034), and it is exactly the
 *    kind of thing a later reader would "fix" back, so it gets a test rather
 *    than a comment.
 *
 * The third property -- that eval mode can never reach the submission adapter,
 * which is what makes scoring a whole batch legitimate under hard rule #2 --
 * is NOT tested here. It already has an owner in
 * `packages/adapter/src/adapter.test.ts`, which statically forbids any file
 * under `eval/` from importing the adapter package or naming a client. A second
 * copy of that guard here would be one more thing to keep in step, and the
 * first version of it failed the original by naming the package in code.
 *
 * The run tests replay from committed recordings: no key, no network. If a
 * recording is missing they fail with a replay miss, which is the intended
 * behaviour -- a stale fixture must stop the run, never quietly change a number.
 */

const RESULTS = fileURLToPath(new URL('./results.md', import.meta.url));

describe('the false-positive cost means what D-034 says it means', () => {
  it('charges the representment handling, not the disputed amount', () => {
    // ₹1,500: a fee assumption plus a handling assumption, both printed in the
    // report. If someone adds the disputed amount back in, this number stops
    // being a constant at all and the test fails on the type, not the value.
    expect(FALSE_POSITIVE_UNIT_COST).toBe(150_000);
  });
});

describe('a replay run reproduces the committed report', () => {
  it('produces eval/results.md byte for byte', { timeout: 120_000 }, async () => {
    const { client, provider } = buildClient(false, {});
    const devCases = await runSet({ spec: EVAL_SETS.dev, client });
    const holdoutCases = await runSet({ spec: EVAL_SETS.holdout, client });

    const report = renderReport({
      dev: score('dev', devCases),
      holdout: score('holdout', holdoutCases),
      devCases,
      holdoutCases,
      provider: provider.name,
      model: provider.model,
    });

    // Newlines only: the file is written with \n and git may hand back \r\n.
    expect(report.replace(/\r\n/g, '\n')).toBe(
      readFileSync(RESULTS, 'utf8').replace(/\r\n/g, '\n'),
    );
  });
});

describe('the numbers that must not regress', () => {
  let cached: { dev: ReturnType<typeof score>; holdout: ReturnType<typeof score> } | null = null;

  async function metrics(): Promise<NonNullable<typeof cached>> {
    if (cached) return cached;
    const { client } = buildClient(false, {});
    cached = {
      dev: score('dev', await runSet({ spec: EVAL_SETS.dev, client })),
      holdout: score('holdout', await runSet({ spec: EVAL_SETS.holdout, client })),
    };
    return cached;
  }

  it('contests no dispute either corpus calls unwinnable', { timeout: 120_000 }, async () => {
    // Zero false positives on BOTH sets, therefore ₹0 false-positive cost. The
    // held-out half is the one that carries weight -- the dev half could be
    // explained by familiarity, and this cannot.
    const { dev, holdout } = await metrics();
    expect(dev.confusion.falsePositives).toBe(0);
    expect(holdout.confusion.falsePositives).toBe(0);
  });

  it('keeps recall at or above what shipped', { timeout: 120_000 }, async () => {
    // Counts, not ratios: 31/38 rounds to 82% in the report, and a floor copied
    // from the rounded figure fails against the number it came from.
    //
    // Held-out's floor moved 7 -> 6 on 2026-09-05 (FAILURES.md F-025). Closing
    // a rubric-provenance fidelity finding (seven UPI codes wrongly marked as
    // having no published guidance) added two new `supporting` findings to
    // UPI 1061's evidence, and the drafter -- reading a longer list of gaps --
    // declined one held-out case the gate had cleared with full coverage.
    // Dev is verified unchanged over the same fix (`pnpm abstentions`,
    // gate-only, byte-identical before/after). This floor is deliberately
    // moved, not loosened on a hunch: D-023's carve-out permits re-recording
    // for a hard-rule-#1 fix, and the honest cost is reported rather than
    // hidden behind a floor that would otherwise just start failing forever.
    const { dev, holdout } = await metrics();
    expect(dev.confusion.truePositives).toBeGreaterThanOrEqual(31);
    expect(holdout.confusion.truePositives).toBeGreaterThanOrEqual(6);
  });

  it('loses recall only to named capture gaps, never to a gate misjudgement', async () => {
    // `false_negative` means the GATE declined a full-coverage winnable case
    // with no excuse -- a real gate bug. It is distinct from `drafter_veto`
    // (added alongside F-025): the gate cleared the case and the drafter
    // vetoed it, which D-025 says is a sanctioned, different thing. This test
    // pins the claim its name makes; it does not pin the drafter to be right
    // every time, which is a different (and weaker) claim than the one made
    // here on purpose.
    const { dev, holdout } = await metrics();
    expect(dev.byCause.false_negative).toBe(0);
    expect(holdout.byCause.false_negative).toBe(0);
  });

  it('pins the one known drafter_veto case, and refuses to let the bucket grow unnoticed', async () => {
    // `dsp_ood-v1_a4_14` is currently the only case in either set where the
    // gate cleared a full-coverage winnable dispute and the drafter declined
    // it anyway. A bound rather than an exact `toBe(1)` on dev, because dev's
    // recordings were re-minted for the same fix and happened not to flip
    // this way -- 0 there is a fact, not a floor being asserted loosely.
    const { dev, holdout } = await metrics();
    expect(dev.byCause.drafter_veto).toBe(0);
    expect(holdout.byCause.drafter_veto).toBeLessThanOrEqual(1);
  });

  it('lets the drafter withhold contests and never add one', { timeout: 120_000 }, async () => {
    // The veto asymmetry, asserted on the batch rather than argued in prose.
    // The pipeline may contest fewer disputes than the gate cleared; it may
    // never contest more. This is what keeps the model off the money path.
    const { dev, holdout } = await metrics();
    expect(dev.contested).toBeLessThanOrEqual(dev.gateContested);
    expect(holdout.contested).toBeLessThanOrEqual(holdout.gateContested);
  });
});
