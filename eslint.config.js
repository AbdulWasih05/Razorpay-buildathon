// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/ui/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },

  // --- Architectural boundary, enforced by the linter, not by discipline ---
  // CLAUDE.md hard rule #4: the LLM never touches the money path. packages/core
  // holds the domain (dispute entities, gate, mapping) and must stay deterministic,
  // so it may not import the LLM package or any model SDK. If this rule ever fires,
  // the fix is to move the logic out of core -- never to weaken the rule.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@praman/llm', '@praman/llm/*'], message: 'packages/core is the deterministic domain: no LLM imports (CLAUDE.md hard rule #4).' },
            { group: ['@anthropic-ai/*', 'openai', 'groq-sdk', '@google/*'], message: 'No model SDKs in packages/core (CLAUDE.md hard rule #4).' },
          ],
        },
      ],
    },
  },
);
