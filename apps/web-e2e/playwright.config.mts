import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// This config deliberately imports nothing from Nx: Playwright loads `.mts` configs as native ESM,
// and Nx's native module cannot load there. The output paths match what nxE2EPreset used.
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.join(workspaceRoot, 'dist/.playwright/apps/web-e2e');

// CI sets BASE_URL to the Hosting emulator serving the built app (`build --configuration=e2e`).
// Locally, Playwright starts the dev server instead.
const baseURL = process.env['BASE_URL'];

// Environments with a pre-installed Chromium (for example cloud agent sessions) can point
// Playwright at it instead of downloading browsers.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];

/**
 * Playwright e2e for apps/web (ADR-017). Chromium on desktop plus WebKit on a mobile viewport.
 * Without WebKit installed, run `pnpm e2e -- --project=chromium`.
 */
export default defineConfig({
  testDir: './src',
  outputDir: path.join(outputRoot, 'test-output'),
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // No automatic retries: a flaky test is a bug to fix (FND-04). Traces are kept on failure.
  retries: 0,
  reporter: process.env['CI']
    ? [['html', { outputFolder: path.join(outputRoot, 'playwright-report'), open: 'never' }], ['github'], ['list']]
    : [['html', { outputFolder: path.join(outputRoot, 'playwright-report'), open: 'never' }], ['list']],
  use: {
    baseURL: baseURL ?? 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  ...(baseURL
    ? {}
    : {
        webServer: {
          command: 'pnpm exec nx run web:serve',
          url: 'http://localhost:4200',
          reuseExistingServer: true,
          cwd: workspaceRoot,
          timeout: 180_000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
    {
      name: 'webkit-mobile',
      use: { ...devices['iPhone 13'] },
    },
  ],
});
