import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/migration',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'migration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/tools/migration',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // Testing & quality strategy: 70% for this project.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
}));
