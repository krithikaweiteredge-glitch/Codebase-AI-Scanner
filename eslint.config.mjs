// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Flat config covering both workspaces.
 *
 * Deliberately the non-type-checked typescript-eslint preset: `tsc` already
 * runs in CI and catches everything the type-aware rules would, an order of
 * magnitude faster. What this adds is the class of mistake the compiler is
 * happy with - unused bindings, unreachable cases, `console.log` left behind,
 * a hook whose dependency list has drifted.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/api/prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // The codebase uses a leading underscore to mark a deliberately unused
      // binding (Fastify handler signatures, destructured rest properties).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is worth flagging but not worth blocking a build over.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ---- API: Node -----------------------------------------------------------
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Entry points and the worker legitimately write to stdout - that is their
  // only channel before the logger exists, or their whole purpose.
  {
    files: ['apps/api/src/worker.ts', 'apps/api/prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },

  // ---- Web: browser + React ------------------------------------------------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Real advice - a synchronous setState in an effect costs an extra
      // render pass - but it flags a long-standing, working pattern rather
      // than a defect. Kept visible as a warning so the existing call sites
      // are not silently blessed, without blocking the build on a refactor of
      // components that have no tests yet.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // ---- Tests ---------------------------------------------------------------
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Tests deliberately build malformed input and stub loose shapes.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
