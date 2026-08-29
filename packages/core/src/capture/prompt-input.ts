/**
 * What an LLM prompt is allowed to see.
 *
 * The rule, and it is subtle enough to be worth stating twice: LLM prompt
 * inputs are built ONLY from seed-derived fields. Never from a server-generated
 * row id, never from a server `createdAt`.
 *
 * Why it matters. `packages/llm` records responses keyed by a hash of the
 * request and replays them in eval. If a cuid or a wall-clock timestamp is
 * anywhere in a prompt, then reseeding the corpus changes the hash, every
 * committed fixture misses, and the eval silently starts making live calls --
 * reproducibility gone, with nothing raised and nothing logged. The failure is
 * invisible, which is exactly why a convention is not enough and this is a
 * function with a test behind it. See DECISIONS.md D-007.
 *
 * This module is the single door between the store and any prompt.
 */

/** Never allowed into a prompt, at any depth. */
export const FORBIDDEN_PROMPT_KEYS = [
  'id',
  'createdAt',
  'merchantId',
  'customerId',
  'orderId',
  'mandateId',
  'paymentId',
  'evidencePackId',
  'traceId',
  'disputeId',
] as const;

export interface PromptSafeTurn {
  seq: number;
  role: string;
  content: string;
  occurredAt: string;
}

export interface PromptSafeLogEntry {
  seq: number;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface PromptSafeMandate {
  externalId: string;
  agentId: string;
  agentPlatform: string;
  consentAt: string;
  validFrom: string;
  validUntil: string;
  maxAmount: number;
  currency: string;
  status: string;
}

export interface PromptSafeEvidencePack {
  externalId: string;
  rail: string;
  capturedAt: string;
  occurredAt: string;
  agentId: string | null;
  agentPlatform: string | null;
  protocol: string | null;
  protocolVersion: string | null;
  order: { externalId: string; amount: number; currency: string; status: string; placedAt: string };
  mandate: PromptSafeMandate | null;
  conversationTurns: PromptSafeTurn[];
  orchestrationLogs: PromptSafeLogEntry[];
}

/** Loose shape of a store readback; only the fields we project are required. */
export interface EvidencePackReadback {
  externalId: string;
  rail: string;
  capturedAt: Date | string;
  occurredAt: Date | string;
  agentId?: string | null;
  agentPlatform?: string | null;
  protocol?: string | null;
  protocolVersion?: string | null;
  order: {
    externalId: string;
    amount: number;
    currency: string;
    status: string;
    placedAt: Date | string;
  };
  mandate?: {
    externalId: string;
    agentId: string;
    agentPlatform: string;
    consentAt: Date | string;
    validFrom: Date | string;
    validUntil: Date | string;
    maxAmount: number;
    currency: string;
    status: string;
  } | null;
  conversationTrace?: {
    turns: {
      seq: number;
      role: string;
      content: string;
      occurredAt: Date | string;
    }[];
  } | null;
  orchestrationLogs?: {
    seq: number;
    action: string;
    actor: string;
    detail: unknown;
    occurredAt: Date | string;
  }[];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Project a stored evidence pack down to the fields a prompt may contain.
 *
 * This is an allowlist, not a denylist: fields are copied in explicitly, so a
 * new server-generated column added to the schema later cannot leak into a
 * prompt by default. That is the whole point of writing it this way.
 */
export function toPromptInput(pack: EvidencePackReadback): PromptSafeEvidencePack {
  return {
    externalId: pack.externalId,
    rail: pack.rail,
    capturedAt: iso(pack.capturedAt),
    occurredAt: iso(pack.occurredAt),
    agentId: pack.agentId ?? null,
    agentPlatform: pack.agentPlatform ?? null,
    protocol: pack.protocol ?? null,
    protocolVersion: pack.protocolVersion ?? null,
    order: {
      externalId: pack.order.externalId,
      amount: pack.order.amount,
      currency: pack.order.currency,
      status: pack.order.status,
      placedAt: iso(pack.order.placedAt),
    },
    mandate: pack.mandate
      ? {
          externalId: pack.mandate.externalId,
          agentId: pack.mandate.agentId,
          agentPlatform: pack.mandate.agentPlatform,
          consentAt: iso(pack.mandate.consentAt),
          validFrom: iso(pack.mandate.validFrom),
          validUntil: iso(pack.mandate.validUntil),
          maxAmount: pack.mandate.maxAmount,
          currency: pack.mandate.currency,
          status: pack.mandate.status,
        }
      : null,
    conversationTurns: (pack.conversationTrace?.turns ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((turn) => ({
        seq: turn.seq,
        role: turn.role,
        content: turn.content,
        occurredAt: iso(turn.occurredAt),
      })),
    orchestrationLogs: (pack.orchestrationLogs ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => ({
        seq: entry.seq,
        action: entry.action,
        actor: entry.actor,
        detail: (entry.detail ?? {}) as Record<string, unknown>,
        occurredAt: iso(entry.occurredAt),
      })),
  };
}

/**
 * Walk any value and collect forbidden key names found at any depth.
 * Used by the guard test; also usable as a runtime assertion before a live call.
 */
export function findForbiddenPromptKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (value instanceof Date) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenPromptKeys(item, `${path}[${index}]`));
  }

  const found: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_PROMPT_KEYS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
    }
    found.push(...findForbiddenPromptKeys(item, `${path}.${key}`));
  }
  return found;
}
