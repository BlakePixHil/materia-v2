/// <reference types='vitest' />
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vite';

// Repositories, paging and the listener lifecycle against the Firestore emulator (FND-19), through
// the real full SDK and the real rules. Run with `pnpm nx run data-access:test-integration`.
// (Named so the Nx Vitest plugin doesn't infer an emulator-less target from it.)
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/data-access-integration',
  plugins: [angular({ tsconfig: `${import.meta.dirname}/tsconfig.spec.json` })],
  resolve: { tsconfigPaths: true },
  test: {
    name: 'data-access-integration',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.int.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
}));
