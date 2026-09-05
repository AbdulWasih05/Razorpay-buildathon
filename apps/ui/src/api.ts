/**
 * The API surface the review UI uses. Four calls, no client library.
 *
 * `approve` is the only mutation here, and it is the product's single door to
 * submission (CLAUDE.md hard rule #2). It requires a named reviewer: there is
 * no default, and the UI cannot supply one on the reviewer's behalf. See
 * FAILURES.md F-013 for what happened the one time a layer tried to be helpful
 * about that.
 */

export interface QueueItem {
  externalId: string;
  razorpayDisputeId: string;
  amount: number;
  currency: string;
  reasonCode: string;
  reasonDescription: string;
  phase: string;
  respondBy: string;
  rail: 'ordinary' | 'agentic';
  scenarioClass: string;
  state: string;
  gateDecision: string | null;
  gateReason: string | null;
  abstentionClass: string | null;
  approvedBy: string | null;
}

export interface Finding {
  artifact: string;
  state: 'present' | 'absent' | 'not_capturable';
  necessity: 'required' | 'supporting';
  reason?: string;
  references: string[];
}

export interface GateRule {
  id: string;
  passed: boolean;
  detail: string;
}

/** One artifact the reason-code rubric asks for, in Razorpay's own wording. */
export interface RubricRequirement {
  artifact: string;
  necessity: 'required' | 'supporting';
  provenance: string;
  sourcePhrase: string;
}

/**
 * The mandate arithmetic, agentic rail only.
 *
 * Every field here is a term in a check the gate ran. Rendering them lets a
 * reviewer redo the arithmetic rather than take `withinLimit: true` on faith.
 */
export interface MandateChecks {
  present: boolean;
  status?: string;
  maxAmount?: number;
  chargedAmount?: number;
  validFrom?: string;
  validUntil?: string;
  paymentAt?: string;
  withinLimit?: boolean;
  withinValidityWindow?: boolean;
  consentBeforePayment?: boolean;
}

export interface Collected {
  findings: Finding[];
  coverage: { present: number; required: number; ratio: number };
  rubric: { code: string; network: string; category: string; requires: RubricRequirement[] };
  mandate: MandateChecks;
  missingRequired: string[];
  /** Required artifacts we could never have held. The thesis, as a field. */
  structurallyUnavailable: string[];
  anomalySignals: string[];
  rail: string;
}

/** One typed Razorpay evidence field, and what was mapped into it. */
export interface FieldAssignment {
  field: string;
  artifacts: string[];
  references?: string[];
  othersType?: string;
}

export interface AuditEntry {
  seq: number;
  fromState: string | null;
  toState: string;
  actor: string;
  reason: string | null;
  occurredAt: string;
}

export interface DisputeDetail {
  externalId: string;
  disputeId: string;
  amount: number;
  currency: string;
  reasonCode: string;
  phase: string;
  status: string;
  respondBy: string;
  rail: string;
  scenarioClass: string;
  scenarioLabel: string | null;
  state: string;
  gateDecision: string | null;
  gateReason: string | null;
  abstentionClass: string | null;
  collected: Collected | null;
  draft: { summary: string; references: string[]; assignments: FieldAssignment[] } | null;
  submittedRequest: Record<string, unknown> | null;
  approvedBy: string | null;
  timeline: string[];
  auditLogs?: AuditEntry[];
  /**
   * The gate's rule-by-rule trace, replayed from stored evidence by the API.
   *
   * `agrees` false means the replay disagreed with the decision recorded at
   * pipeline time. That is a real inconsistency and the UI says so rather than
   * rendering a trace for a verdict it does not explain.
   */
  gateRules?: { rules: GateRule[]; agrees: boolean } | null;
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    const detail =
      (body as { detail?: string; error?: string }).detail ??
      (body as { error?: string }).error ??
      response.statusText;
    throw new Error(detail);
  }
  return body as T;
}

export async function fetchQueue(): Promise<QueueItem[]> {
  const response = await fetch('/api/review/queue');
  const body = await json<{ disputes: QueueItem[] }>(response);
  return body.disputes;
}

export async function fetchDispute(externalId: string): Promise<DisputeDetail> {
  return json<DisputeDetail>(await fetch(`/api/review/disputes/${externalId}`));
}

export async function approve(
  externalId: string,
  approvedBy: string,
): Promise<{ state: string; simulated: boolean; documentCount: number; adapter: string }> {
  const response = await fetch(`/api/review/disputes/${externalId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvedBy }),
  });
  return json(response);
}

export interface Health {
  status: string;
  assemblyMode: 'live' | 'replay';
  demoMode: boolean;
  recordings: number;
  startedAt: string;
  pid: number;
  /**
   * The instant deadlines are read against, or null for wall-clock time.
   *
   * The server decides this, like `demoMode`, because the UI cannot know whether
   * the rows it was handed are seeded. Today it is always set: the schema has no
   * column shape a real dispute could occupy (F-024).
   */
  simulatedNow: string | null;
}

/**
 * What the server says about itself.
 *
 * The UI does not decide whether it is a demo — the server does, and says so.
 * A banner the front-end switches on for itself would be a banner that can be
 * wrong, and this one is load-bearing for hard rule #6.
 */
export async function fetchHealth(): Promise<Health> {
  return json<Health>(await fetch('/api/health'));
}

export interface ReleasedDispute {
  externalId: string;
  razorpayDisputeId: string;
  scenarioClass: string;
  reasonCode: string;
  released: number;
  remaining: number;
}

export async function releaseDispute(): Promise<ReleasedDispute> {
  return json<ReleasedDispute>(await fetch('/api/demo/release-dispute', { method: 'POST' }));
}

export async function resetDemo(): Promise<{ demoDisputesRemoved: number }> {
  return json(await fetch('/api/demo/reset', { method: 'POST' }));
}

/**
 * The eval report, as markdown.
 *
 * Not JSON, and not a metrics object: the metrics page renders the committed
 * `eval/results.md` verbatim so it cannot drift from the report it claims to
 * match (P4.2). Parsing it into numbers here would reintroduce the second
 * computation the design exists to avoid.
 */
export async function fetchEvalReport(): Promise<string> {
  const response = await fetch('/api/eval/report');
  if (!response.ok) {
    throw new Error(`the API returned ${response.status} for the eval report`);
  }
  return response.text();
}

export function formatRupees(subunits: number): string {
  return `₹${(subunits / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * Days until the deadline. Negative means it has passed.
 *
 * `now` is required rather than defaulted, and that is the fix for F-024. This
 * function used to read `Date.now()`, which is correct for real disputes and
 * meaningless for seeded ones: every `respond_by` in the corpus is a fixed
 * offset from a hard-coded epoch, so against a real clock the whole queue drifts
 * into the past together and the meter stops measuring urgency and starts
 * measuring the corpus's age. A parameter with a wall-clock default would have
 * let every existing call site keep the bug, so there is no default -- the
 * server says which instant to read against (`/health`, `simulatedNow`), and
 * passing `null` to mean "real time" has to be written out on purpose.
 */
export function daysUntil(iso: string, now: string | null): number {
  const reference = now === null ? Date.now() : new Date(now).getTime();
  return Math.round((new Date(iso).getTime() - reference) / 86_400_000);
}
