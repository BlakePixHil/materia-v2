import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/jobs',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'jobs',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/jobs',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // qpdf, Chromium, Cloud Storage and Firestore adapters: covered by the container integration
      // test (`nx run jobs:test-container`), which runs them for real against fixture PDFs.
      exclude: ['src/pdf/qpdf.ts', 'src/pdf/render.ts', 'src/pdf/merge.ts', 'src/core/firebase.ts', 'src/testing.ts'],
      // Testing & quality strategy: 70% for this project.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
}));
