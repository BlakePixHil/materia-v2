import { defineConfig } from 'vitest/config';

/**
 * Container integration tests (CORE-12a): run the scan and preview services in their images
 * (SCANNER_IMAGE, PREVIEW_IMAGE; CI builds them) and call them over HTTP with fixture files. A
 * suite whose image isn't set is skipped.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/doc-services-integration',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'doc-services-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    reporters: ['default'],
  },
}));
