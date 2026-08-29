import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DISPUTE_PHASES,
  DISPUTE_STATUSES,
  disputeCollectionSchema,
  disputeEntitySchema,
  disputeEvidenceSchema,
} from './dispute.js';
import { DISPUTE_WEBHOOK_EVENTS, disputeWebhookEventSchema } from './webhook.js';

/**
 * These are CONTRACT tests. They assert our schemas against payloads copied
 * verbatim from Razorpay's published docs (see ../fixtures/PROVENANCE.md).
 * If Razorpay's contract and ours diverge, these fail. Fix the schema, never
 * the fixture.
 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const fetchAll = fixture('dispute-fetch-all.json');
const contestDraftResponse = fixture('dispute-contest-draft-response.json');
const webhookCreated = fixture('webhook-payment-dispute-created.json');

describe('dispute entity, against verbatim doc examples', () => {
  it('parses the GET /disputes collection example', () => {
    const parsed = disputeCollectionSchema.parse(fetchAll);
    expect(parsed.count).toBe(2);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.id).toBe('disp_Esz7KAitoYM7PJ');
    expect(parsed.items[0]?.phase).toBe('pre_arbitration');
    expect(parsed.items[1]?.status).toBe('won');
    // The second item carries real document ids in a typed evidence field.
    expect(parsed.items[1]?.evidence.shipping_proof).toEqual([
      'doc_EFtmUsbwpXwBH9',
      'doc_EFtmUsbwpXwBH8',
    ]);
  });

  it('parses the contest-draft response example, including a populated `others`', () => {
    const parsed = disputeEntitySchema.parse(contestDraftResponse);
    expect(parsed.id).toBe('disp_AHfqOvkldwsbqt');
    expect(parsed.evidence.summary).toBe('goods delivered');
    expect(parsed.evidence.others).toEqual([
      {
        type: 'receipt_signed_by_customer',
        document_ids: ['doc_EFtmUsbwpXwBH1', 'doc_EFtmUsbwpXwBH7'],
      },
    ]);
    // Evidence amount may differ from the disputed amount (partial contest).
    expect(parsed.amount).toBe(10000);
    expect(parsed.evidence.amount).toBe(5000);
  });

  it('models exactly the evidence keys the docs print -- no more, no fewer', () => {
    const docKeys = Object.keys(
      (contestDraftResponse as { evidence: Record<string, unknown> }).evidence,
    ).sort();
    const schemaKeys = Object.keys(disputeEvidenceSchema.shape).sort();
    expect(schemaKeys).toEqual(docKeys);
  });
});

describe('dispute entity, failing loudly', () => {
  const valid = disputeEntitySchema.parse(contestDraftResponse);

  it('rejects an undocumented extra field', () => {
    expect(() => disputeEntitySchema.parse({ ...valid, invented_field: 'nope' })).toThrow();
  });

  it('rejects an undocumented phase', () => {
    expect(() => disputeEntitySchema.parse({ ...valid, phase: 'mediation' })).toThrow();
  });

  it('rejects an undocumented status', () => {
    expect(() => disputeEntitySchema.parse({ ...valid, status: 'pending' })).toThrow();
  });

  it('rejects a payment id in the dispute id field', () => {
    expect(() => disputeEntitySchema.parse({ ...valid, id: 'pay_EsyWjHrfzb59eR' })).toThrow();
  });

  it('rejects a non-document id inside a typed evidence field', () => {
    expect(() =>
      disputeEntitySchema.parse({
        ...valid,
        evidence: { ...valid.evidence, shipping_proof: ['not_a_doc_id'] },
      }),
    ).toThrow();
  });

  it('rejects a fractional amount (amounts are integer subunits)', () => {
    expect(() => disputeEntitySchema.parse({ ...valid, amount: 100.5 })).toThrow();
  });
});

describe('documented enum coverage', () => {
  it('carries all five documented phases', () => {
    expect([...DISPUTE_PHASES]).toEqual([
      'fraud',
      'retrieval',
      'chargeback',
      'pre_arbitration',
      'arbitration',
    ]);
  });

  it('carries all five documented statuses', () => {
    expect([...DISPUTE_STATUSES]).toEqual(['open', 'under_review', 'won', 'lost', 'closed']);
  });
});

describe('dispute webhook event, against the verbatim doc example', () => {
  it('parses payment.dispute.created', () => {
    const parsed = disputeWebhookEventSchema.parse(webhookCreated);
    expect(parsed.event).toBe('payment.dispute.created');
    expect(parsed.account_id).toBe('acc_CFvOKjkTwf3GQy');
    expect(parsed.contains).toEqual(['payment', 'dispute']);
    expect(parsed.payload.dispute.entity.id).toBe('disp_EsIAlDcoUr8CaQ');
    // The dispute must actually reference the payment it rode in with.
    expect(parsed.payload.dispute.entity.payment_id).toBe(parsed.payload.payment.entity.id);
  });

  it('accepts `notes: []`, the empty-map serialisation quirk in the doc example', () => {
    const parsed = disputeWebhookEventSchema.parse(webhookCreated);
    expect(parsed.payload.payment.entity.notes).toEqual([]);
  });

  it('names all six documented dispute events, `payment.`-prefixed', () => {
    expect([...DISPUTE_WEBHOOK_EVENTS]).toEqual([
      'payment.dispute.created',
      'payment.dispute.won',
      'payment.dispute.lost',
      'payment.dispute.closed',
      'payment.dispute.under_review',
      'payment.dispute.action_required',
    ]);
  });

  it('rejects an unprefixed event name', () => {
    expect(() =>
      disputeWebhookEventSchema.parse({ ...(webhookCreated as object), event: 'dispute.created' }),
    ).toThrow();
  });
});
