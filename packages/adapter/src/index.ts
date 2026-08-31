import {
  contestRequestForDispute,
  materialiseContest,
  type ContestDraft,
  type ContestRequestInput,
  type DisputeEntity,
} from '@praman/core';

/**
 * The submission adapter (TASKS.md P3.4).
 *
 * One interface, two implementations: `SimulatorClient` for the demo and the
 * corpus, `RazorpayClient` for the real Disputes API. The real client is
 * unit-tested against the documented request shapes and is never called live in
 * this project -- Razorpay's sandbox cannot originate a dispute, so there is
 * nothing real to contest (EVAL.md, known weakness 6).
 *
 * CLAUDE.md hard rule #2: the submit path has exactly one door. Two mechanisms
 * carry that here, and neither is a comment:
 *
 *   1. `submit()` requires an `ApprovalToken`, which can only be minted from a
 *      human-approved audit trail. There is no other constructor.
 *   2. Eval mode never constructs a client at all -- a source-tree test asserts
 *      that nothing under eval/ imports this package.
 */

export interface UploadedDocument {
  /** The capture-store reference this document was created from. */
  reference: string;
  /** Razorpay document id, `doc_`-prefixed. */
  documentId: string;
}

export interface SubmissionResult {
  disputeId: string;
  /** The payload as sent. Recorded verbatim in the audit trail. */
  request: ContestRequestInput;
  /** Razorpay's dispute entity after the contest. */
  dispute: DisputeEntity;
  /** True when this came from the simulator rather than Razorpay. */
  simulated: boolean;
}

/**
 * Proof that a human approved this specific dispute.
 *
 * Deliberately not a boolean and not a string: a boolean can be `true` by
 * accident and a string can be fabricated at a call site. This can only be
 * produced by `approve()`, which requires the approving person's identity.
 */
/**
 * Names that are never a person. Checked with and without the `human:` prefix,
 * because the prefix is trivially addable by a caller trying to be helpful.
 */
export const RESERVED_ACTOR_NAMES = new Set([
  'system',
  'gate',
  'llm',
  'adapter',
  'praman',
  'service',
  'admin',
  'root',
  'bot',
  'automation',
]);

export class ApprovalToken {
  private constructor(
    readonly disputeId: string,
    readonly approvedBy: string,
    readonly approvedAt: Date,
  ) {}

  /**
   * Mint a token. The only way to create one.
   *
   * `approvedBy` must be a real reviewer identity -- the review UI passes the
   * signed-in user. An empty or system actor is refused, because "the system
   * approved it" is precisely the thing hard rule #2 exists to prevent.
   *
   * The reserved-name check is not belt-and-braces. See FAILURES.md F-013: an
   * API route once prefixed whatever it was given with `human:`, so
   * `approvedBy: "system"` became `human:system` and submitted a live contest.
   * The prefix is now proof of nothing on its own, so the name behind it is
   * checked too.
   */
  static approve(disputeId: string, approvedBy: string, approvedAt: Date): ApprovalToken {
    const identity = approvedBy.trim();
    if (!identity.startsWith('human:')) {
      throw new Error(
        `approval requires a human actor identity like "human:wasih", got "${approvedBy}"`,
      );
    }
    const name = identity.slice('human:'.length).trim();
    if (!name) {
      throw new Error('approval requires a reviewer name after the "human:" prefix');
    }
    if (RESERVED_ACTOR_NAMES.has(name.toLowerCase())) {
      throw new Error(
        `"${name}" is a system actor, not a person: an approval must name the human who made it`,
      );
    }
    return new ApprovalToken(disputeId, identity, approvedAt);
  }
}

export interface DisputeAdapter {
  readonly name: string;
  readonly simulated: boolean;
  /** Upload one evidence artifact, returning the Razorpay document id. */
  uploadDocument(reference: string, filename: string, content: string): Promise<UploadedDocument>;
  /** Send a contest. Requires proof a human approved THIS dispute. */
  submit(
    draft: ContestDraft,
    documents: readonly UploadedDocument[],
    approval: ApprovalToken,
  ): Promise<SubmissionResult>;
}

function documentMap(documents: readonly UploadedDocument[]): Map<string, string> {
  return new Map(documents.map((document) => [document.reference, document.documentId]));
}

/**
 * Shared checks every implementation runs before a payload leaves the process.
 *
 * Kept here rather than duplicated so the simulator cannot be laxer than the
 * real client -- if the demo path accepted something Razorpay would reject, the
 * demo would be proving nothing.
 */
function prepare(
  draft: ContestDraft,
  documents: readonly UploadedDocument[],
  approval: ApprovalToken,
): ContestRequestInput {
  if (approval.disputeId !== draft.disputeId) {
    throw new Error(
      `approval is for ${approval.disputeId} but the draft is for ${draft.disputeId}: ` +
        'an approval authorises one dispute, not a batch',
    );
  }
  const request = materialiseContest(draft, documentMap(documents));
  // Validate against the dispute it contests: the contest amount may not
  // exceed the disputed amount. The two come from different fields on purpose.
  contestRequestForDispute({ amount: draft.disputedAmount }).parse(request);
  return request;
}

export interface SimulatorOptions {
  /** Supplies domain time. Never a wall clock, so eval stays reproducible. */
  now: () => Date;
}

/**
 * The simulator: records a submission and returns a plausible dispute entity.
 *
 * It does NOT decide won or lost. Simulated outcomes are a separate, explicitly
 * tagged concern (hard rule #6) and they do not belong in the submit path,
 * where they would quietly become the thing everyone quotes.
 */
export class SimulatorClient implements DisputeAdapter {
  readonly name = 'simulator';
  readonly simulated = true;
  private counter = 0;
  readonly submissions: SubmissionResult[] = [];

  constructor(private readonly options: SimulatorOptions) {}

  async uploadDocument(
    reference: string,
    _filename: string,
    _content: string,
  ): Promise<UploadedDocument> {
    // Deterministic, `doc_`-shaped, and obviously synthetic on inspection.
    this.counter += 1;
    const suffix = String(this.counter).padStart(4, '0');
    return { reference, documentId: `doc_SIM${suffix}${'0'.repeat(7)}` };
  }

  async submit(
    draft: ContestDraft,
    documents: readonly UploadedDocument[],
    approval: ApprovalToken,
  ): Promise<SubmissionResult> {
    const request = prepare(draft, documents, approval);
    const now = this.options.now();
    const result: SubmissionResult = {
      disputeId: draft.disputeId,
      request,
      simulated: true,
      dispute: {
        id: draft.disputeId,
        entity: 'dispute',
        payment_id: 'pay_simulated00000',
        amount: draft.amount,
        currency: 'INR',
        amount_deducted: 0,
        reason_code: 'contested',
        respond_by: Math.floor(now.getTime() / 1000),
        // A contested dispute moves to under_review. Not won, not lost --
        // those are outcomes we do not have and will not invent here.
        status: 'under_review',
        phase: 'chargeback',
        created_at: Math.floor(now.getTime() / 1000),
        evidence: {
          amount: draft.amount,
          summary: draft.summary,
          shipping_proof: null,
          billing_proof: null,
          cancellation_proof: null,
          customer_communication: null,
          proof_of_service: null,
          explanation_letter: null,
          refund_confirmation: null,
          access_activity_log: null,
          refund_cancellation_policy: null,
          term_and_conditions: null,
          others: null,
          submitted_at: Math.floor(now.getTime() / 1000),
        },
      },
    };
    this.submissions.push(result);
    return result;
  }
}

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
}

/**
 * The real Disputes API client.
 *
 * Request shapes are unit-tested against the documented examples. It is not
 * called live anywhere in this project, and the reason is stated rather than
 * hidden: Razorpay's sandbox cannot originate a dispute, so there is no real
 * dispute to contest.
 */
export class RazorpayClient implements DisputeAdapter {
  readonly name = 'razorpay';
  readonly simulated = false;
  private readonly baseUrl: string;

  constructor(private readonly options: RazorpayOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
    if (!options.keyId.startsWith('rzp_test_')) {
      // Defense-only, and a live key in a buildathon repo is an accident
      // waiting to happen. Test mode or nothing.
      throw new Error('RazorpayClient refuses any key without the rzp_test_ prefix');
    }
  }

  private authHeader(): string {
    const encoded = Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString(
      'base64',
    );
    return `Basic ${encoded}`;
  }

  /** POST /documents with `purpose: dispute_evidence`, per the docs. */
  async uploadDocument(
    reference: string,
    filename: string,
    content: string,
  ): Promise<UploadedDocument> {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/plain' }), filename);
    form.append('purpose', 'dispute_evidence');

    const response = await fetch(`${this.baseUrl}/documents`, {
      method: 'POST',
      headers: { authorization: this.authHeader() },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`razorpay documents ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new Error('razorpay documents returned no id');
    return { reference, documentId: body.id };
  }

  /** PATCH /disputes/:id/contest, per https://razorpay.com/docs/api/disputes/contest/ */
  async submit(
    draft: ContestDraft,
    documents: readonly UploadedDocument[],
    approval: ApprovalToken,
  ): Promise<SubmissionResult> {
    const request = prepare(draft, documents, approval);
    const response = await fetch(`${this.baseUrl}/disputes/${draft.disputeId}/contest`, {
      method: 'PATCH',
      headers: {
        authorization: this.authHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`razorpay contest ${response.status}: ${await response.text()}`);
    }
    return {
      disputeId: draft.disputeId,
      request,
      simulated: false,
      dispute: (await response.json()) as DisputeEntity,
    };
  }
}

/** Build the adapter the environment asks for. */
export function adapterFromEnv(
  env: { ADAPTER?: string | undefined; RAZORPAY_KEY_ID?: string | undefined; RAZORPAY_KEY_SECRET?: string | undefined },
  now: () => Date,
): DisputeAdapter {
  if (env.ADAPTER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('ADAPTER=razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    return new RazorpayClient({
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return new SimulatorClient({ now });
}
