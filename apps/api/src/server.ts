import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  GROUND_TRUTH_LABELS,
  RAILS,
  SCENARIO_CLASSES,
  disputeWebhookEventSchema,
  evidencePackIngestSchema,
  toPromptInput,
} from '@praman/core';
import { DEV_CONFIG, generateTransaction } from '@praman/simulator';
import { z } from 'zod';

import { adapterFromEnv } from '@praman/adapter';
import { AssemblyClient, ResponseCache, providerFromEnv } from '@praman/llm';

import { captureEvidencePack, readEvidencePack } from './capture.js';
import { approveAndSubmit, listQueue, readDispute, runPipeline } from './review.js';

/**
 * When this process started. Reported by `/health` so a caller can tell a
 * freshly started server from a stale one still holding the port (F-015).
 */
const STARTED_AT = new Date().toISOString();

/** The committed eval report, served by `GET /eval/report`. */
const EVAL_REPORT_PATH = fileURLToPath(new URL('../../../eval/results.md', import.meta.url));

const asJsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * A generated dispute plus the corpus bookkeeping that only a seeded eval case
 * carries. The `event` half is the verbatim Razorpay webhook envelope and is
 * validated by the same contract schema the real ingest path uses; the `meta`
 * half is ours and is clearly separated so the two never blur together.
 */
const disputeSeedSchema = z
  .object({
    event: disputeWebhookEventSchema,
    meta: z
      .object({
        externalId: z.string().min(1),
        rail: z.enum(RAILS),
        scenarioClass: z.enum(SCENARIO_CLASSES),
        corpus: z.enum(['dev', 'ood_holdout']),
        seed: z.string().min(1),
        groundTruth: z.enum(GROUND_TRUTH_LABELS),
        groundTruthRationale: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * The Praman API.
 *
 * The route that matters here is `POST /evidence-pack`. It is the capture
 * layer: the surface that records agentic evidence at transaction time, months
 * before any dispute exists. Seeding goes through it like everything else, so
 * the architecture diagram's "capture layer" points at a real component rather
 * than at a seed script that writes to the database behind its back.
 */

export interface BuildServerOptions {
  prisma?: PrismaClient;
  logger?: boolean;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const prisma = options.prisma ?? new PrismaClient();
  const app = Fastify({ logger: options.logger ?? false });

  app.decorate('prisma', prisma);

  /**
   * Whether this server may call a model, decided once and surfaced.
   *
   * Declared here rather than beside the client because `/health` reports it.
   * F-015: a stale server from an earlier session was answering on this port in
   * live mode while a newly started one had silently failed with EADDRINUSE,
   * and nothing a caller could see distinguished them. A health check that says
   * only "ok" answers the least useful question about a running process.
   */
  const assemblyMode = process.env['ASSEMBLY_MODE'] === 'live' ? 'live' : 'replay';
  const assemblyCache = new ResponseCache();

  app.get('/health', async () => ({
    status: 'ok',
    assemblyMode,
    recordings: assemblyCache.size,
    startedAt: STARTED_AT,
    pid: process.pid,
  }));

  /**
   * The eval report, served verbatim.
   *
   * TASKS.md P4.2 asks for a metrics page whose acceptance criterion is that it
   * "matches `eval/results.md` numbers exactly". The cheapest way to guarantee
   * that is not to recompute the numbers carefully -- it is to have no second
   * computation at all. This hands over the committed report as bytes and the
   * UI renders it, so the dashboard and the report cannot drift apart, because
   * they are the same artifact.
   *
   * It also means every caveat travels with every number for free: the ₹0
   * false-positive cost arrives with the paragraph explaining what zero does
   * and does not show, which is exactly what hard rule #6 asks for and exactly
   * what a hand-built dashboard would have quietly dropped.
   */
  app.get('/eval/report', async (_request, reply) => {
    try {
      const report = await readFile(EVAL_REPORT_PATH, 'utf8');
      return reply.type('text/markdown; charset=utf-8').send(report);
    } catch {
      return reply.code(404).send({
        error: 'no eval report on disk',
        detail: `expected ${EVAL_REPORT_PATH}. Run: pnpm eval`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  app.post('/evidence-pack', async (request, reply) => {
    const parsed = evidencePackIngestSchema.safeParse(request.body);

    if (!parsed.success) {
      // Reject at the door with the specific field problems. An evidence pack
      // that is wrong here is worse than one that is missing: it would look like
      // evidence at dispute time and fail to support the contest.
      return reply.status(400).send({
        error: 'invalid_evidence_pack',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const result = await captureEvidencePack(prisma, parsed.data);

    return reply.status(result.created ? 201 : 200).send({
      externalId: parsed.data.externalId,
      rail: parsed.data.rail,
      created: result.created,
      // Idempotent: re-posting the same pack updates in place rather than
      // duplicating, so reseeding is safe.
      idempotent: !result.created,
    });
  });

  // -------------------------------------------------------------------------
  // Debug / inspection -- how a captured transaction reads back
  // -------------------------------------------------------------------------

  app.get('/evidence-packs', async (_request, reply) => {
    const packs = await prisma.evidencePack.findMany({
      orderBy: { occurredAt: 'asc' },
      select: { externalId: true, rail: true, agentPlatform: true, capturedAt: true },
      take: 200,
    });
    return reply.send({ count: packs.length, items: packs });
  });

  app.get('/evidence-packs/:externalId', async (request, reply) => {
    const params = z.object({ externalId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_external_id' });

    const pack = await readEvidencePack(prisma, params.data.externalId);
    if (!pack) return reply.status(404).send({ error: 'not_found' });

    return reply.send({
      externalId: pack.externalId,
      rail: pack.rail,
      capturedAt: pack.capturedAt,
      merchant: { name: pack.merchant.name, category: pack.merchant.category },
      customer: { name: pack.order.customer.name, email: pack.order.customer.email },
      order: {
        externalId: pack.order.externalId,
        amount: pack.order.amount,
        currency: pack.order.currency,
        status: pack.order.status,
        items: pack.order.itemsJson,
      },
      payment: pack.order.payment && {
        razorpayPaymentId: pack.order.payment.razorpayPaymentId,
        amount: pack.order.payment.amount,
        method: pack.order.payment.method,
        status: pack.order.payment.status,
        vpa: pack.order.payment.vpa,
      },
      fulfillment: pack.order.fulfillment && {
        status: pack.order.fulfillment.status,
        carrier: pack.order.fulfillment.carrier,
        deliveredAt: pack.order.fulfillment.deliveredAt,
        proofRef: pack.order.fulfillment.proofRef,
      },
      mandate: pack.mandate && {
        externalId: pack.mandate.externalId,
        agentId: pack.mandate.agentId,
        agentPlatform: pack.mandate.agentPlatform,
        consentAt: pack.mandate.consentAt,
        validFrom: pack.mandate.validFrom,
        validUntil: pack.mandate.validUntil,
        maxAmount: pack.mandate.maxAmount,
        status: pack.mandate.status,
      },
      agentic: pack.agentId && {
        agentId: pack.agentId,
        agentPlatform: pack.agentPlatform,
        protocol: pack.protocol,
        protocolVersion: pack.protocolVersion,
        protocolMetadata: pack.protocolMetadata,
      },
      conversationTurns: pack.conversationTrace?.turns.map((turn) => ({
        seq: turn.seq,
        role: turn.role,
        content: turn.content,
        occurredAt: turn.occurredAt,
      })),
      orchestrationLogs: pack.orchestrationLogs.map((entry) => ({
        seq: entry.seq,
        action: entry.action,
        actor: entry.actor,
        detail: entry.detail,
        occurredAt: entry.occurredAt,
      })),
    });
  });

  /**
   * Exactly what an LLM prompt would be built from for this pack.
   *
   * Worth exposing: it makes the "prompt inputs are seed-derived only" rule
   * inspectable by a reviewer, instead of a claim in a document.
   */
  app.get('/evidence-packs/:externalId/prompt-input', async (request, reply) => {
    const params = z.object({ externalId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_external_id' });

    const pack = await readEvidencePack(prisma, params.data.externalId);
    if (!pack) return reply.status(404).send({ error: 'not_found' });

    return reply.send(
      toPromptInput({
        externalId: pack.externalId,
        rail: pack.rail,
        capturedAt: pack.capturedAt,
        occurredAt: pack.occurredAt,
        agentId: pack.agentId,
        agentPlatform: pack.agentPlatform,
        protocol: pack.protocol,
        protocolVersion: pack.protocolVersion,
        order: pack.order,
        mandate: pack.mandate,
        conversationTrace: pack.conversationTrace,
        orchestrationLogs: pack.orchestrationLogs,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Dispute seeding
  // -------------------------------------------------------------------------

  /**
   * Records a generated dispute against an already-captured transaction.
   *
   * Deliberately named `/seed/`. The body is the exact Razorpay webhook
   * envelope, but it arrives with a sidecar of corpus bookkeeping -- ground
   * truth label, scenario class, which corpus it belongs to -- that a real
   * webhook would never carry. Naming it a seeding route keeps that distinction
   * visible rather than dressing evaluation scaffolding up as production ingest.
   * The real `payment.dispute.created` consumer arrives with the pipeline in P3.
   */
  app.post('/seed/dispute', async (request, reply) => {
    const parsed = disputeSeedSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_dispute_seed',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const { event, meta } = parsed.data;
    const entity = event.payload.dispute.entity;

    const payment = await prisma.payment.findUnique({
      where: { razorpayPaymentId: entity.payment_id },
      select: { id: true },
    });
    if (!payment) {
      // A dispute must reference a transaction we actually captured. If it does
      // not, the capture step was skipped or ordered wrongly, and storing the
      // dispute anyway would produce a case with no evidence behind it.
      return reply.status(409).send({
        error: 'unknown_payment',
        message: `no captured payment for ${entity.payment_id}; capture the evidence pack first`,
      });
    }

    const data = {
      razorpayPaymentId: entity.payment_id,
      paymentId: payment.id,
      amount: entity.amount,
      currency: entity.currency,
      amountDeducted: entity.amount_deducted,
      reasonCode: entity.reason_code,
      reasonDescription: entity.reason_description ?? null,
      respondBy: new Date(entity.respond_by * 1000),
      status: entity.status,
      phase: entity.phase,
      raisedAt: new Date(entity.created_at * 1000),
      evidenceJson: asJsonValue(entity.evidence),
      rail: meta.rail,
      scenarioClass: meta.scenarioClass,
      corpus: meta.corpus,
      seed: meta.seed,
      groundTruth: meta.groundTruth,
      groundTruthRationale: meta.groundTruthRationale,
      occurredAt: new Date(entity.created_at * 1000),
    };

    const dispute = await prisma.dispute.upsert({
      where: { externalId: meta.externalId },
      create: { externalId: meta.externalId, razorpayDisputeId: entity.id, ...data },
      update: data,
      select: { id: true },
    });

    return reply.status(201).send({ disputeId: entity.id, stored: dispute.id });
  });

  // -------------------------------------------------------------------------
  // Demo affordance: a mock agent checkout that captures live
  // -------------------------------------------------------------------------

  /**
   * Emits one agentic evidence pack, live, before any dispute for it exists.
   * This is the demo beat that makes the capture-at-transaction-time argument
   * visible rather than narrated: the pack is written now; the dispute arrives
   * later; nothing had to be reconstructed.
   *
   * Rate limiting and the reset mechanism land with the public deploy (P4.3);
   * this endpoint is local-only until then.
   */
  app.post('/demo/agent-checkout', async (_request, reply) => {
    const existing = await prisma.evidencePack.count({ where: { rail: 'agentic' } });
    const transaction = generateTransaction(DEV_CONFIG, 'b1', 900 + existing);
    const parsed = evidencePackIngestSchema.parse(transaction.pack);
    const result = await captureEvidencePack(prisma, parsed);

    return reply.status(201).send({
      captured: true,
      externalId: parsed.externalId,
      agentId: transaction.pack.agentic?.agentId,
      mandateRef: transaction.pack.mandate?.externalId,
      amount: transaction.amount,
      conversationTurns: transaction.pack.conversationTrace?.turns.length ?? 0,
      orchestrationLogEntries: (transaction.pack.orchestrationLogs ?? []).length,
      evidencePackId: result.evidencePackId,
      inspect: `/evidence-packs/${parsed.externalId}`,
    });
  });

  // --- Review pipeline (TASKS.md P3.2, P3.3) -------------------------------

  /**
   * The assembly client is built once per server.
   *
   * Replay by default: the API never makes a live model call unless
   * `ASSEMBLY_MODE=live` is set explicitly. A demo that quietly calls a model
   * is a demo whose behaviour depends on a network and a rate limit.
   */
  const assemblyClient = new AssemblyClient({
    provider: providerFromEnv(
      assemblyMode === 'live' ? process.env : { GROQ_API_KEY: 'replay-only' },
    ),
    cache: assemblyCache,
    mode: assemblyMode,
  });

  // Announced at startup and exposed on /health, because F-015 was diagnosed
  // for twenty minutes on the assumption that a server was in replay mode. A
  // process whose eval-integrity behaviour is invisible is one you end up
  // reasoning about instead of reading.
  app.log.info(
    { assemblyMode, recordings: assemblyCache.size },
    assemblyMode === 'live'
      ? 'ASSEMBLY MODE: LIVE -- model calls will be made and recorded'
      : 'assembly mode: replay -- no model call will be made',
  );

  const adapter = adapterFromEnv(process.env, () => new Date());

  /** Run the pipeline over disputes that have not been processed yet. */
  app.post('/review/run', async (request, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(500).default(25),
        all: z.coerce.boolean().default(false),
        /**
         * Re-run only disputes currently in these states, e.g.
         * `?states=drafted,abstained`. Added in P4.0: closing a capture gap
         * changes what the collector can see, so every already-processed
         * dispute needs reprocessing -- but re-running a `submitted` one would
         * walk its state backwards while its audit trail still says submitted.
         * Naming the states is how a re-run stays inside the lifecycle.
         */
        states: z
          .string()
          .optional()
          .transform((value) =>
            value ? value.split(',').map((part) => part.trim()).filter(Boolean) : undefined,
          ),
      })
      .parse(request.query ?? {});

    const pending = await prisma.dispute.findMany({
      where: query.states ? { state: { in: query.states } } : query.all ? {} : { state: 'received' },
      orderBy: { respondBy: 'asc' },
      take: query.limit,
      select: { externalId: true },
    });

    const results: { externalId: string; state: string; error?: string }[] = [];
    for (const dispute of pending) {
      try {
        const result = await runPipeline({ prisma, client: assemblyClient }, dispute.externalId);
        results.push({ externalId: dispute.externalId, state: result.state });
      } catch (error) {
        // A replay miss or a broken pack must not abort the batch: the other
        // disputes are still processable and the failure is reported per case.
        results.push({
          externalId: dispute.externalId,
          state: 'error',
          error: (error as Error).message,
        });
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, result) => {
      acc[result.state] = (acc[result.state] ?? 0) + 1;
      return acc;
    }, {});
    // The denominator reconciles, out loud.
    //
    // A run reports how many disputes it touched, and `processed` alone cannot
    // be checked against anything: a filtered re-run of 97 and a silent drop of
    // 3 produce the same number. This returns the corpus total and what was
    // deliberately left out, so "97" is never a figure a reader has to trust.
    // It cost a round of questions in review when a run of 97 was reported
    // against a corpus of 100 with the difference living only in a query
    // parameter (F-015's class: a number stated without what produced it).
    const total = await prisma.dispute.count();
    const skipped = total - results.length;
    return reply.send({
      processed: results.length,
      corpusTotal: total,
      skipped,
      skippedBecause:
        skipped === 0
          ? null
          : query.states
            ? `not in states [${query.states.join(', ')}]`
            : query.all
              ? `limit ${query.limit} reached`
              : 'not in state "received"',
      counts,
      results,
    });
  });

  app.get('/review/queue', async (_request, reply) => {
    return reply.send({ disputes: await listQueue(prisma) });
  });

  app.get('/review/disputes/:externalId', async (request, reply) => {
    const params = z.object({ externalId: z.string().min(1) }).parse(request.params);
    const dispute = await readDispute(prisma, params.externalId);
    if (!dispute) return reply.status(404).send({ error: 'unknown_dispute' });
    return reply.send(dispute);
  });

  /**
   * THE DOOR (CLAUDE.md hard rule #2).
   *
   * The only route that can cause a submission. It requires a named reviewer;
   * there is no default and no service account. Everything downstream refuses
   * a non-human actor again, so this is defence in depth rather than the only
   * check.
   */
  app.post('/review/disputes/:externalId/approve', async (request, reply) => {
    const params = z.object({ externalId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        approvedBy: z
          .string()
          .min(1, 'an approval needs a named reviewer')
          .startsWith('human:', 'approvedBy must look like "human:<name>"'),
      })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_approval',
        detail: body.error.issues.map((issue) => issue.message).join('; '),
      });
    }

    try {
      const result = await approveAndSubmit(
        { prisma, client: assemblyClient, adapter, now: () => new Date() },
        params.externalId,
        body.data.approvedBy,
      );
      return reply.send({ ...result, adapter: adapter.name });
    } catch (error) {
      return reply.status(409).send({ error: 'approval_refused', detail: (error as Error).message });
    }
  });

  app.addHook('onClose', async () => {
    if (!options.prisma) await prisma.$disconnect();
  });

  return app;
}
