/**
 * P0.5 acceptance: prove a completion returns from the SECOND provider.
 *
 * Why a second provider exists at all: the held-out eval set (P1.3) must be
 * out-of-distribution *by construction*, not by promise. Generating it with a
 * different model family than the dev corpus is the structural property that
 * makes "we didn't tune to our own generator" checkable rather than asserted.
 *
 * Deliberately dependency-free: a raw fetch against Groq's OpenAI-compatible
 * endpoint. One less SDK to explain, and the request shape stays visible.
 *
 *   pnpm check:ood-provider
 */
import process from 'node:process';

process.loadEnvFile?.('.env');

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('FAIL: GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // gpt-oss is a reasoning model: it spends tokens on hidden reasoning
      // before emitting any content, and those count against max_tokens. A tight
      // budget returns finish_reason "length" with content: "". The OOD generator
      // (P1.3) must budget for this too -- see FAILURES.md F-002.
      max_tokens: 512,
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'Reply with exactly: OOD_PROVIDER_OK' }],
    }),
  });

  if (!response.ok) {
    console.error(`FAIL: ${response.status} ${response.statusText}`);
    console.error((await response.text()).slice(0, 600));
    process.exit(1);
  }

  const body = (await response.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content?.trim();

  if (!text) {
    console.error('FAIL: provider returned no completion text.');
    console.error(JSON.stringify(body).slice(0, 600));
    process.exit(1);
  }

  console.log(`OK: second provider responded.`);
  console.log(`  endpoint: ${ENDPOINT}`);
  console.log(`  model:    ${body.model ?? MODEL}`);
  console.log(`  content:  ${text}`);
}

main().catch((error: unknown) => {
  console.error('FAIL: request threw.');
  console.error(error);
  process.exit(1);
});
