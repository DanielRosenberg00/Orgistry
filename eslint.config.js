// Orgistry ESLint gate (flat config).
//
// Scope: every hand-written TypeScript workspace — the API, the shared
// packages, and the web demo. The goal is a meaningful correctness gate that
// complements strict `tsc`, not a stylistic bikeshed: we lean on the
// typescript-eslint *recommended* set (no type-checking pass required, so it
// stays fast and robust across the monorepo) plus React hook rules for the web
// demo. Formatting is intentionally NOT linted here.
//
// Generated SQL migrations, build outputs, and vendored/lockfile artifacts are
// excluded explicitly below so the gate only judges source we maintain.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // ---- Global ignores (generated / build / vendor-like artifacts) ----
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      // Drizzle-generated SQL + migration journal — never hand-edited.
      'packages/db/migrations/**',
      // Background task / tool output captured during validation.
      '**/*.output',
      'pnpm-lock.yaml',
    ],
  },

  // ---- Base rule sets ----
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- All TypeScript sources default to a Node runtime ----
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `tsc` already forbids unused locals/params; mirror its `_`-prefix
      // escape hatch here so the two gates agree instead of fighting.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Allow deliberate, explained `any` at boundaries via inline disable,
      // but flag casual use.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // ---- Web demo: browser runtime + React hook correctness ----
  {
    files: ['apps/web-demo/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ---- Tests: relax rules that only make sense in production code ----
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
