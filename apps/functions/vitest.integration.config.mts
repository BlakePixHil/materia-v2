import { defineConfig } from 'vitest/config';

// Integration tests against the emulators (auth, firestore, functions, storage, Cloud Tasks). Run them with
// `pnpm nx run functions:test-integration`, which builds the functions first.
// (Named so the Nx Vitest plugin doesn't infer an emulator-less target from it.)
// The target runs the files in three shards, each against fresh emulators: the Functions emulator
// keeps a worker process for every function it has run (about 90 by the end of one run, ~150 MB
// each), and on a CI runner a new worker then failed to start and its request hung. Each shard is
// wrapped in `timeout`, so a hang fails the job with its log instead of reaching the job's limit.
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
    reporters: process.env['CI'] ? ['default', 'hanging-process'] : ['default'],
  },
});
