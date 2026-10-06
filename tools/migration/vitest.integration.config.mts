import { defineConfig } from 'vitest/config';

// The auth import (MIG-04) against the Auth emulator. Run with `pnpm nx run
// migration:test-integration`. (Named so the Nx Vitest plugin doesn't infer an emulator-less
// target from it.)
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/migration-integration',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'migration-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.int.spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    reporters: ['default'],
  },
}));
