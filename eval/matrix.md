# Praman — model family comparison

The same corpus, the same deterministic gate, and one row per **model family**. Every model here is served by Groq: these are model families, not providers.

Pinned in `eval/matrix.config.json` on 2026-09-30, from GET https://api.groq.com/openai/v1/models, queried with this project's own key. The account served 11 models that day. Removing audio (whisper, orpheus), classifiers (llama-prompt-guard) and the barred gpt-oss family leaves exactly two usable chat models, and both are here. The matrix is two families because the account has two, not because two were picked.

**The gate is identical on every row.** It is deterministic and runs before any model (D-025), so a dispute it declines makes no model call at all. Rows differ only where a drafter's judgement, or its ability to hold the output contract, differs.

## Decision quality

| family | model | recall dev | recall held-out | precision dev | precision held-out | false positives | assembly failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen | `qwen/qwen3.8-27b` | 29/38 = 76.3% | 7/9 = 77.8% | 100.0% | 100.0% | 0 dev, 0 held-out | 0 dev, 0 held-out |
| allam | `allam-2-7b` | 14/38 = 36.8% | 3/9 = 33.3% | 100.0% | 100.0% | 0 dev, 0 held-out | 19 dev, 4 held-out |

Zero false positives is partly a statement about the corpus, not only about the gate: most unwinnable cases are unwinnable by arithmetic. Do not quote a false-positive figure without that sentence.

## Abstention, and who abstained

| family | abstention dev | abstention held-out | gate | drafter disagreed | assembly failure |
| --- | --- | --- | --- | --- | --- |
| qwen | 71.0% | 73.3% | 67 dev, 22 held-out | 4 dev, 0 held-out | 0 dev, 0 held-out |
| allam | 86.0% | 86.7% | 67 dev, 22 held-out | 0 dev, 0 held-out | 19 dev, 4 held-out |

## What each run cost

| family | model calls | calls with token counts | input tokens | output tokens | p50 latency | p95 latency | cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen | 63 | 63 | 50332 | 8199 | 5414 ms | 13107 ms | $0.0731 |
| allam | 63 | 63 | 55627 | 11254 | 10293 ms | 15561 ms | no published price |

Latency is the figure recorded when each call was made, replayed rather than re-measured, so this file is byte-identical across replay runs. Prices come from the committed table in `packages/llm/src/pricing.ts`, which cites where and when each was read; a model with no published price reports none rather than a guess.

## Notes per model

- **qwen** (`qwen/qwen3.8-27b`): The model of record, re-sampled into its own fixture file. Its own committed recordings are never touched, so the difference between this row and the headline numbers measures run-to-run variance rather than a change of model.
- **allam** (`allam-2-7b`): The only other chat model this account serves. A much smaller model, included because the interesting question is whether the structured-output contract and the gate's veto behaviour hold when the drafter is weaker.

The headline numbers in `eval/results.md` stay the frozen model of record (D-023). This file is a comparison, never a replacement for them.
