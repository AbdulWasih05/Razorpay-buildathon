import type { EvidencePackIngestInput } from '@praman/core';
import type { GeneratedDispute } from './dispute.js';

/**
 * HTTP client for the capture API.
 *
 * The reason this exists rather than a direct Prisma call: seeding must flow
 * through `POST /evidence-pack` like any other capture. If the seed script wrote
 * to the database directly, the capture endpoint would be a box on a diagram
 * that nothing actually exercises, and the demo would be proving a component
 * the product does not really use. This client is what keeps that honest.
 */

export interface CaptureClientOptions {
  baseUrl: string;
  /** Milliseconds before a single request is abandoned. */
  timeoutMs?: number;
}

export class CaptureApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CaptureApiError';
  }
}

export class CaptureClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: CaptureClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed: unknown = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new CaptureApiError(
          `POST ${path} failed with ${response.status}`,
          response.status,
          parsed,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Capture one transaction's evidence pack. Idempotent on `externalId`. */
  async captureEvidencePack(
    pack: EvidencePackIngestInput,
  ): Promise<{ externalId: string; created: boolean }> {
    return this.post('/evidence-pack', pack);
  }

  /** Record one generated dispute against an already-captured transaction. */
  async seedDispute(dispute: GeneratedDispute): Promise<{ disputeId: string }> {
    return this.post('/seed/dispute', {
      event: dispute.event,
      meta: {
        externalId: dispute.externalId,
        rail: dispute.rail,
        scenarioClass: dispute.scenarioClass,
        corpus: dispute.corpus,
        seed: dispute.seed,
        groundTruth: dispute.groundTruth,
        groundTruthRationale: dispute.groundTruthRationale,
      },
    });
  }
}
