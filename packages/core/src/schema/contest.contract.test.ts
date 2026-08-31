import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONTEST_ACTIONS,
  CONTEST_EVIDENCE_DOCUMENT_FIELDS,
  contestRequestForDispute,
  contestRequestSchema,
  contestResponseSchema,
  countContestDocumentIds,
} from './contest.js';
import { EVIDENCE_SUMMARY_MAX_CHARS, disputeEvidenceSchema } from './dispute.js';

/**
 * CONTRACT tests for the WRITE side (TASKS.md P2.0).
 *
 * Same rule as the read-side suite: the fixtures are verbatim copies of the
 * payloads Razorpay prints in its docs (../fixtures/PROVENANCE.md). If these
 * fail, fix the schema, never the fixture.
 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const contestDraftRequest = fixture('dispute-contest-draft-request.json');
const contestDraftResponse = fixture('dispute-contest-draft-response.json');

describe('contest request, against the verbatim doc example', () => {
  it('parses the documented draft request', () => {
    const parsed = contestRequestSchema.parse(contestDraftRequest);
    expect(parsed.amount).toBe(5000);
    expect(parsed.summary).toBe('goods delivered');
    expect(parsed.shipping_proof).toEqual(['doc_EFtmUsbwpXwBH9', 'doc_EFtmUsbwpXwBH8']);
    expect(parsed.action).toBe('draft');
    expect(parsed.others).toEqual([
      {
        type: 'receipt_signed_by_customer',
        document_ids: ['doc_EFtmUsbwpXwBH1', 'doc_EFtmUsbwpXwBH7'],
      },
    ]);
  });

  it('parses the documented contest response as a dispute entity', () => {
    const parsed = contestResponseSchema.parse(contestDraftResponse);
    expect(parsed.id).toBe('disp_AHfqOvkldwsbqt');
    expect(parsed.evidence.summary).toBe('goods delivered');
  });

  it('defaults `action` to draft, as documented', () => {
    // The safe default is the whole point: an omitted action must never submit.
    const parsed = contestRequestSchema.parse({ summary: 'no action field here' });
    expect(parsed.action).toBe('draft');
  });

  it('names both documented actions and no others', () => {
    expect([...CONTEST_ACTIONS]).toEqual(['draft', 'submit']);
  });

  it('invents no evidence field: every write field is a documented read field', () => {
    // The structural guard against drift. The read schema is built from the
    // response the docs print; the write field list must be a subset of it.
    const readKeys = new Set(Object.keys(disputeEvidenceSchema.shape));
    for (const field of CONTEST_EVIDENCE_DOCUMENT_FIELDS) {
      expect(readKeys.has(field), `${field} is not a documented evidence field`).toBe(true);
    }
    expect(CONTEST_EVIDENCE_DOCUMENT_FIELDS).toHaveLength(10);
  });
});

describe('the documented submit precondition', () => {
  // "You need to provide a minimum of one document id (across any of the
  // evidence object attributes) for a successful submission."
  it('rejects submit with no document ids at all', () => {
    expect(() => contestRequestSchema.parse({ summary: 'trust me', action: 'submit' })).toThrow(
      /minimum of one document id/,
    );
  });

  it('accepts submit backed by a single typed-field document', () => {
    const parsed = contestRequestSchema.parse({
      shipping_proof: ['doc_EFtmUsbwpXwBH9'],
      action: 'submit',
    });
    expect(parsed.action).toBe('submit');
  });

  it('accepts submit backed only by documents inside `others`', () => {
    // `others` is an evidence object attribute, so its ids count. This is our
    // reading of the doc sentence and it is asserted here, not assumed.
    const parsed = contestRequestSchema.parse({
      others: [{ type: 'receipt_signed_by_customer', document_ids: ['doc_EFtmUsbwpXwBH1'] }],
      action: 'submit',
    });
    expect(parsed.action).toBe('submit');
  });

  it('allows a draft with no documents, which is how every draft starts', () => {
    expect(() => contestRequestSchema.parse({ summary: 'drafting', action: 'draft' })).not.toThrow();
  });

  it('counts document ids across typed fields and `others` together', () => {
    expect(
      countContestDocumentIds({
        shipping_proof: ['doc_a', 'doc_b'],
        access_activity_log: ['doc_c'],
        others: [{ type: 'x', document_ids: ['doc_d', 'doc_e'] }],
      }),
    ).toBe(5);
    expect(countContestDocumentIds({})).toBe(0);
  });
});

describe('the documented summary limit', () => {
  it('accepts a summary of exactly the documented maximum', () => {
    const parsed = contestRequestSchema.parse({ summary: 'x'.repeat(EVIDENCE_SUMMARY_MAX_CHARS) });
    expect(parsed.summary).toHaveLength(1000);
  });

  it('rejects a summary one character over', () => {
    expect(() =>
      contestRequestSchema.parse({ summary: 'x'.repeat(EVIDENCE_SUMMARY_MAX_CHARS + 1) }),
    ).toThrow(/1000-character limit/);
  });

  it('does NOT cap the summary on the read path', () => {
    // We must be able to parse whatever Razorpay returns; we constrain only
    // what we produce. See DECISIONS.md D-003.
    const evidence = {
      ...(contestDraftResponse as { evidence: Record<string, unknown> }).evidence,
      summary: 'x'.repeat(EVIDENCE_SUMMARY_MAX_CHARS + 500),
    };
    expect(() => disputeEvidenceSchema.parse(evidence)).not.toThrow();
  });
});

describe('contest amount against the dispute it contests', () => {
  const dispute = { amount: 10000 };

  it('accepts a partial contest', () => {
    expect(() => contestRequestForDispute(dispute).parse({ amount: 5000 })).not.toThrow();
  });

  it('accepts a contest for exactly the disputed amount', () => {
    expect(() => contestRequestForDispute(dispute).parse({ amount: 10000 })).not.toThrow();
  });

  it('rejects a contest for more than the disputed amount', () => {
    expect(() => contestRequestForDispute(dispute).parse({ amount: 10001 })).toThrow(
      /exceeds the disputed amount/,
    );
  });

  it('still enforces the submit precondition', () => {
    expect(() => contestRequestForDispute(dispute).parse({ amount: 5000, action: 'submit' })).toThrow(
      /minimum of one document id/,
    );
  });
});

describe('contest request, failing loudly', () => {
  it('rejects an undocumented field', () => {
    expect(() => contestRequestSchema.parse({ summary: 'hi', urgency: 'high' })).toThrow();
  });

  it('rejects an undocumented action', () => {
    expect(() => contestRequestSchema.parse({ action: 'appeal' })).toThrow();
  });

  it('rejects a non-document id in a typed evidence field', () => {
    expect(() => contestRequestSchema.parse({ shipping_proof: ['EFtmUsbwpXwBH9'] })).toThrow();
  });

  it('rejects a payment id where a document id belongs', () => {
    expect(() => contestRequestSchema.parse({ billing_proof: ['pay_EsyWjHrfzb59eR'] })).toThrow();
  });

  it('rejects a fractional amount', () => {
    expect(() => contestRequestSchema.parse({ amount: 50.5 })).toThrow();
  });

  it('rejects an `others` entry with no type label', () => {
    expect(() =>
      contestRequestSchema.parse({ others: [{ document_ids: ['doc_EFtmUsbwpXwBH1'] }] }),
    ).toThrow();
  });

  it('rejects null where the write path expects omission', () => {
    // Read is nullable, write is optional. Sending an explicit null is us
    // guessing at an API we have not seen accept it.
    expect(() => contestRequestSchema.parse({ shipping_proof: null })).toThrow();
  });
});
