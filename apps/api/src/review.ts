import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AuditTrail,
  NETWORKS,
  SCENARIOS,
  evaluateGate,
  evidencePackIngestSchema,
  renderTimeline,
  type Actor,
  type CollectedEvidence,
  type DisputeState,
  type ContestDraft,
  type GateRule,
  type Network,
  type ScenarioClass,
} from '@praman/core';
import { ApprovalToken, adapterFor, type AdapterRegistry } from '@praman/adapter';
import { processDispute, type AssemblyClient, type ModelCallTelemetry } from '@praman/llm';

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

/**
 * Which network's rubric applies to a dispute.
 *
 * The dispute carries it when it is known. Seeded corpus rows predate the
 * column, so they fall back to their scenario class -- and that fallback works
 * only for generated disputes, which is exactly the point: a dispute arriving
 * from a provider has no scenario, and must say what it is on its own.
 */
function networkOf(dispute: { network: string | null; scenarioClass: string | null }): Network {
  if (dispute.network) {
    // Validated, not cast. The column is free text at the database level, and
    // a value the rubric has never heard of must fail here rather than three
    // layers down as a missing lookup.
    if (!(NETWORKS as readonly string[]).includes(dispute.network)) {
      throw new Error(`dispute names network "${dispute.network}", which no rubric covers`);
    }
    return dispute.network as Network;
  }
  const scenario = dispute.scenarioClass
    ? SCENARIOS[dispute.scenarioClass as ScenarioClass]
    : undefined;
  if (!scenario) {
    throw new Error(
      'dispute has neither a network nor a known scenario class: nothing says which rubric applies',
    );
  }
  return scenario.network;
}

/** Rebuild an `AuditTrail` from the rows Prisma hands back. Shared with `approveAndSubmit`. */
function trailFromRows(
  providerDisputeId: string,
  rows: readonly {
    seq: number;
    fromState: string | null;
    toState: string;
    actor: string;
    reason: string | null;
    occurredAt: Date;
  }[],
): AuditTrail {
  return AuditTrail.from(
    providerDisputeId,
    rows.map((row) => ({
      seq: row.seq,
      fromState: row.fromState as DisputeState | null,
      toState: row.toState as DisputeState,
      actor: row.actor as Actor,
      ...(row.reason ? { reason: row.reason } : {}),
      occurredAt: row.occurredAt,
    })),
  );
}

/** Run one dispute through the pipeline and persist every step of it. */
export async function runPipeline(
  deps: PipelineDeps,
  disputeExternalId: string,
): Promise<{
  disputeId: string;
  state: DisputeState;
  gateDecision: 'contest' | 'abstain';
  abstentionClass: string | null;
  modelCalls: number;
}> {
  const dispute = await deps.prisma.dispute.findUnique({
    where: { externalId: disputeExternalId },
    include: {
      payment: { include: { order: { include: { evidencePack: true } } } },
      auditLogs: { orderBy: { seq: 'asc' } },
    },
  });
  if (!dispute) throw new Error(`no dispute ${disputeExternalId}`);
  // `/review/run?states=...` documents reprocessing an already-drafted or
  // -abstained dispute (P4.0's own use case). It must never reach one that is
  // `approved` or `submitted`: rewinding either would overwrite the one
  // record of a real human decision, or a real submission, with today's
  // fresh judgement. `AuditTrail.rewindToReceived` refuses this too, but
  // failing here skips a wasted model call for a request that cannot succeed.
  if (dispute.state === 'approved' || dispute.state === 'submitted') {
    throw new Error(
      `dispute ${disputeExternalId} is ${dispute.state}: cannot reprocess a dispute that has already been approved or submitted`,
    );
  }

  const packExternalId = dispute.payment.order.evidencePack?.externalId;
  if (!packExternalId) throw new Error(`dispute ${disputeExternalId} has no evidence pack`);

  const pack = evidencePackIngestSchema.parse(await readPackAsIngest(deps.prisma, packExternalId));

  const processed = await processDispute({
    client: deps.client,
    pack,
    dispute: {
      disputeId: dispute.providerDisputeId,
      reasonCode: dispute.reasonCode,
      network: networkOf(dispute),
      amount: dispute.amount,
    },
    raisedAt: dispute.raisedAt,
  });

  // `processed.trail` always models ONE FULL CYCLE from `received`, because
  // `processDispute` has no idea whether this dispute has ever been through
  // the pipeline before -- it is not given the existing trail, by design (it
  // is also called from scripts that have no database at all). The first run
  // of any dispute, that fresh trail IS the trail: existing rows = 0, and
  // `persistTrail`'s old count-based diffing worked by coincidence.
  //
  // It stopped working -- silently -- the moment a dispute got a SECOND cycle:
  // P4.0(a)'s own `?states=drafted,abstained` reprocessing, or a demo reset.
  // `persisted.length` (say, 5) then exceeds the fresh trail's length (4), so
  // `trail.list().slice(existing)` is empty, nothing new is ever written, and
  // `dispute.state` moves on ahead of the trail that is supposed to justify
  // it. Found live (2026-09-05): a dispute reprocessed after a demo reset
  // showed `state: "drafted"` with a real draft, while its persisted trail
  // still ended at the reset's own `received` row -- and a real human trying
  // to approve it was refused with "illegal transition received -> approved",
  // which blames the actor when the actual cause is nowhere near the actor.
  //
  // The fix treats a second-or-later cycle as its own recorded event rather
  // than a silent extension of the first. If the dispute is not already at
  // `received`, an explicit rewind row is appended first, because "this
  // dispute is starting a new cycle" deserves its own recorded fact rather
  // than a silently-dropped one. (F-028, the same session: a demo reset is no
  // longer one of the ways a SEEDED dispute reaches this path at all --
  // `resetDemo` now only ever deletes `demo-`-prefixed rows outright, never
  // rewinds a seeded one. The remaining, legitimate way a seeded dispute gets
  // a second cycle is P4.0(a)'s own `?states=drafted,abstained`
  // reprocessing, which this fix still has to handle correctly on its own.)
  // Every subsequent step
  // from the fresh trail (skipping its own redundant first `received` entry)
  // is then re-applied on top, seq numbers continuing from wherever the
  // persisted trail actually left off -- never restarting at 0.
  const trail = trailFromRows(dispute.providerDisputeId, dispute.auditLogs);
  if (trail.length > 0 && trail.state !== 'received') {
    // Domain time, not `deps.now()`: this reuses the fresh cycle's own step-0
    // timestamp (D-007 -- no wall clock inside a pipeline run) rather than
    // inventing a second clock for one row of the same trail.
    const cycleStart = processed.trail.list()[0]?.occurredAt ?? dispute.raisedAt;
    trail.rewindToReceived(
      'system',
      'pipeline re-run: reprocessing from a non-received state',
      cycleStart,
    );
  }
  for (const entry of processed.trail.list().slice(1)) {
    trail.append({
      toState: entry.toState,
      actor: entry.actor,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      occurredAt: entry.occurredAt,
    });
  }

  await persistTrail(deps.prisma, dispute.id, trail);
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

  return {
    disputeId: dispute.providerDisputeId,
    state: processed.state,
    gateDecision: processed.gate.decision,
    abstentionClass: processed.assembled.abstentionClass ?? null,
    modelCalls: processed.assembled.modelCalls.length,
  };
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
  deps: PipelineDeps & { adapters: AdapterRegistry; now: () => Date },
  disputeExternalId: string,
  approvedBy: string,
): Promise<{
  state: DisputeState;
  simulated: boolean;
  documentCount: number;
  /** Which adapter actually sent it, named for the caller and the trail. */
  adapter: string;
}> {
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

  const trail = trailFromRows(dispute.providerDisputeId, dispute.auditLogs);

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

  // The reserved-name check runs FIRST, before anything else in this function
  // -- including the audit trail and, critically, before any adapter call.
  //
  // F-013 was: a route manufactured a `human:` prefix, so `isHumanActor` (the
  // format-only check the state machine and the trail use) passed on a lie.
  // That was fixed by refusing to manufacture the prefix. An adversarial
  // review then found the same shape of bug one layer further in: even with
  // the prefix un-manufactured, `isHumanActor('human:system')` is still
  // correctly `true` -- it only ever checked the prefix, never the name -- so
  // `trail.append` and the document-upload loop below both used to run to
  // completion for a caller sending `{"approvedBy": "human:system"}` before
  // `ApprovalToken.approve`'s reserved-name check (the only one that actually
  // reads the name) finally threw. The submission itself was always blocked --
  // `submit()` needs the token this call mints -- but a real
  // `adapter.uploadDocument()` call (in production: a live Documents API
  // upload) fired first, on a spoofed identity, before anything rejected it.
  //
  // Minting the token here, before the trail write and before any adapter
  // call, means a reserved actor causes zero side effects rather than "zero
  // side effects except the ones that already happened."
  const approval = ApprovalToken.approve(draft.disputeId, actor, approvedAt);

  // The adapter comes from the dispute, not from the process. A server
  // holding one global adapter would submit a dispute to whichever provider
  // it happened to be configured for, which is fine until there are two.
  const adapter = adapterFor(deps.adapters, dispute.provider);

  // The claim, and why it is here rather than in the state check above.
  //
  // That check is a READ. Two approvals racing -- a double click, a retried
  // request, two reviewers on the same case -- both read `drafted`, both pass,
  // and both go on to upload documents and submit. Nothing between the read
  // and the write at the end of this function stops the second one.
  //
  // This is a conditional WRITE: `state: 'drafted'` sits in the WHERE clause,
  // so Postgres serialises the two callers and exactly one sees `count: 1`.
  // The loser is refused here, before it can reach the adapter.
  //
  // It claims straight to `approved` rather than to a holding state because
  // that is what has just happened: a named human approved this draft. If the
  // submission then fails, the dispute stays `approved` with the trail saying
  // so -- an honest record, and a legal state to retry from.
  //
  // It sits after the identity check and the token mint on purpose (F-013): a
  // caller who cannot produce a real reviewer identity still causes no writes.
  const claimed = await deps.prisma.dispute.updateMany({
    where: { externalId: disputeExternalId, state: 'drafted' },
    data: { state: 'approved', approvedBy: actor, approvedAt },
  });
  if (claimed.count !== 1) {
    throw new Error(
      `dispute ${disputeExternalId} was approved by another request first: nothing was submitted here`,
    );
  }

  // Throws for any non-human actor, and for any state that cannot reach
  // `approved`. Redundant with the check above by design (D-029: this table's
  // own guard is `isHumanActor`, which only reads the prefix -- it stays as a
  // second, format-level check on the state machine, not as the thing this
  // function relies on for safety).
  trail.append({ toState: 'approved', actor, reason: 'reviewer approved the draft', occurredAt: approvedAt });

  // Upload evidence, then contest. Documents first: a contest referencing an
  // id that does not exist is rejected by Razorpay, and `materialiseContest`
  // refuses to invent one.
  const documents = [];
  for (const reference of draft.references) {
    documents.push(
      await adapter.uploadDocument(reference, `${reference}.txt`, `evidence:${reference}`),
    );
  }

  const result = await adapter.submit(draft, documents, approval);

  trail.append({
    toState: 'submitted',
    actor: 'adapter',
    reason: `${adapter.name}: ${documents.length} documents, action ${result.action}`,
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

  return {
    state: 'submitted',
    simulated: result.simulated,
    documentCount: documents.length,
    adapter: adapter.name,
  };
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
      providerDisputeId: true,
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

  const trail = trailFromRows(dispute.providerDisputeId, dispute.auditLogs);

  return {
    externalId: dispute.externalId,
    disputeId: dispute.providerDisputeId,
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
    modelCalls: currentModelCalls(dispute.auditLogs),
  };
}

/**
 * The model calls behind the dispute's current state.
 *
 * Read from the audit row that recorded them, and only within the latest
 * pipeline cycle. A re-run starts a new cycle at `received`, and calls from an
 * earlier cycle explain a decision that no longer stands. Telemetry only:
 * nothing here feeds a decision.
 */
function currentModelCalls(
  rows: readonly { toState: string; detail: Prisma.JsonValue | null }[],
): ModelCallTelemetry[] {
  const cycleStart = rows.map((row) => row.toState).lastIndexOf('received');
  for (const row of rows.slice(Math.max(cycleStart, 0))) {
    const detail = row.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const calls = detail['modelCalls'];
      if (Array.isArray(calls)) return calls as unknown as ModelCallTelemetry[];
    }
  }
  return [];
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
    payment: paymentEnvelope(pack.order.payment!),
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
    /*
      Foreign keys are cuids, and a cuid in a prompt would change the replay
      hash on every reseed (D-007), so the suffix rule stays: drop anything
      ending in `Id` unless it is named here.

      The allowlist is where business fields that happen to end in `Id` have to
      be declared, and `trackingId` was missing from it (FAILURES.md F-030). It
      is a carrier tracking number -- evidence, not a row pointer -- and the
      heuristic ate it on every read-back, so the drafter never saw a tracking
      id for any shipment while the eval, which builds its packs from the
      generator rather than from the store, always did. Captured, stored, and
      then dropped on the one path that leads to a contest.

      Adding a name here is deliberately the only way past this rule. The
      inverse -- listing the foreign keys to drop -- fails open, and it fails
      open into the exact defect that silently turns a replayed eval into a live
      one.
    */
    const BUSINESS_ID_FIELDS = ['externalId', 'agentId', 'razorpayPaymentId', 'trackingId'];
    if (key.endsWith('Id') && !BUSINESS_ID_FIELDS.includes(key)) {
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

/**
 * The payment, in the shape the capture envelope has always had.
 *
 * Built field by field rather than from the row, because the row no longer
 * matches it: the column is `providerPaymentId` now, with a `provider` column
 * beside it. Letting the row through would rename one key in the envelope and
 * add another.
 *
 * That is not a cosmetic difference. Every prompt is built from this envelope,
 * and every replay fixture is keyed by a hash of the prompt (D-007), so a
 * renamed key here misses all 174 recordings at once and turns a replayed eval
 * into a live one. The envelope is also the merchant-facing capture contract,
 * which an internal refactor does not get to rewrite.
 */
function paymentEnvelope(payment: {
  externalId: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  vpa: string | null;
  capturedAt: Date | null;
  occurredAt: Date;
}): Record<string, unknown> {
  return {
    externalId: payment.externalId,
    razorpayPaymentId: payment.providerPaymentId,
    amount: payment.amount,
    currency: payment.currency,
    method: payment.method,
    status: payment.status,
    vpa: payment.vpa,
    capturedAt: payment.capturedAt ? payment.capturedAt.toISOString() : null,
    occurredAt: payment.occurredAt.toISOString(),
  };
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
