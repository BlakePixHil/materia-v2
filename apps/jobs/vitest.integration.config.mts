import { defineConfig } from 'vitest/config';

/**
 * Container integration test (FND-24): runs the built PDF job against fixture PDFs, in the image
 * when JOBS_IMAGE is set (CI), otherwise the built bundle with the host's qpdf and CHROMIUM_PATH.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/jobs-integration',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'jobs-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.spec.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
    reporters: ['default'],
  },
}));
