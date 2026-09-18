import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  type ModelProvider,
} from './provider.js';

/**
 * Which model the assembler runs on, and why the answer is currently not the
 * one CLAUDE.md §4 names.
 *
 * The intended provider is Anthropic (CLAUDE.md §4). No `ANTHROPIC_API_KEY`
 * exists in this environment, so the recorded fixtures were produced by the
 * provider the project does have a key for. The choice of *which* model is not
 * arbitrary and is the part worth understanding:
 *
 *   The held-out corpus's conversation language was written by
 *   `openai/gpt-oss-120b`. If the assembler ran on that same model, the holdout
 *   would no longer be out-of-distribution for the system under test -- the
 *   same model would be writing the text and reading it, and the OOD delta
 *   would measure nothing. So the assembler runs on a DIFFERENT family
 *   (`qwen/qwen3.8-27b`, Alibaba) from the holdout's writer (OpenAI gpt-oss),
 *   which preserves the separation the eval depends on.
 *
 * Swapping to Anthropic is a one-line change plus a `--live` re-record: the
 * provider name and model id are both part of the replay key, so every fixture
 * re-records rather than silently serving output from the wrong model.
 *
 * See DECISIONS.md D-021 and TASKS.md P2.3.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_FALLBACK_MODEL = 'qwen/qwen3.8-27b';

/** The model family that wrote the held-out corpus. The assembler must not use it. */
export const HOLDOUT_LANGUAGE_MODEL_FAMILY = 'openai/gpt-oss';

/**
 * Matched anywhere in the model id, not just at the start.
 *
 * The prefix check this replaces only caught `openai/gpt-oss-*`. The same
 * weights served under another vendor's prefix -- or the `gpt-oss-safeguard`
 * variant -- would have passed it while contaminating the holdout exactly as
 * much. The family name is the thing that matters, wherever it appears.
 */
const HOLDOUT_FAMILY_TOKEN = 'gpt-oss';

export interface ProviderEnv {
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_MODEL?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  ASSEMBLY_MODEL?: string | undefined;
}

/**
 * Build the provider from the environment.
 *
 * Anthropic wins whenever a key exists. Otherwise Groq, on a model that is not
 * from the holdout's family -- which is asserted here rather than left to
 * whoever edits the env var next.
 */
export function providerFromEnv(env: ProviderEnv): ModelProvider {
  if (env.ANTHROPIC_API_KEY) {
    const model = env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    // Checked on this path too. The guard used to run only on the Groq branch,
    // which left the rule true by accident rather than by enforcement.
    assertNotHoldoutFamily(model);
    return new AnthropicProvider(model, env.ANTHROPIC_API_KEY);
  }
  if (env.GROQ_API_KEY) {
    const model = env.ASSEMBLY_MODEL ?? DEFAULT_FALLBACK_MODEL;
    assertNotHoldoutFamily(model);
    return new OpenAiCompatibleProvider(
      'groq',
      model,
      env.GROQ_API_KEY,
      'https://api.groq.com/openai/v1',
    );
  }
  throw new Error(
    'no model provider configured: set ANTHROPIC_API_KEY (preferred) or GROQ_API_KEY. ' +
      'Replay mode needs neither -- this is only reached with --live.',
  );
}

/**
 * Refuse to run the assembler on the model that wrote the held-out corpus.
 *
 * Enforced in code because it is exactly the kind of contamination that would
 * never announce itself: everything would run, the numbers would look fine, and
 * the OOD claim would be quietly false.
 */
export function assertNotHoldoutFamily(model: string): void {
  if (model.toLowerCase().includes(HOLDOUT_FAMILY_TOKEN)) {
    throw new Error(
      `${model} wrote the held-out corpus's conversation language. Running the assembler on it ` +
        'would make the holdout in-distribution for the system under test and destroy the OOD delta.',
    );
  }
}
