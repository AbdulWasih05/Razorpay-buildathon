import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
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
import { CORPUS_NOW, DEV_CONFIG, generateTransaction } from '@praman/simulator';
import { z } from 'zod';

import { adapterFromEnv } from '@praman/adapter';
import { AssemblyClient, ResponseCache, providerFromEnv } from '@praman/llm';

import { captureEvidencePack, readEvidencePack } from './capture.js';
import { DEMO_RELEASE_CAP, RateLimiter, releaseNextDispute, resetDemo } from './demo.js';
import { approveAndSubmit, listQueue, readDispute, runPipeline } from './review.js';

/**
 * When this process started. Reported by `/health` so a caller can tell a
 * freshly started server from a stale one still holding the port (F-015).
 */
const STARTED_AT = new Date().toISOString();

/** The committed eval report, served by `GET /eval/report`. */
const EVAL_REPORT_PATH = fileURLToPath(new URL('../../../eval/results.md', import.meta.url));

/** The built review UI, when `pnpm ui:build` has produced one. */
const UI_DIST = fileURLToPath(new URL('../../ui/dist/', import.meta.url));

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
  const app = Fastify({
    logger: options.logger ?? false,
    /**
     * The UI calls `/api/...` in development, where Vite proxies that prefix
     * to this server. In production the same bundle is served from this same
     * origin, so the prefix has to mean something here too. Stripping it at
     * the router keeps one code path: the browser sends the same URLs in both
     * environments, and no build-time base-URL switch can be wrong in only
     * one of them.
     */
    rewriteUrl: (request) => {
      // Keep the address the browser actually asked for. The 404 handler needs
      // it to tell "an API route that does not exist" from "a client-side route
      // the SPA will handle", and after the rewrite those two are identical.
      (request as { originalUrl?: string }).originalUrl = request.url;
      return request.url?.startsWith('/api/') ? request.url.slice(4) : (request.url ?? '/');
    },
  });

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

  /**
   * Demo mode: on for the deployed instance, off by default.
   *
   * Reported by `/health` so the UI can show a banner. A demo that does not
   * announce itself as a demo is the exact failure hard rule #6 is about, and
   * the UI cannot know unless the server says.
   */
  const demoMode = process.env['DEMO_MODE'] === 'true';

  /**
   * Two budgets, not one, and that is the whole point.
   *
   * Both endpoints are unauthenticated writes, which is defensible for a demo
   * only while hammering them is pointless. But a shared budget would let a
   * visitor spend it all on releases, hit the cap, and then be refused the
   * reset that would clear it -- wedging the demo with the trigger, which is
   * precisely what P4.3 says must not be possible. The escape hatch has to have
   * its own budget or it is not an escape hatch.
   */
  const releaseLimiter = new RateLimiter(20, 5 * 60_000);
  const resetLimiter = new RateLimiter(6, 60_000);

  app.get('/health', async () => ({
    status: 'ok',
    assemblyMode,
    demoMode,
    recordings: assemblyCache.size,
    startedAt: STARTED_AT,
    pid: process.pid,
    /**
     * The instant deadlines are read against (F-024).
     *
     * Every dispute this server can hold is seeded: `seed`, `corpus`,
     * `scenarioClass` and `groundTruth` are non-nullable columns, so there is
     * no path by which a real dispute reaches the store. The rows are simulated
     * and so is the clock, which is stated here rather than assumed by the UI
     * -- the same reason `demoMode` is served rather than inferred. If a real
     * rail is ever added, this is the field that goes null and the console
     * falls back to wall-clock time.
     */
    simulatedNow: CORPUS_NOW.toISOString(),
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

  /**
   * Release the next dispute, so a demo can show one arriving.
   *
   * Guarded three ways because it is an unauthenticated write on the open
   * internet (TASKS.md P4.3): rate limited per caller, capped in total, and
   * undoable by `POST /demo/reset`. Demo disputes carry a `demo-` prefix and
   * are generated at indices far above the seeded corpus, so a visitor pressing
   * this cannot touch, shift or overwrite the 100 disputes the eval measures.
   */
  app.post('/demo/release-dispute', async (request, reply) => {
    const gate = releaseLimiter.take(request.ip);
    if (!gate.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(gate.retryAfterSeconds))
        .send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }

    const released = await releaseNextDispute(prisma);
    if ('capped' in released) {
      return reply.code(409).send({
        error: 'demo_release_cap_reached',
        released: released.released,
        cap: DEMO_RELEASE_CAP,
        detail: 'POST /demo/reset clears released disputes and restores a clean queue.',
      });
    }
    return reply.code(201).send(released);
  });

  /**
   * Restore a clean demo.
   *
   * Rewinds every seeded dispute to `received` and deletes the ones the demo
   * released. It does NOT truncate the audit trail: that table's contract is
   * append-only, so a rewind appends a `demo_reset` entry recording what it
   * undid rather than erasing it.
   */
  app.post('/demo/reset', async (request, reply) => {
    const gate = resetLimiter.take(request.ip);
    if (!gate.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(gate.retryAfterSeconds))
        .send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }
    return reply.send(await resetDemo(prisma));
  });

  /**
   * Serve the built review UI from this same process, when one exists.
   *
   * TASKS.md P4.3 said Railway for the api and Vercel for the ui. This ships
   * both from one origin instead (DECISIONS.md D-035): one URL for the README's
   * first line, no CORS, no rewrite rule holding a hard-coded hostname, and one
   * deploy that can fail rather than two that can fail independently the night
   * before a submission. The UI has no server-side rendering and no framework
   * runtime -- it is a Vite bundle of static files -- so nothing is lost.
   *
   * Registered last so every API route above wins on a path collision, and the
   * SPA fallback only catches what nothing else claimed. `pnpm ui:build`
   * produces the directory; if it is absent the API still runs and only the
   * pages are missing, which is the right way round for a service whose routes
   * are the product.
   */
  if (existsSync(UI_DIST)) {
    // `wildcard: false` would register one route per file **at boot**, which
    // makes the route table a snapshot of the directory as it was when the
    // process started. Rebuild the UI without restarting and every hashed asset
    // 404s while `index.html` still serves, so the page goes blank with nothing
    // in the console -- which is exactly how it was found. A wildcard resolves
    // each request against the disk instead, and cannot go stale.
    void app.register(fastifyStatic, { root: UI_DIST, prefix: '/' });

    app.setNotFoundHandler((request, reply) => {
      const asked = (request.raw as { originalUrl?: string }).originalUrl ?? request.url;
      const path = asked.split('?')[0] ?? '/';

      // Two things must NOT get the index page, and both are cases where
      // returning HTML would replace a clear 404 with a confusing success:
      // an API path that does not exist, and a missing bundle file. The second
      // is the classic SPA-fallback bug -- the browser asks for a hashed asset,
      // receives a page, and reports `Unexpected token '<'` from somewhere
      // unrelated.
      const isApi = path.startsWith('/api/');
      const looksLikeFile = /\.[a-z0-9]+$/i.test(path);

      if (request.method !== 'GET' || isApi || looksLikeFile) {
        return reply.code(404).send({ error: 'not_found', path });
      }
      return reply.sendFile('index.html');
    });
  }

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
