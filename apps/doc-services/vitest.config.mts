import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/doc-services',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'doc-services',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/doc-services',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // The entry points start processes and listen: covered by the container test (`nx run doc-services:test-container`).
      exclude: ['src/scanner.ts', 'src/preview.ts'],
      // Testing & quality strategy: 70% for this project.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
}));
