import { defineConfig } from 'vitest/config';

import { DurationSequencer } from './tests/integration/support/sequencer';

// Integration tests against the emulators (auth, firestore, functions, storage, Cloud Tasks). Run them with
// `pnpm nx run functions:test-integration`, which builds the functions first.
// (Named so the Nx Vitest plugin doesn't infer an emulator-less target from it.)
// The target runs the files in five shards, each against fresh emulators: the Functions emulator
// keeps a worker process for every function it has run (about 90 by the end of one run, ~150 MB
// each), and on a CI runner a new worker then failed to start and its request hung. Each shard is
// wrapped in `timeout` (6 minutes; each shard takes about 4), so a hang fails the job with its log
// instead of reaching the job's limit. The shards are split by the files' running times (see the
// sequencer).
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: 'functions-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    // Each file starts once the triggers earlier files queued have run (see the file).
    setupFiles: ['tests/integration/support/drain-triggers.ts'],
    fileParallelism: false,
    sequence: { sequencer: DurationSequencer },
    // Tests wait for triggers and tasks with polls of up to 45 s: their events queue behind the
    // whole shard's, and each function's first call waits for its worker to start. At 30 s a test
    // was cut off while its polls were in bounds, and the next test's reset then deleted the data
    // its late answer was writing. The shard's 6-minute timeout still catches a hang.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: process.env['CI'] ? ['default', 'hanging-process'] : ['default'],
  },
});
