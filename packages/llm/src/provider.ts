/**
 * Every model call in Praman goes through this interface. There is one of them,
 * and it is the only place an HTTP request reaches a model provider.
 *
 * The interface is deliberately tiny: a prompt in, a string out. No tools, no
 * loop, no multi-turn state. That is not a limitation we ran into, it is the
 * decision recorded in DECISIONS.md D-019 -- the three jobs we give a model are
 * single-shot text transforms, so an agent loop would add nondeterminism and a
 * replay problem to buy capability we do not want.
 */

export interface ModelRequest {
  /** Prompt file id, e.g. `trace-summary`. Part of the replay key. */
  promptId: string;
  /** Prompt file version. Bumping it invalidates recordings, on purpose. */
  promptVersion: number;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  /** Transport attempts made. 1 unless a rate limit was waited out. */
  attempts?: number;
  /**
   * True when the provider itself signalled a refusal (rather than the model
   * returning our `{"refused": true}` contract). Anthropic reports this as a
   * `refusal` stop reason.
   */
  providerRefused: boolean;
  /** Tokens the provider reported for this call. Absent when it reported none. */
  usage?: TokenUsage;
  /**
   * Wall-clock milliseconds for the call, rate-limit waits included. Measured
   * once, when the call is made live, and stored with the recording; replay
   * reads it back and never measures anything.
   */
  latencyMs?: number;
}

export interface ModelProvider {
  /** Provider name, e.g. `anthropic`. Part of the replay key. */
  readonly name: string;
  /** Exact model id. Part of the replay key, so a model swap re-records. */
  readonly model: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Token counts, when the provider reports both. Each provider names them
 * differently; this is the one place they become the same shape. Missing counts
 * stay missing rather than becoming zero, because zero would be a claim.
 */
function tokenUsage(input: number | undefined, output: number | undefined): { usage?: TokenUsage } {
  return typeof input === 'number' && typeof output === 'number'
    ? { usage: { inputTokens: input, outputTokens: output } }
    : {};
}

/**
 * Transport-level retry for rate limits, and why it does not violate hard
 * rule #4.
 *
 * Rule #4 forbids silently retrying a FAILED LLM STEP onto the money path. A
 * 429 is not a failed step: the model never ran, no output was produced, and
 * there is nothing to paper over. Retrying is completing a request that was
 * never served, not re-rolling a result we did not like.
 *
 * Three constraints keep it inside the rule's intent: it fires only on 429 and
 * 5xx, only before any model output exists, and it is bounded and reported --
 * `attempts` rides back on the response and lands in the audit trail. A
 * retried call is visible, not silent.
 *
 * F-007 lost a whole holdout generation to this exact limit, and the lesson was
 * fixed only in the corpus generator. F-012 is the same failure recurring here,
 * in a component written afterwards.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** Providers name the wait in their own error body. Prefer it over a guess. */
export function retryDelayMs(body: string, attempt: number): number {
  const match = /try again in ([0-9.]+)s/i.exec(body);
  if (match?.[1]) return Math.ceil(Number(match[1]) * 1000) + 500;
  return Math.min(30_000, 2 ** attempt * 1000);
}

async function withRateLimitRetry(
  attemptOnce: (attempt: number) => Promise<ModelResponse>,
  signal: AbortSignal,
): Promise<ModelResponse> {
  let lastError: ProviderError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await attemptOnce(attempt);
      return { ...response, attempts: attempt };
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.status === undefined ||
        !RETRYABLE_STATUSES.has(error.status) ||
        attempt === MAX_ATTEMPTS ||
        signal.aborted
      ) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error.message, attempt)));
    }
  }
  throw lastError ?? new ProviderError('retry loop exhausted with no error recorded');
}

/**
 * Anthropic Messages API. Single-shot, structured output requested in the
 * prompt, no tools.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    return withRateLimitRetry(() => this.attempt(request, signal), signal);
  }

  private async attempt(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `anthropic ${response.status}: ${(await response.text()).slice(0, 400)}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      stop_reason?: string;
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      providerRefused: body.stop_reason === 'refusal',
      ...tokenUsage(body.usage?.input_tokens, body.usage?.output_tokens),
    };
  }
}

/**
 * Any OpenAI-compatible chat-completions endpoint. Used for Groq.
 *
 * Kept because it is the provider the project actually has a key for, and
 * because having two implementations behind one interface is what proves the
 * interface is real rather than an Anthropic client with extra steps.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    return withRateLimitRetry(() => this.attempt(request, signal), signal);
  }

  private async attempt(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `${this.name} ${response.status}: ${(await response.text()).slice(0, 400)}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = body.choices?.[0];

    // F-002: this provider can return HTTP 200 with an empty content string
    // when the output budget is consumed before any text is emitted. That is a
    // provider success and an assembly failure, and it must not look like a
    // model that said nothing on purpose.
    return {
      text: choice?.message?.content ?? '',
      providerRefused: Boolean(choice?.message?.refusal),
      ...tokenUsage(body.usage?.prompt_tokens, body.usage?.completion_tokens),
    };
  }
}
