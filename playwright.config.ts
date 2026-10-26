import { defineConfig, devices } from '@playwright/test';
import { quietSqliteWarning } from './packages/backend/src/runtime.ts';

// node:sqlite still prints an ExperimentalWarning on Node 22; keep the test output readable.
quietSqliteWarning();
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim();

// The Player journeys (ADR 0006). Each test starts its own verify-mode instance in-process
// (fake Coach, fake clock, Engine at a fixed depth), so tests never share state.
// The web app must be built first: npm run build -w @chess-coach/web
export default defineConfig({
  testDir: 'e2e/journeys',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  // Locally, a dot per passing test and the full detail of any failure, so a run stays short.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'dot',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1200, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results',
});
