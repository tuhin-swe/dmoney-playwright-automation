// @ts-check
const { defineConfig, devices } = require('@playwright/test');
require('dotenv').config();

/**
 * Playwright configuration for the DMoney end-to-end assignment.
 *
 * Two logical suites are driven from one spec using Playwright test tags:
 *   - Regression : the full journey including the negative case  -> `npm run regression`
 *   - Smoke      : positive-path checks only (tagged @smoke)     -> `npm run smoke`
 *
 * The journey is stateful (register -> activate -> deposit -> ...), so it runs
 * in a single file with `test.describe.serial` and one worker.
 */
module.exports = defineConfig({
  testDir: './tests',
  // Generous per-test budget: the agent login OTP is emailed, and delivery latency
  // can spike when the portal's mail queue is busy.
  timeout: 300_000,
  expect: { timeout: 20_000 },

  // The journey must execute in order on a single worker; state is shared in-memory.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'https://dmoneyportal.roadtocareer.net',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // Submission requires a headed recording, so default to headed; set HEADLESS=1
    // for a fast validation run.
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1366, height: 768 },
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
