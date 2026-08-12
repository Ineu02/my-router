import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Lint config.
 *
 * Type-aware rules are on for `src/**` only: they need a tsconfig, and build
 * output has none. The rule set is deliberately small — it catches real
 * mistakes (floating promises, unsafe `any` narrowing, unused code) and stays
 * out of the way on style, which the formatter already settles.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/coverage/**',
    ],
  },

  // Plain JS (this config file, and any tooling scripts) gets the base rules
  // only — type-aware linting needs a tsconfig these files aren't part of.
  {
    files: ['**/*.js', '**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling files belong to no package tsconfig; lint them
          // against the default project rather than excluding them.
          allowDefaultProject: ['vitest.config.ts', '*.config.ts', 'apps/web/vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // An unused arg named `_x` is intentional (destructured-and-dropped is
      // how secrets are stripped from responses in this codebase).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Upstream JSON is genuinely `any`; the adapters validate at the edge.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // A dropped promise in the request path is a real bug, so this stays on.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Tests and scripts print and poke at internals by design.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // The mock upstream is a test double: it fabricates responses on purpose.
  {
    files: ['apps/api/src/mock/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
