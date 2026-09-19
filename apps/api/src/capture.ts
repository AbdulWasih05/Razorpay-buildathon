import { Prisma, type PrismaClient } from '@prisma/client';
import type { EvidencePackIngest } from '@praman/core';

/**
 * Prisma types JSON columns as its own `InputJsonValue`, which a plain
 * `Record<string, unknown>` does not satisfy structurally. The values here are
 * already schema-validated by Zod at the route boundary, so this narrows once,
 * in one named place, rather than scattering casts through the writer.
 */
const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * The capture layer's only writer.
 *
 * Everything -- seeding included -- goes through here. Nothing writes an
 * evidence pack directly to the database, which is what keeps the capture
 * endpoint an actual component rather than a box on an architecture diagram
 * that a seed script quietly bypasses.
 *
 * Idempotent by construction: every entity upserts on its caller-supplied
 * `externalId`, so replaying a capture is a no-op rather than a duplicate.
 * Reseeding the corpus is therefore safe and repeatable.
 *
 * One transaction. A half-captured pack is worse than none: it would look like
 * evidence at dispute time and then fail to support the contest.
 */
export async function captureEvidencePack(
  prisma: PrismaClient,
  input: EvidencePackIngest,
): Promise<{ evidencePackId: string; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.evidencePack.findUnique({
      where: { externalId: input.externalId },
      select: { id: true },
    });

    const merchant = await tx.merchant.upsert({
      where: { externalId: input.merchant.externalId },
      create: {
        externalId: input.merchant.externalId,
        name: input.merchant.name,
        category: input.merchant.category,
        occurredAt: input.merchant.occurredAt,
      },
      update: {
        name: input.merchant.name,
        category: input.merchant.category,
        occurredAt: input.merchant.occurredAt,
      },
      select: { id: true },
    });

    const customer = await tx.customer.upsert({
      where: { externalId: input.customer.externalId },
      create: {
        externalId: input.customer.externalId,
        merchantId: merchant.id,
        name: input.customer.name,
        email: input.customer.email,
        contact: input.customer.contact,
        occurredAt: input.customer.occurredAt,
      },
      update: {
        merchantId: merchant.id,
        name: input.customer.name,
        email: input.customer.email,
        contact: input.customer.contact,
        occurredAt: input.customer.occurredAt,
      },
      select: { id: true },
    });

    let mandateId: string | null = null;
    if (input.mandate) {
      const mandate = await tx.mandate.upsert({
        where: { externalId: input.mandate.externalId },
        create: {
          externalId: input.mandate.externalId,
          merchantId: merchant.id,
          customerId: customer.id,
          agentId: input.mandate.agentId,
          agentPlatform: input.mandate.agentPlatform,
          payerVpa: input.mandate.payerVpa,
          consentAt: input.mandate.consentAt,
          validFrom: input.mandate.validFrom,
          validUntil: input.mandate.validUntil,
          maxAmount: input.mandate.maxAmount,
          currency: input.mandate.currency,
          status: input.mandate.status,
          occurredAt: input.mandate.occurredAt,
        },
        update: {
          agentId: input.mandate.agentId,
          agentPlatform: input.mandate.agentPlatform,
          payerVpa: input.mandate.payerVpa,
          consentAt: input.mandate.consentAt,
          validFrom: input.mandate.validFrom,
          validUntil: input.mandate.validUntil,
          maxAmount: input.mandate.maxAmount,
          currency: input.mandate.currency,
          status: input.mandate.status,
          occurredAt: input.mandate.occurredAt,
        },
        select: { id: true },
      });
      mandateId = mandate.id;
    }

    const order = await tx.order.upsert({
      where: { externalId: input.order.externalId },
      create: {
        externalId: input.order.externalId,
        merchantId: merchant.id,
        customerId: customer.id,
        amount: input.order.amount,
        currency: input.order.currency,
        status: input.order.status,
        itemsJson: asJson(input.order.items),
        placedAt: input.order.placedAt,
        occurredAt: input.order.occurredAt,
      },
      update: {
        amount: input.order.amount,
        currency: input.order.currency,
        status: input.order.status,
        itemsJson: asJson(input.order.items),
        placedAt: input.order.placedAt,
        occurredAt: input.order.occurredAt,
      },
      select: { id: true },
    });

    await tx.payment.upsert({
      where: { externalId: input.payment.externalId },
      create: {
        externalId: input.payment.externalId,
        // The column is provider-neutral; the capture envelope's field name is
        // not, and deliberately stays the merchant-facing contract.
        provider: 'razorpay',
        providerPaymentId: input.payment.razorpayPaymentId,
        orderId: order.id,
        amount: input.payment.amount,
        currency: input.payment.currency,
        method: input.payment.method,
        status: input.payment.status,
        vpa: input.payment.vpa ?? null,
        capturedAt: input.payment.capturedAt ?? null,
        occurredAt: input.payment.occurredAt,
      },
      update: {
        providerPaymentId: input.payment.razorpayPaymentId,
        amount: input.payment.amount,
        currency: input.payment.currency,
        method: input.payment.method,
        status: input.payment.status,
        vpa: input.payment.vpa ?? null,
        capturedAt: input.payment.capturedAt ?? null,
        occurredAt: input.payment.occurredAt,
      },
    });

    if (input.fulfillment) {
      await tx.fulfillment.upsert({
        where: { externalId: input.fulfillment.externalId },
        create: {
          externalId: input.fulfillment.externalId,
          orderId: order.id,
          status: input.fulfillment.status,
          carrier: input.fulfillment.carrier ?? null,
          trackingId: input.fulfillment.trackingId ?? null,
          shippedAt: input.fulfillment.shippedAt ?? null,
          deliveredAt: input.fulfillment.deliveredAt ?? null,
          proofRef: input.fulfillment.proofRef ?? null,
          occurredAt: input.fulfillment.occurredAt,
        },
        update: {
          status: input.fulfillment.status,
          carrier: input.fulfillment.carrier ?? null,
          trackingId: input.fulfillment.trackingId ?? null,
          shippedAt: input.fulfillment.shippedAt ?? null,
          deliveredAt: input.fulfillment.deliveredAt ?? null,
          proofRef: input.fulfillment.proofRef ?? null,
          occurredAt: input.fulfillment.occurredAt,
        },
      });
    }

    if (input.refund) {
      await tx.refund.upsert({
        where: { externalId: input.refund.externalId },
        create: {
          externalId: input.refund.externalId,
          orderId: order.id,
          amount: input.refund.amount,
          currency: input.refund.currency,
          status: input.refund.status,
          utr: input.refund.utr ?? null,
          settledAt: input.refund.settledAt ?? null,
          initiatedAt: input.refund.initiatedAt,
          occurredAt: input.refund.occurredAt,
        },
        update: {
          amount: input.refund.amount,
          currency: input.refund.currency,
          status: input.refund.status,
          utr: input.refund.utr ?? null,
          settledAt: input.refund.settledAt ?? null,
          initiatedAt: input.refund.initiatedAt,
          occurredAt: input.refund.occurredAt,
        },
      });
    }

    const packData = {
      merchantId: merchant.id,
      orderId: order.id,
      mandateId,
      rail: input.rail,
      agentId: input.agentic?.agentId ?? null,
      agentPlatform: input.agentic?.agentPlatform ?? null,
      protocol: input.agentic?.protocol ?? null,
      protocolVersion: input.agentic?.protocolVersion ?? null,
      protocolMetadata: asJson(input.agentic?.protocolMetadata ?? {}),
      capturedAt: input.capturedAt,
      occurredAt: input.occurredAt,
    };

    const pack = await tx.evidencePack.upsert({
      where: { externalId: input.externalId },
      create: { externalId: input.externalId, ...packData },
      update: packData,
      select: { id: true },
    });

    if (input.conversationTrace) {
      const trace = await tx.conversationTrace.upsert({
        where: { externalId: input.conversationTrace.externalId },
        create: {
          externalId: input.conversationTrace.externalId,
          evidencePackId: pack.id,
          startedAt: input.conversationTrace.startedAt,
          occurredAt: input.conversationTrace.occurredAt,
        },
        update: {
          startedAt: input.conversationTrace.startedAt,
          occurredAt: input.conversationTrace.occurredAt,
        },
        select: { id: true },
      });

      for (const turn of input.conversationTrace.turns) {
        await tx.conversationTurn.upsert({
          where: { externalId: turn.externalId },
          create: {
            externalId: turn.externalId,
            traceId: trace.id,
            seq: turn.seq,
            role: turn.role,
            content: turn.content,
            occurredAt: turn.occurredAt,
          },
          update: {
            seq: turn.seq,
            role: turn.role,
            content: turn.content,
            occurredAt: turn.occurredAt,
          },
        });
      }
    }

    for (const entry of input.orchestrationLogs) {
      await tx.orchestrationLog.upsert({
        where: { externalId: entry.externalId },
        create: {
          externalId: entry.externalId,
          evidencePackId: pack.id,
          seq: entry.seq,
          action: entry.action,
          actor: entry.actor,
          detail: asJson(entry.detail),
          occurredAt: entry.occurredAt,
        },
        update: {
          seq: entry.seq,
          action: entry.action,
          actor: entry.actor,
          detail: asJson(entry.detail),
          occurredAt: entry.occurredAt,
        },
      });
    }

    return { evidencePackId: pack.id, created: existing === null };
  });
}

/** Full readback of one captured pack, shaped for the debug view and prompt projection. */
export async function readEvidencePack(prisma: PrismaClient, externalId: string) {
  return prisma.evidencePack.findUnique({
    where: { externalId },
    include: {
      merchant: true,
      mandate: true,
      order: { include: { customer: true, payment: true, fulfillment: true } },
      conversationTrace: { include: { turns: { orderBy: { seq: 'asc' } } } },
      orchestrationLogs: { orderBy: { seq: 'asc' } },
    },
  });
}
