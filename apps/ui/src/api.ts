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
  collected: { findings: Finding[]; coverage: { present: number; required: number } } | null;
  draft: { summary: string; assignments: { field: string; artifacts: string[] }[] } | null;
  submittedRequest: Record<string, unknown> | null;
  approvedBy: string | null;
  timeline: string[];
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

export function formatRupees(subunits: number): string {
  return `₹${(subunits / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Days until the deadline. Negative means it has passed. */
export function daysUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}
