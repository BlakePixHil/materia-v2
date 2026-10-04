import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/deadlines',
  resolve: { tsconfigPaths: true },
  test: {
    name: 'deadlines',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/libs/deadlines',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // Testing & quality strategy: 90% for this project.
      exclude: ['src/golden/scenarios.ts', 'data/**'],
      // CORE-09: the engine core is fully covered; the rest of the lib at least 90%.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        'src/lib/{engine,calendar,model}.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
}));
