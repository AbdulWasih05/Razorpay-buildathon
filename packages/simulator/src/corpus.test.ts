import { describe, expect, it } from 'vitest';

import {
  SCENARIOS,
  SCENARIO_CLASSES,
  canonicalise,
  disputeWebhookEventSchema,
  evidencePackIngestSchema,
  findForbiddenPromptKeys,
  toPromptInput,
} from '@praman/core';

import { DEV_CONFIG, OOD_CONFIG } from './configs.js';
import { allocate, generateCorpus, summarise } from './corpus.js';
import { isSimulatedId } from './ids.js';
import { generateTransaction } from './transaction.js';

const CORPUS_SIZE = 100;

describe('determinism -- same seed, logically identical output', () => {
  it('produces byte-identical canonical output across two independent runs', () => {
    const first = generateCorpus(DEV_CONFIG, CORPUS_SIZE);
    const second = generateCorpus(DEV_CONFIG, CORPUS_SIZE);

    // Canonical serialisation excludes server-generated row ids and creation
    // timestamps -- there are none here, since nothing has touched the database
    // yet, but the same comparison is what the store round-trip uses.
    expect(canonicalise(second.disputes)).toBe(canonicalise(first.disputes));
  });

  it('produces identical transactions when a single case is regenerated', () => {
    const a = generateTransaction(DEV_CONFIG, 'b1', 7);
    const b = generateTransaction(DEV_CONFIG, 'b1', 7);
    expect(canonicalise(b)).toBe(canonicalise(a));
  });

  it('gives each scenario class an independent stream, so editing one cannot shift another', () => {
    // Positional independence: b1 index 7 must not depend on how many a1s exist.
    const fromFullCorpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE).disputes.find(
      (d) => d.scenarioClass === 'b1',
    );
    const direct = generateTransaction(DEV_CONFIG, 'b1', fromFullCorpus?.transaction.index ?? 0);
    expect(canonicalise(direct.pack)).toBe(canonicalise(fromFullCorpus?.transaction.pack));
  });

  it('uses no wall-clock time: every generated instant sits at the fixed corpus epoch', () => {
    const corpus = generateCorpus(DEV_CONFIG, 20);
    const now = Date.now();
    for (const dispute of corpus.disputes) {
      // Every timestamp is an offset from a hard-coded 2026-06-01 epoch, so none
      // of them can land within a few seconds of "now" on a repeat run.
      expect(Math.abs(dispute.raisedAt.getTime() - now)).toBeGreaterThan(60_000);
    }
  });
});

describe('prompt inputs touch only seed-derived fields', () => {
  /**
   * The guard for DECISIONS.md D-007. If a server-generated cuid or a wall-clock
   * `createdAt` reaches a prompt, reseeding changes the request hash, every
   * committed replay fixture misses, and eval silently goes live. The failure is
   * invisible at runtime, so it is caught here instead.
   */
  function readbackWith(serverSuffix: string) {
    const transaction = generateTransaction(DEV_CONFIG, 'b1', 3);
    const pack = transaction.pack;
    return {
      // Server-generated fields, deliberately different between the two calls.
      id: `cuid_pack_${serverSuffix}`,
      createdAt: new Date(),
      merchantId: `cuid_merchant_${serverSuffix}`,
      orderId: `cuid_order_${serverSuffix}`,
      mandateId: `cuid_mandate_${serverSuffix}`,

      externalId: pack.externalId,
      rail: pack.rail,
      capturedAt: pack.capturedAt,
      occurredAt: pack.occurredAt,
      agentId: pack.agentic?.agentId ?? null,
      agentPlatform: pack.agentic?.agentPlatform ?? null,
      protocol: pack.agentic?.protocol ?? null,
      protocolVersion: pack.agentic?.protocolVersion ?? null,
      order: {
        id: `cuid_order_${serverSuffix}`,
        createdAt: new Date(),
        externalId: pack.order.externalId,
        amount: pack.order.amount,
        currency: 'INR',
        status: pack.order.status,
        placedAt: pack.order.placedAt,
      },
      mandate: pack.mandate
        ? {
            id: `cuid_mandate_${serverSuffix}`,
            createdAt: new Date(),
            externalId: pack.mandate.externalId,
            agentId: pack.mandate.agentId,
            agentPlatform: pack.mandate.agentPlatform,
            consentAt: pack.mandate.consentAt,
            validFrom: pack.mandate.validFrom,
            validUntil: pack.mandate.validUntil,
            maxAmount: pack.mandate.maxAmount,
            currency: 'INR',
            status: pack.mandate.status,
          }
        : null,
      conversationTrace: pack.conversationTrace
        ? {
            id: `cuid_trace_${serverSuffix}`,
            turns: pack.conversationTrace.turns.map((turn) => ({
              id: `cuid_turn_${serverSuffix}_${turn.seq}`,
              createdAt: new Date(),
              traceId: `cuid_trace_${serverSuffix}`,
              seq: turn.seq,
              role: turn.role,
              content: turn.content,
              occurredAt: turn.occurredAt,
            })),
          }
        : null,
      orchestrationLogs: (pack.orchestrationLogs ?? []).map((entry) => ({
        id: `cuid_log_${serverSuffix}_${entry.seq}`,
        createdAt: new Date(),
        evidencePackId: `cuid_pack_${serverSuffix}`,
        seq: entry.seq,
        action: entry.action,
        actor: entry.actor,
        detail: entry.detail,
        occurredAt: entry.occurredAt,
      })),
    };
  }

  it('carries no forbidden key at any depth', () => {
    const promptInput = toPromptInput(readbackWith('alpha'));
    expect(findForbiddenPromptKeys(promptInput)).toEqual([]);
  });

  it('is unchanged when every server-generated id and timestamp differs', () => {
    // This is the real assertion: two stores holding the same seeded data must
    // produce byte-identical prompt input, hence an identical request hash.
    const alpha = JSON.stringify(toPromptInput(readbackWith('alpha')));
    const beta = JSON.stringify(toPromptInput(readbackWith('beta')));
    expect(beta).toBe(alpha);
  });

  it('still carries the evidence a defense actually needs', () => {
    // A projection that leaked nothing but also said nothing would pass the test
    // above while being useless. Assert the substance survived.
    const promptInput = toPromptInput(readbackWith('alpha'));
    expect(promptInput.mandate?.maxAmount).toBeGreaterThan(0);
    expect(promptInput.conversationTurns.length).toBeGreaterThan(0);
    expect(promptInput.orchestrationLogs.some((l) => l.action === 'payment_captured')).toBe(true);
  });
});

describe('synthetic ids announce that they are synthetic', () => {
  /**
   * P0.2 (obtain real Razorpay test-mode `pay_` ids) was cut once the docs
   * confirmed a test account cannot originate a dispute, so these ids are
   * synthetic permanently rather than until Wednesday. That changes what
   * honesty requires of them: `pay_LkvKHWZCvw7WFk` is indistinguishable from a
   * real payment id, and the judges are the engineers who own that namespace.
   *
   * Hard rule #6 says a simulated thing is labelled wherever it is rendered.
   * The only way to guarantee that for an id is to put the label inside it.
   */
  const corpus = generateCorpus(DEV_CONFIG, 20);

  it('marks every id in the Razorpay namespace', () => {
    for (const dispute of corpus.disputes) {
      const entity = dispute.event.payload.dispute.entity;
      expect(isSimulatedId(entity.id), entity.id).toBe(true);
      expect(isSimulatedId(entity.payment_id), entity.payment_id).toBe(true);
      expect(
        isSimulatedId(dispute.transaction.pack.payment.razorpayPaymentId),
        dispute.transaction.pack.payment.razorpayPaymentId,
      ).toBe(true);
    }
  });

  it('keeps the documented shape, so no schema check is weakened', () => {
    // The marker must cost nothing: prefix plus exactly 14 base62 characters,
    // which is what every startsWith() check and every contract test assumes.
    for (const dispute of corpus.disputes) {
      const paymentId = dispute.transaction.pack.payment.razorpayPaymentId;
      expect(paymentId).toMatch(/^pay_[A-Za-z0-9]{14}$/);
      expect(dispute.event.payload.dispute.entity.id).toMatch(/^disp_[A-Za-z0-9]{14}$/);
    }
  });

  it('leaves the merchant store namespace unmarked', () => {
    // `ord_`, `ful_`, `mdt_` are ours and cannot be mistaken for Razorpay's, so
    // marking them would be noise that trains a reader to ignore the marker.
    for (const dispute of corpus.disputes) {
      expect(isSimulatedId(dispute.transaction.pack.order.externalId)).toBe(false);
    }
  });
});

describe('allocation', () => {
  it('sums to exactly the requested size', () => {
    for (const size of [60, 100, 137, 30]) {
      const counts = allocate(DEV_CONFIG.distribution, size);
      const total = SCENARIO_CLASSES.reduce((sum, cls) => sum + counts[cls], 0);
      expect(total).toBe(size);
    }
  });

  it('is stable across calls', () => {
    expect(allocate(DEV_CONFIG.distribution, 100)).toEqual(allocate(DEV_CONFIG.distribution, 100));
  });
});

describe('dev corpus shape', () => {
  const corpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE);
  const stats = summarise(corpus);

  it('generates 100+ disputes across both rails', () => {
    expect(corpus.size).toBe(CORPUS_SIZE);
    expect(stats.byRail.ordinary).toBeGreaterThan(0);
    expect(stats.byRail.agentic).toBeGreaterThan(0);
  });

  it('covers every scenario class', () => {
    for (const cls of SCENARIO_CLASSES) {
      expect(stats.byClass[cls], `class ${cls} missing`).toBeGreaterThan(0);
    }
  });

  it('is at least 20% unwinnable or ambiguous', () => {
    // A corpus of only winnable disputes is the cherry-picking the track page
    // explicitly calls out. The hard cases are the point.
    expect(stats.hardShare).toBeGreaterThanOrEqual(0.2);
  });

  it('contains all three ground-truth labels', () => {
    expect(stats.byGroundTruth.winnable).toBeGreaterThan(0);
    expect(stats.byGroundTruth.unwinnable).toBeGreaterThan(0);
    expect(stats.byGroundTruth.ambiguous).toBeGreaterThan(0);
  });

  it('gives every dispute a non-empty ground-truth rationale', () => {
    for (const dispute of corpus.disputes) {
      expect(dispute.groundTruthRationale.length).toBeGreaterThan(20);
    }
  });
});

describe('every dispute is contract-valid and references a real transaction', () => {
  const corpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE);

  it('validates against the Razorpay webhook contract schema', () => {
    for (const dispute of corpus.disputes) {
      expect(() => disputeWebhookEventSchema.parse(dispute.event)).not.toThrow();
    }
  });

  it('validates every capture envelope against the ingest contract', () => {
    for (const dispute of corpus.disputes) {
      expect(() => evidencePackIngestSchema.parse(dispute.transaction.pack)).not.toThrow();
    }
  });

  it('points each dispute at the payment of its own transaction', () => {
    for (const dispute of corpus.disputes) {
      const entity = dispute.event.payload.dispute.entity;
      expect(entity.payment_id).toBe(dispute.transaction.pack.payment.razorpayPaymentId);
      expect(entity.payment_id).toBe(dispute.event.payload.payment.entity.id);
      expect(entity.amount).toBe(dispute.transaction.pack.order.amount);
    }
  });

  it('raises every dispute after capture, with a response deadline after that', () => {
    for (const dispute of corpus.disputes) {
      const entity = dispute.event.payload.dispute.entity;
      expect(entity.created_at).toBeGreaterThan(
        Math.floor(dispute.transaction.capturedAt.getTime() / 1000),
      );
      expect(entity.respond_by).toBeGreaterThan(entity.created_at);
    }
  });

  it('uses the reason code its scenario class declares', () => {
    for (const dispute of corpus.disputes) {
      expect(dispute.event.payload.dispute.entity.reason_code).toBe(
        SCENARIOS[dispute.scenarioClass].reasonCode,
      );
    }
  });
});

describe('ground truth agrees with the evidence that was generated', () => {
  const corpus = generateCorpus(DEV_CONFIG, CORPUS_SIZE);

  it('labels every mandate-limit breach unwinnable, and the breach is real', () => {
    const cases = corpus.disputes.filter((d) => d.scenarioClass === 'b2');
    expect(cases.length).toBeGreaterThan(0);
    for (const dispute of cases) {
      expect(dispute.groundTruth).toBe('unwinnable');
      const mandate = dispute.transaction.pack.mandate;
      expect(mandate).not.toBeNull();
      expect(dispute.amount).toBeGreaterThan(mandate?.maxAmount ?? Infinity);
    }
  });

  it('labels every expired-mandate case unwinnable, and the window really had closed', () => {
    const cases = corpus.disputes.filter((d) => d.scenarioClass === 'b3');
    expect(cases.length).toBeGreaterThan(0);
    for (const dispute of cases) {
      expect(dispute.groundTruth).toBe('unwinnable');
      const validUntil = new Date(String(dispute.transaction.pack.mandate?.validUntil));
      expect(validUntil.getTime()).toBeLessThan(dispute.transaction.capturedAt.getTime());
    }
  });

  it('only calls an a1 winnable when a delivery proof actually exists', () => {
    for (const dispute of corpus.disputes.filter((d) => d.scenarioClass === 'a1')) {
      if (dispute.groundTruth === 'winnable') {
        expect(dispute.transaction.pack.fulfillment?.proofRef).toBeTruthy();
      }
    }
  });

  it('keeps every agentic pack carrying the evidence that makes it defensible', () => {
    for (const dispute of corpus.disputes.filter((d) => d.rail === 'agentic')) {
      const pack = dispute.transaction.pack;
      expect(pack.mandate).toBeTruthy();
      expect(pack.agentic).toBeTruthy();
      expect(pack.conversationTrace?.turns.length).toBeGreaterThan(0);
      expect((pack.orchestrationLogs ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe('the held-out config is out-of-distribution by construction', () => {
  it('shares no merchant, customer name, item or agent platform with dev', () => {
    const devMerchants = new Set(DEV_CONFIG.merchants.map((m) => m.name));
    const devItems = new Set(DEV_CONFIG.items.map((i) => i.sku));
    const devNames = new Set(DEV_CONFIG.customerNames);
    const devPlatforms = new Set(DEV_CONFIG.agentPlatforms.map((p) => p.platform));

    for (const m of OOD_CONFIG.merchants) expect(devMerchants.has(m.name)).toBe(false);
    for (const i of OOD_CONFIG.items) expect(devItems.has(i.sku)).toBe(false);
    for (const n of OOD_CONFIG.customerNames) expect(devNames.has(n)).toBe(false);
    for (const p of OOD_CONFIG.agentPlatforms) expect(devPlatforms.has(p.platform)).toBe(false);
  });

  it('uses a different class mix and a different order-value band', () => {
    expect(OOD_CONFIG.distribution).not.toEqual(DEV_CONFIG.distribution);
    expect(OOD_CONFIG.orderValue.max).toBeGreaterThan(DEV_CONFIG.orderValue.max);
  });

  it('sources its conversation language from a different model, not from templates', () => {
    // The structural axes above could all be matched by a careful hand-write.
    // This is the one that makes the holdout genuinely another distribution.
    expect(DEV_CONFIG.languageSource).toBe('template');
    expect(OOD_CONFIG.languageSource).toBe('llm');
  });

  it('still produces a contract-valid corpus', () => {
    const ood = generateCorpus(OOD_CONFIG, 30);
    expect(ood.size).toBe(30);
    for (const dispute of ood.disputes) {
      expect(() => disputeWebhookEventSchema.parse(dispute.event)).not.toThrow();
    }
  });
});
