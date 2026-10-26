import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  {
    ignores: ['**/node_modules/', '**/dist/', 'packages/web/public/engine/', 'test-results/', 'playwright-report/', 'evidence/', '.verify/', 'data-prep/'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'svelte/no-useless-mustaches': ['error', { ignoreStringEscape: true }],
    },
  },
  {
    files: ['packages/web/**', 'e2e/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/web/src/sw-template.js'],
    // The build replaces __FILES__ with the precache list.
    languageOptions: { globals: { ...globals.serviceworker, __FILES__: 'readonly' } },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] } },
  },
);
