import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// This config deliberately imports nothing from Nx: Playwright loads `.mts` configs as native ESM,
// and Nx's native module cannot load there. The output paths match what nxE2EPreset used.
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.join(workspaceRoot, 'dist/.playwright/apps/web-e2e');

// For CI, BASE_URL can point at a deployed preview instead of the local dev server.
const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';

// Environments with a pre-installed Chromium (for example cloud agent sessions) can point
// Playwright at it instead of downloading browsers.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];

/** Playwright e2e for apps/web (ADR-017). FND-04 adds axe checks and the CI browser matrix. */
export default defineConfig({
  testDir: './src',
  outputDir: path.join(outputRoot, 'test-output'),
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['html', { outputFolder: path.join(outputRoot, 'playwright-report'), open: 'never' }], ['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm exec nx run web:serve',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env['CI'],
    cwd: workspaceRoot,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
});
