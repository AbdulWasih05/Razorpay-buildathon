import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ContestDraft } from '@praman/core';

import {
  ApprovalToken,
  RazorpayClient,
  SimulatorClient,
  adapterFromEnv,
  type UploadedDocument,
} from './index.js';

/**
 * TASKS.md P3.4 acceptance, plus the invariant from CLAUDE.md hard rule #2.
 *
 * Most of this file tests what the adapter REFUSES. The submit path is the
 * money path, and the interesting property is not that it works but that it
 * cannot be reached any other way.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const NOW = () => new Date('2026-06-10T09:00:00.000Z');

const draft: ContestDraft = {
  disputeId: 'disp_AdapterTest01',
  amount: 41900,
  disputedAmount: 41900,
  summary: 'Delivery is evidenced by a signed proof of delivery against this order.',
  action: 'draft',
  assignments: [
    {
      field: 'shipping_proof',
      artifacts: ['delivery_proof'],
      references: ['ful_test_1', 'proof_test_1'],
    },
    {
      field: 'others',
      othersType: 'invoice_with_price_breakdown',
      artifacts: ['invoice_breakdown'],
      references: ['ord_test_1'],
    },
  ],
  references: ['ful_test_1', 'ord_test_1', 'proof_test_1'],
};

async function uploadAll(client: SimulatorClient): Promise<UploadedDocument[]> {
  const documents: UploadedDocument[] = [];
  for (const reference of draft.references) {
    documents.push(await client.uploadDocument(reference, `${reference}.txt`, 'evidence'));
  }
  return documents;
}

describe('nothing submits without a human approval', () => {
  it('cannot mint an approval token for a system actor', () => {
    for (const actor of ['system', 'gate', 'llm', 'adapter', '', '   ']) {
      expect(() => ApprovalToken.approve(draft.disputeId, actor, NOW())).toThrow(/human actor/);
    }
  });

  it('cannot be fooled by prefixing a system name with "human:"', () => {
    // F-013. This is the exact bypass that reached production behaviour: an API
    // route helpfully prefixed whatever it was given, so approvedBy "system"
    // became "human:system" and submitted a contest. The prefix proves nothing
    // on its own; the name behind it is what matters.
    for (const name of ['system', 'gate', 'llm', 'adapter', 'SYSTEM', 'Bot', 'automation']) {
      expect(
        () => ApprovalToken.approve(draft.disputeId, `human:${name}`, NOW()),
        name,
      ).toThrow(/system actor, not a person/);
    }
  });

  it('refuses a prefix with nothing behind it', () => {
    expect(() => ApprovalToken.approve(draft.disputeId, 'human:', NOW())).toThrow(
      /reviewer name after/,
    );
    expect(() => ApprovalToken.approve(draft.disputeId, 'human:   ', NOW())).toThrow(
      /reviewer name after/,
    );
  });

  it('still accepts a real person whose name merely contains a reserved word', () => {
    // "systems-team-anita" is a person. The check is on the whole name, not a
    // substring, so tightening the guard did not make it paranoid.
    expect(() =>
      ApprovalToken.approve(draft.disputeId, 'human:systems-team-anita', NOW()),
    ).not.toThrow();
  });

  it('mints one for a named human, and records who and when', () => {
    const token = ApprovalToken.approve(draft.disputeId, 'human:wasih', NOW());
    expect(token.approvedBy).toBe('human:wasih');
    expect(token.disputeId).toBe(draft.disputeId);
    expect(token.approvedAt.toISOString()).toBe('2026-06-10T09:00:00.000Z');
  });

  it('refuses an approval minted for a different dispute', async () => {
    // An approval authorises one dispute, not a batch. Without this, approving
    // one case in a queue would be enough to submit any other.
    const client = new SimulatorClient({ now: NOW });
    const documents = await uploadAll(client);
    const wrongToken = ApprovalToken.approve('disp_SomeOtherCase', 'human:wasih', NOW());
    await expect(client.submit(draft, documents, wrongToken)).rejects.toThrow(
      /approval is for disp_SomeOtherCase/,
    );
  });
});

describe('the submitted payload is the documented shape', () => {
  it('validates against the contract types and carries action draft', async () => {
    const client = new SimulatorClient({ now: NOW });
    const documents = await uploadAll(client);
    const result = await client.submit(
      draft,
      documents,
      ApprovalToken.approve(draft.disputeId, 'human:wasih', NOW()),
    );

    expect(result.request.action).toBe('draft');
    expect(result.request.summary).toBe(draft.summary);
    expect(result.request.shipping_proof).toHaveLength(2);
    expect(result.request.others).toEqual([
      { type: 'invoice_with_price_breakdown', document_ids: [expect.stringMatching(/^doc_/)] },
    ]);
  });

  it('never invents a document id for a reference that was not uploaded', async () => {
    // The failure that matters: a plausible-looking doc_ id would typecheck,
    // pass here, and be rejected by Razorpay where nobody is watching.
    const client = new SimulatorClient({ now: NOW });
    const partial = [await client.uploadDocument('ful_test_1', 'a.txt', 'x')];
    await expect(
      client.submit(draft, partial, ApprovalToken.approve(draft.disputeId, 'human:wasih', NOW())),
    ).rejects.toThrow(/no uploaded document for capture reference/);
  });

  it('refuses a contest for more than the disputed amount', async () => {
    // This guard was vacuous when first written -- `prepare` compared the
    // contest amount against itself, so it read as a check and enforced
    // nothing. `disputedAmount` is a separate field for exactly this reason.
    const client = new SimulatorClient({ now: NOW });
    const documents = await uploadAll(client);
    const approval = ApprovalToken.approve(draft.disputeId, 'human:wasih', NOW());

    const overreach: ContestDraft = { ...draft, amount: draft.disputedAmount + 1 };
    await expect(client.submit(overreach, documents, approval)).rejects.toThrow(
      /exceeds the disputed amount/,
    );

    const partial: ContestDraft = { ...draft, amount: draft.disputedAmount - 1 };
    await expect(client.submit(partial, documents, approval)).resolves.toBeDefined();
  });

  it('marks every simulated submission as simulated, at the data level', () => {
    // Hard rule #6: no outcome may be rendered without its provenance.
    const client = new SimulatorClient({ now: NOW });
    expect(client.simulated).toBe(true);
  });

  it('does not decide won or lost', async () => {
    // A contested dispute is under_review. Inventing an outcome in the submit
    // path is how a simulated number becomes the thing everyone quotes.
    const client = new SimulatorClient({ now: NOW });
    const documents = await uploadAll(client);
    const result = await client.submit(
      draft,
      documents,
      ApprovalToken.approve(draft.disputeId, 'human:wasih', NOW()),
    );
    expect(result.dispute.status).toBe('under_review');
    expect(['won', 'lost']).not.toContain(result.dispute.status);
  });
});

describe('the real client', () => {
  it('refuses any key that is not test mode', () => {
    expect(() => new RazorpayClient({ keyId: 'rzp_live_abc', keySecret: 's' })).toThrow(
      /rzp_test_/,
    );
    expect(() => new RazorpayClient({ keyId: 'rzp_test_abc', keySecret: 's' })).not.toThrow();
  });

  it('is not what the environment selects by default', () => {
    // The demo and the corpus must never reach Razorpay by accident.
    expect(adapterFromEnv({}, NOW).name).toBe('simulator');
    expect(adapterFromEnv({ ADAPTER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'y' }, NOW).name).toBe(
      'razorpay',
    );
  });

  it('will not be built without credentials', () => {
    expect(() => adapterFromEnv({ ADAPTER: 'razorpay' }, NOW)).toThrow(/needs RAZORPAY_KEY_ID/);
  });
});

describe('eval mode never touches the submission adapter', () => {
  /**
   * CLAUDE.md hard rule #2, second half: "Eval mode scores gate decisions and
   * draft outputs only and NEVER touches the submission adapter (a test
   * enforces this)."
   *
   * This is that test. Structural, like the holdout guard: it checks what the
   * eval code CAN reach, not what it happens to call today.
   */
  function evalSources(): string[] {
    return globSync(['eval/**/*.ts'], { cwd: REPO_ROOT })
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => !path.includes('node_modules/'));
  }

  function code(relative: string): string {
    const source = readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('finds the eval sources (guard is not silently vacuous)', () => {
    expect(evalSources().length).toBeGreaterThan(2);
  });

  it('has no file under eval/ that imports the adapter package', () => {
    const offenders = evalSources().filter((relative) =>
      /@praman\/adapter/.test(code(relative)),
    );
    expect(offenders).toEqual([]);
  });

  it('has no file under eval/ that names submit, approve or an adapter client', () => {
    const offenders = evalSources().filter((relative) =>
      /\b(SimulatorClient|RazorpayClient|ApprovalToken|adapterFromEnv)\b/.test(code(relative)),
    );
    expect(offenders).toEqual([]);
  });
});
