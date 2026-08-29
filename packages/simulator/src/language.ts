import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import type { GeneratedTransaction } from './transaction.js';

/**
 * Conversation language for the held-out corpus, written by a *different model
 * from a different lab* than anything the dev corpus touches.
 *
 * This is the sharp edge of the out-of-distribution claim. The structural axes
 * -- verticals, price bands, class mix, agent platforms -- could all be matched
 * by a careful hand-written second config. The natural language could not: the
 * dev traces come from templates in this repo, and these come from
 * `openai/gpt-oss-120b`. The LLM assembly layer's whole job is reading that
 * language, so this is the axis its degradation will actually show up on.
 *
 * **Cached to a committed fixture, keyed by request hash.** Generation runs
 * once; every run after that is offline and deterministic. This is the same
 * record/replay discipline `packages/llm` will use for the eval path (P2.3),
 * applied here because a holdout that regenerates differently each run is not a
 * holdout -- it is a moving target.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_RETRIES = 6;

/** Personas exist only here. The dev generator has no notion of a persona. */
const PERSONAS = [
  'a terse professional who types in fragments and rarely uses punctuation',
  'a chatty customer who explains their reasoning at length before deciding',
  'a cautious first-time user of an AI shopping agent who asks for confirmation twice',
  'a hurried parent multitasking, with typos and abbreviations',
  'a precise, formal customer who states exact requirements up front',
  'a customer who switches between English and transliterated Hindi mid-sentence',
];

const turnSchema = z.object({
  role: z.enum(['customer', 'agent', 'system']),
  content: z.string().min(1).max(600),
});

const responseSchema = z.object({
  turns: z.array(turnSchema).min(2).max(12),
});

export type GeneratedTurns = z.infer<typeof responseSchema>['turns'];

export interface LanguageCache {
  model: string;
  entries: Record<string, GeneratedTurns>;
}

function emptyCache(model: string): LanguageCache {
  return { model, entries: {} };
}

export function loadCache(path: string, model: string): LanguageCache {
  if (!existsSync(path)) return emptyCache(model);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LanguageCache;
  } catch {
    return emptyCache(model);
  }
}

export function saveCache(path: string, cache: LanguageCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * The cache key. Built only from seed-derived facts -- never from a row id or a
 * wall-clock time -- so regenerating the corpus produces the same keys and the
 * committed cache still hits. Same rule as DECISIONS.md D-007.
 */
export function requestKey(model: string, prompt: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex').slice(0, 32);
}

export function buildPrompt(transaction: GeneratedTransaction, persona: string): string {
  const facts = transaction.facts;
  const pack = transaction.pack;
  const item = (pack.order.items[0]?.name ?? 'the item').toLowerCase();
  const rupees = (transaction.amount / 100).toLocaleString('en-IN');

  const situation =
    facts.anomalousAgentBehaviour
      ? 'The session was hijacked partway through: a third party is now driving the agent. The later customer turns should read as out of character - rushed, unusually large, pushing for speed.'
      : facts.customerConfirmedInTrace
        ? 'The customer explicitly and unambiguously confirms this specific purchase at this specific price before the agent pays.'
        : 'The customer never explicitly confirms this specific purchase. They give a vague, open-ended instruction and the agent proceeds on its own judgement.';

  const extra =
    transaction.scenarioClass === 'b4'
      ? facts.customerConfirmedInTrace
        ? ' The agent orders exactly the variant the customer confirmed.'
        : ' The requested variant is unavailable and the agent substitutes a different one without asking.'
      : '';

  // Written as a flat instruction rather than a chat-history: gpt-oss is a
  // reasoning model and does better with the constraints stated once, plainly.
  return [
    'You are generating a realistic transcript of a conversation between a customer and an AI shopping agent that can pay using a saved UPI mandate.',
    '',
    `Customer persona: ${persona}.`,
    `Item: ${item}. Price: Rs ${rupees}.`,
    `Situation: ${situation}${extra}`,
    '',
    'Rules:',
    '- Write between 4 and 8 turns.',
    '- Roles are "customer", "agent", or "system". Use "system" only for automated notices.',
    '- The agent must state the item and the price before paying.',
    '- Do not invent order numbers, transaction ids, or dates.',
    '- Keep each turn under 300 characters.',
    '- The transcript must be consistent with the Situation above; this is evidence in a payment dispute.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"turns":[{"role":"customer","content":"..."}]}',
  ].join('\n');
}

export interface OodLanguageOptions {
  apiKey: string;
  model: string;
  cachePath: string;
  /** When false, a cache miss is an error instead of a live call. */
  allowLive: boolean;
}

export class OodLanguageGenerator {
  private readonly cache: LanguageCache;
  private liveCalls = 0;
  private cacheHits = 0;

  constructor(private readonly options: OodLanguageOptions) {
    this.cache = loadCache(options.cachePath, options.model);
  }

  get stats(): { liveCalls: number; cacheHits: number } {
    return { liveCalls: this.liveCalls, cacheHits: this.cacheHits };
  }

  personaFor(index: number): string {
    // Deterministic persona assignment: index-driven, not random.
    return PERSONAS[index % PERSONAS.length] as string;
  }

  async turnsFor(transaction: GeneratedTransaction): Promise<GeneratedTurns> {
    const persona = this.personaFor(transaction.index);
    const prompt = buildPrompt(transaction, persona);
    const key = requestKey(this.options.model, prompt);

    const cached = this.cache.entries[key];
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }

    if (!this.options.allowLive) {
      throw new Error(
        `cache miss for ${transaction.scenarioClass}#${transaction.index} and live calls are disabled. ` +
          'Run the holdout generator with --live to record it.',
      );
    }

    const turns = await this.callModel(prompt);
    this.cache.entries[key] = turns;
    this.liveCalls += 1;
    // Persist after every successful call. Free-tier rate limits make a long
    // recording run genuinely likely to die partway through, and losing an
    // hour of recorded language to an unhandled 429 would be self-inflicted.
    this.persist();
    return turns;
  }

  /**
   * Seconds the provider asks us to wait, read off its own message.
   * Falls back to exponential backoff when it does not say.
   */
  private static retryDelayMs(body: string, attempt: number): number {
    const match = /try again in ([0-9.]+)s/i.exec(body);
    if (match?.[1]) return Math.ceil(Number(match[1]) * 1000) + 500;
    return Math.min(30_000, 2 ** attempt * 1000);
  }

  private async callModel(prompt: string, attempt = 0): Promise<GeneratedTurns> {
    const response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.9, // Variety is the point here, unlike on the money path.
        // gpt-oss spends tokens on hidden reasoning before emitting anything,
        // and those count against max_tokens. A tight budget returns 200 OK with
        // empty content. See FAILURES.md F-002.
        max_tokens: 1200,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();

      // 429 is expected on a free tier, not exceptional: the corpus is a few
      // dozen calls against an 8000 tokens-per-minute ceiling. Wait as long as
      // the provider asks and continue. See FAILURES.md F-007.
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const waitMs = OodLanguageGenerator.retryDelayMs(body, attempt);
        console.warn(`  ${response.status} from language model, retrying in ${(waitMs / 1000).toFixed(1)}s...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.callModel(prompt, attempt + 1);
      }

      throw new Error(`OOD language model returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OOD language model returned empty content');

    const parsed = responseSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      throw new Error(`OOD language model returned off-schema JSON: ${parsed.error.message.slice(0, 300)}`);
    }
    return parsed.data.turns;
  }

  persist(): void {
    saveCache(this.options.cachePath, this.cache);
  }
}
