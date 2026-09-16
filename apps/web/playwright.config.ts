import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * End-to-end suite for the M1 slice. `global-setup` starts the API and the Python media worker
 * against the local Postgres; Playwright starts the built web app. See e2e/README.md.
 */
export const WEB_PORT = 3100;
export const API_PORT = 4100;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: resolve(__dirname, 'e2e/global-setup.ts'),
  globalTeardown: resolve(__dirname, 'e2e/global-teardown.ts'),
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // Sandboxes that ship their own Chromium set PLAYWRIGHT_CHROMIUM_PATH; CI installs a matching browser.
    ...(process.env['PLAYWRIGHT_CHROMIUM_PATH']
      ? { launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] } }
      : {}),
  },
  webServer: {
    command: `pnpm exec next start -p ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { API_BASE_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: 'production' },
  },
});
