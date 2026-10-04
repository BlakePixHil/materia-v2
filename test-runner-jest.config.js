// Storybook test-runner (FND-07): `pnpm nx run ui:test-storybook` runs every story's play function
// and the a11y checks against a running Storybook.
import { getJestConfig } from '@storybook/test-runner';

const testRunnerConfig = getJestConfig();

// Environments with a pre-installed Chromium (cloud agent sessions) point Playwright at it.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];

/** @type {import('@jest/types').Config.InitialOptions} */
export default {
  ...testRunnerConfig,
  // Build output contains copies of package.json files that confuse jest-haste-map.
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testEnvironmentOptions: {
    'jest-playwright': {
      ...testRunnerConfig.testEnvironmentOptions?.['jest-playwright'],
      browsers: ['chromium'],
      ...(executablePath ? { launchOptions: { executablePath } } : {}),
    },
  },
};
