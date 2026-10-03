import { defineConfig } from 'vitest/config';

// Rules tests need the Firestore and Storage emulators: run them with `pnpm nx run firebase:test-rules`.
// (Named so the Nx Vitest plugin doesn't infer an emulator-less `test` target.)
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: 'firebase-rules',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // The emulators are shared, so rules suites run one file at a time.
    fileParallelism: false,
    reporters: ['default'],
  },
});
