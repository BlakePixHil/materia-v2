/// <reference types='vitest' />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/data-access',
  plugins: [angular({ tsconfig: `${import.meta.dirname}/tsconfig.spec.json` })],
  resolve: { tsconfigPaths: true },
  test: {
    name: 'data-access',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/libs/data-access',
      provider: 'v8' as const,
      reporter: ['text-summary', 'json-summary'],
      // Testing & quality strategy: 70% for this project.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
}));
