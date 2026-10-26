import { defineConfig } from 'vitest/config';

// node:sqlite prints an ExperimentalWarning in every test process on Node 22; keep the output to the
// results (the test workers inherit this).
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim();

// Golden tests of the pure chess logic and protocol tests against verify-mode instances (ADR 0006).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    globalSetup: ['scripts/test/build-web.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
