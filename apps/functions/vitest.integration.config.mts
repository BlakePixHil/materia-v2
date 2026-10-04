import { defineConfig } from 'vitest/config';

// Integration tests against the emulators (auth, firestore, functions, Cloud Tasks). Run them with
// `pnpm nx run functions:test-integration`, which builds the functions first.
// (Named so the Nx Vitest plugin doesn't infer an emulator-less target from it.)
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: 'functions-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
