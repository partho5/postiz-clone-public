// Browser e2e (tenancy leak tests and later suites): Playwright runs e2e/ against an app that is
// already running (Postgres, Redis, Temporal, backend, orchestrator, frontend).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './tmp/e2e/test-results',
  // One browser at a time: the suite shares one app, and a dev server compiles pages on demand
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: './tmp/e2e/report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4200',
    timezoneId: 'UTC',
    // A stack behind Caddy's own certificate (deploy/scripts/deploy.sh on localhost)
    ignoreHTTPSErrors: !!process.env.E2E_IGNORE_HTTPS_ERRORS,
    // Extra browser flags, separated by | (e.g. --host-resolver-rules=MAP localhost 127.0.0.1)
    launchOptions: {
      args: (process.env.E2E_CHROMIUM_ARGS || '').split('|').filter(Boolean),
    },
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
