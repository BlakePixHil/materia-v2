import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/functions',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'functions',
    watch: false,
    globals: true,
    environment: 'node',
    // Unit tests only; tests/integration needs the emulators (vitest.integration.config.mts).
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/functions',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // Testing & quality strategy: 70% for this project.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
}));
