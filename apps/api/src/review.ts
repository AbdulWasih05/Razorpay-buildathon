import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AuditTrail,
  SCENARIOS,
  evaluateGate,
  evidencePackIngestSchema,
  renderTimeline,
  type Actor,
  type CollectedEvidence,
  type DisputeState,
  type ContestDraft,
  type GateRule,
  type ScenarioClass,
} from '@praman/core';
import { ApprovalToken, type DisputeAdapter } from '@praman/adapter';
import { processDispute, type AssemblyClient } from '@praman/llm';

/**
 * The review pipeline, persisted (TASKS.md P3.2, P3.3).
 *
 * Two things live here and nowhere else:
 *
 *   `runPipeline` -- collect, gate, assemble, and write the audit trail.
 *   `approveAndSubmit` -- THE door. The only function in the codebase that
 *                         calls `adapter.submit`.
 *
 * Everything the reviewer sees is read back out of the database, so what the UI
 * shows is what was actually recorded rather than a value held in memory next
 * to it.
 */

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export interface PipelineDeps {
  prisma: PrismaClient;
  client: AssemblyClient;
}

/** Run one dispute through the pipeline and persist every step of it. */
export async function runPipeline(
  deps: PipelineDeps,
  disputeExternalId: string,
): Promise<{ disputeId: string; state: DisputeState }> {
  const dispute = await deps.prisma.dispute.findUnique({
    where: { externalId: disputeExternalId },
    include: { payment: { include: { order: { include: { evidencePack: true } } } } },
  });
  if (!dispute) throw new Error(`no dispute ${disputeExternalId}`);

  const packExternalId = dispute.payment.order.evidencePack?.externalId;
  if (!packExternalId) throw new Error(`dispute ${disputeExternalId} has no evidence pack`);

  const pack = evidencePackIngestSchema.parse(await readPackAsIngest(deps.prisma, packExternalId));

  const processed = await processDispute({
    client: deps.client,
    pack,
    dispute: {
      disputeId: dispute.razorpayDisputeId,
      reasonCode: dispute.reasonCode,
      network: SCENARIOS[dispute.scenarioClass as ScenarioClass].network,
      amount: dispute.amount,
    },
    raisedAt: dispute.raisedAt,
  });

  await persistTrail(deps.prisma, dispute.id, processed.trail);
  await deps.prisma.dispute.update({
    where: { id: dispute.id },
    data: {
      state: processed.state,
      gateDecision: processed.gate.decision,
      gateReason: processed.gate.reason ?? null,
      abstentionClass: processed.assembled.abstentionClass ?? null,
      collectedJson: asJson(processed.collected),
      contestDraftJson: processed.assembled.draft ? asJson(processed.assembled.draft) : Prisma.DbNull,
    },
  });

  return { disputeId: dispute.razorpayDisputeId, state: processed.state };
}

/**
 * THE DOOR (CLAUDE.md hard rule #2).
 *
 * The only call site of `adapter.submit` in the product. Everything it needs to
 * refuse is checked before the adapter is touched:
 *
 *   - the dispute must actually be in `drafted`;
 *   - the approver must be a named human, not a service;
 *   - the audit trail must accept `approved` (it refuses non-human actors);
 *   - the approval token is minted for THIS dispute id only.
 */
export async function approveAndSubmit(
  deps: PipelineDeps & { adapter: DisputeAdapter; now: () => Date },
  disputeExternalId: string,
  approvedBy: string,
): Promise<{ state: DisputeState; simulated: boolean; documentCount: number }> {
  const dispute = await deps.prisma.dispute.findUnique({
    where: { externalId: disputeExternalId },
    include: { auditLogs: { orderBy: { seq: 'asc' } } },
  });
  if (!dispute) throw new Error(`no dispute ${disputeExternalId}`);
  if (dispute.state !== 'drafted') {
    throw new Error(
      `dispute ${disputeExternalId} is ${dispute.state}, not drafted: only a drafted contest can be approved`,
    );
  }
  const draft = dispute.contestDraftJson as unknown as ContestDraft | null;
  if (!draft) throw new Error(`dispute ${disputeExternalId} has no draft to approve`);

  const trail = AuditTrail.from(
    dispute.razorpayDisputeId,
    dispute.auditLogs.map((row) => ({
      seq: row.seq,
      fromState: row.fromState as DisputeState | null,
      toState: row.toState as DisputeState,
      actor: row.actor as Actor,
      ...(row.reason ? { reason: row.reason } : {}),
      occurredAt: row.occurredAt,
    })),
  );

  // NOT prefixed for the caller. F-013: this function used to turn whatever it
  // was handed into `human:<that>`, so `approvedBy: "system"` became
  // `human:system` and passed every downstream check. A caller that cannot
  // produce a real reviewer identity does not get one manufactured for it.
  if (!approvedBy.startsWith('human:')) {
    throw new Error(
      `approvedBy must be a reviewer identity of the form "human:<name>", got "${approvedBy}"`,
    );
  }
  const actor = approvedBy as Actor;
  const approvedAt = deps.now();

  // Throws for any non-human actor, and for any state that cannot reach
  // `approved`. This is the check, not a formality before the real one.
  trail.append({ toState: 'approved', actor, reason: 'reviewer approved the draft', occurredAt: approvedAt });

  // Upload evidence, then contest. Documents first: a contest referencing an
  // id that does not exist is rejected by Razorpay, and `materialiseContest`
  // refuses to invent one.
  const documents = [];
  for (const reference of draft.references) {
    documents.push(
      await deps.adapter.uploadDocument(reference, `${reference}.txt`, `evidence:${reference}`),
    );
  }

  const approval = ApprovalToken.approve(draft.disputeId, actor, approvedAt);
  const result = await deps.adapter.submit(draft, documents, approval);

  trail.append({
    toState: 'submitted',
    actor: 'adapter',
    reason: `${deps.adapter.name}: ${documents.length} documents, action ${result.request.action}`,
    occurredAt: deps.now(),
  });

  await persistTrail(deps.prisma, dispute.id, trail);
  await deps.prisma.dispute.update({
    where: { id: dispute.id },
    data: {
      state: 'submitted',
      approvedBy: actor,
      approvedAt,
      submittedRequestJson: asJson(result.request),
    },
  });

  return { state: 'submitted', simulated: result.simulated, documentCount: documents.length };
}

/** Append-only: existing rows are never rewritten, only missing ones added. */
async function persistTrail(
  prisma: PrismaClient,
  disputeRowId: string,
  trail: AuditTrail,
): Promise<void> {
  const existing = await prisma.auditLog.count({ where: { disputeId: disputeRowId } });
  const rows = trail.list().slice(existing);
  if (rows.length === 0) return;
  await prisma.auditLog.createMany({
    data: rows.map((entry) => ({
      disputeId: disputeRowId,
      seq: entry.seq,
      fromState: entry.fromState,
      toState: entry.toState,
      actor: entry.actor,
      reason: entry.reason ?? null,
      detail: entry.detail ? asJson(entry.detail) : Prisma.DbNull,
      occurredAt: entry.occurredAt,
    })),
  });
}

/** The review queue: what a person needs to triage, and nothing else. */
export async function listQueue(prisma: PrismaClient) {
  const disputes = await prisma.dispute.findMany({
    orderBy: [{ respondBy: 'asc' }],
    select: {
      externalId: true,
      razorpayDisputeId: true,
      amount: true,
      currency: true,
      reasonCode: true,
      phase: true,
      respondBy: true,
      rail: true,
      scenarioClass: true,
      state: true,
      gateDecision: true,
      gateReason: true,
      abstentionClass: true,
      approvedBy: true,
    },
  });
  return disputes.map((dispute) => ({
    ...dispute,
    respondBy: dispute.respondBy.toISOString(),
    reasonDescription:
      SCENARIOS[dispute.scenarioClass as ScenarioClass]?.label ?? dispute.reasonCode,
  }));
}

/** One dispute in full, including the rendered timeline. */
export async function readDispute(prisma: PrismaClient, externalId: string) {
  const dispute = await prisma.dispute.findUnique({
    where: { externalId },
    include: { auditLogs: { orderBy: { seq: 'asc' } } },
  });
  if (!dispute) return null;

  const trail = AuditTrail.from(
    dispute.razorpayDisputeId,
    dispute.auditLogs.map((row) => ({
      seq: row.seq,
      fromState: row.fromState as DisputeState | null,
      toState: row.toState as DisputeState,
      actor: row.actor as Actor,
      ...(row.reason ? { reason: row.reason } : {}),
      occurredAt: row.occurredAt,
    })),
  );

  return {
    externalId: dispute.externalId,
    disputeId: dispute.razorpayDisputeId,
    amount: dispute.amount,
    currency: dispute.currency,
    reasonCode: dispute.reasonCode,
    phase: dispute.phase,
    status: dispute.status,
    respondBy: dispute.respondBy.toISOString(),
    rail: dispute.rail,
    scenarioClass: dispute.scenarioClass,
    scenarioLabel: SCENARIOS[dispute.scenarioClass as ScenarioClass]?.label ?? null,
    state: dispute.state,
    gateDecision: dispute.gateDecision,
    gateReason: dispute.gateReason,
    abstentionClass: dispute.abstentionClass,
    collected: dispute.collectedJson,
    gateRules: replayGate(dispute.collectedJson, dispute.gateDecision),
    draft: dispute.contestDraftJson,
    submittedRequest: dispute.submittedRequestJson,
    approvedBy: dispute.approvedBy,
    // Ground truth is corpus bookkeeping, not something a reviewer should see
    // while deciding. It is deliberately NOT returned here.
    timeline: renderTimeline(trail),
    auditLogs: dispute.auditLogs.map((row) => ({
      seq: row.seq,
      fromState: row.fromState,
      toState: row.toState,
      actor: row.actor,
      reason: row.reason,
      occurredAt: row.occurredAt.toISOString(),
    })),
  };
}

/**
 * The gate's rule-by-rule trace, for the reviewer.
 *
 * `runPipeline` persists the gate's DECISION and its reason, but not the trace
 * of individual rules behind them -- so a reviewer could see that the system
 * abstained without seeing which of the eight checks said so. That trace is the
 * most reviewable artifact the deterministic core produces, and it was being
 * computed and discarded.
 *
 * It is recomputed here rather than migrated into a column, because
 * `evaluateGate` is pure and takes only `collected`, which IS persisted. Same
 * input, same code, same output -- there is no second implementation to drift.
 *
 * The persisted decision stays authoritative and is what the UI renders as the
 * verdict; this only explains it. `agrees` is the cross-check: if a replay ever
 * disagrees with what was recorded at pipeline time, something changed
 * underneath a decision that has already been acted on, and the reviewer is
 * told rather than shown a tidy trace for a verdict it does not match.
 */
export function replayGate(
  collectedJson: unknown,
  persistedDecision: string | null,
): { rules: GateRule[]; agrees: boolean } | null {
  if (!collectedJson || typeof collectedJson !== 'object') return null;
  try {
    const replayed = evaluateGate(collectedJson as unknown as CollectedEvidence);
    return {
      rules: replayed.rules,
      agrees: persistedDecision === null || replayed.decision === persistedDecision,
    };
  } catch {
    // A trace is an explanation, not the decision. If the stored evidence can
    // no longer be replayed, the reviewer loses the explanation and keeps the
    // verdict -- they must never lose the dispute itself over a display aid.
    return null;
  }
}

/**
 * Rebuild the capture envelope from stored rows.
 *
 * Kept here rather than in `capture.ts` because it exists for the pipeline's
 * benefit: the collector takes the domain envelope, not Prisma rows, so core
 * stays free of any database type.
 */
export async function readPackAsIngest(
  prisma: PrismaClient,
  externalId: string,
): Promise<unknown> {
  const pack = await prisma.evidencePack.findUnique({
    where: { externalId },
    include: {
      merchant: true,
      mandate: true,
      order: { include: { customer: true, payment: true, fulfillment: true, refund: true } },
      conversationTrace: { include: { turns: { orderBy: { seq: 'asc' } } } },
      orchestrationLogs: { orderBy: { seq: 'asc' } },
    },
  });
  if (!pack) throw new Error(`no evidence pack ${externalId}`);

  const strip = <T extends { id: string; createdAt: Date }>(row: T) => {
    const { id: _id, createdAt: _createdAt, ...rest } = row;
    return rest;
  };

  return {
    externalId: pack.externalId,
    rail: pack.rail,
    capturedAt: pack.capturedAt.toISOString(),
    occurredAt: pack.occurredAt.toISOString(),
    merchant: cleanRow(strip(pack.merchant)),
    customer: cleanRow(strip(pack.order.customer)),
    order: {
      ...cleanRow(strip(pack.order), ORDER_RELATIONS),
      items: pack.order.itemsJson,
      placedAt: pack.order.placedAt.toISOString(),
    },
    payment: cleanRow(strip(pack.order.payment!)),
    mandate: pack.mandate ? cleanRow(strip(pack.mandate)) : null,
    fulfillment: pack.order.fulfillment ? cleanRow(strip(pack.order.fulfillment)) : null,
    refund: pack.order.refund ? cleanRow(strip(pack.order.refund)) : null,
    agentic: pack.agentId
      ? {
          agentId: pack.agentId,
          agentPlatform: pack.agentPlatform!,
          protocol: pack.protocol!,
          protocolVersion: pack.protocolVersion!,
          protocolMetadata: pack.protocolMetadata ?? {},
        }
      : null,
    conversationTrace: pack.conversationTrace
      ? {
          ...cleanRow(strip(pack.conversationTrace)),
          startedAt: pack.conversationTrace.startedAt.toISOString(),
          turns: pack.conversationTrace.turns.map((turn) => cleanRow(strip(turn))),
        }
      : null,
    orchestrationLogs: pack.orchestrationLogs.map((log) => ({
      ...cleanRow(strip(log)),
      detail: log.detail ?? {},
    })),
  };
}

/**
 * Turn a Prisma row into the shape the domain envelope expects.
 *
 * Drops three things, each for its own reason:
 *   - relation foreign keys (`orderId`, `merchantId`, ...), which are storage
 *     identity and not part of the captured domain event;
 *   - `*Json` columns, which every caller re-attaches explicitly under the name
 *     the domain uses;
 *   - **included relation objects**, named explicitly by the caller. Prisma
 *     returns nested `customer`, `payment`, `fulfillment` and `refund` objects
 *     on an order when they are included, and the capture schema is
 *     `.strict()`, so passing them through fails ingest with "unrecognized
 *     keys". They are attached at the top level of the envelope instead, which
 *     is where the schema puts them.
 *
 * Relations are dropped BY NAME rather than by inspecting the value, and that
 * is the whole point of the `relations` parameter. Value-shape cannot tell a
 * null relation from a null column: an order with no refund yields
 * `refund: null`, which is indistinguishable from `vpa: null` on a payment,
 * and dropping every null would delete real captured facts. Guessing from the
 * value worked only for as long as every included relation happened to be
 * present -- see FAILURES.md F-014, where adding one optional relation broke
 * every dispute that did NOT have it.
 */
export function cleanRow(
  row: Record<string, unknown>,
  relations: readonly string[] = [],
): Record<string, unknown> {
  const drop = new Set(relations);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (drop.has(key)) continue;
    if (key.endsWith('Id') && key !== 'externalId' && key !== 'agentId' && key !== 'razorpayPaymentId') {
      continue;
    }
    if (key.endsWith('Json')) continue;
    if (value instanceof Date) {
      out[key] = value.toISOString();
      continue;
    }
    // Backstop for a populated relation the caller forgot to name. It cannot
    // catch a null one, which is exactly why `relations` exists.
    if (value !== null && typeof value === 'object') continue;
    out[key] = value;
  }
  return out;
}

/** Relations Prisma can attach to an order row, none of which belong in it. */
export const ORDER_RELATIONS = [
  'customer',
  'payment',
  'fulfillment',
  'refund',
  'merchant',
  'evidencePack',
] as const;
