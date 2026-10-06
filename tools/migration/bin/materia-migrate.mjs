#!/usr/bin/env node
// Runs the TypeScript entry point through tsx, so the tool needs no build step.
import { fileURLToPath } from 'node:url';

import { register as registerCjs } from 'tsx/cjs/api';
import { register } from 'tsx/esm/api';

// Use this package's tsconfig so the @materia/* path aliases resolve. The CommonJS hook is needed
// for workspace libs (such as @materia/domain) that load as CommonJS.
const tsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
// The CommonJS hook takes its tsconfig from this variable (its options don't accept one).
process.env.TSX_TSCONFIG_PATH = tsconfig;
registerCjs();
register({ tsconfig });
const { run } = await import('../src/main.ts');
process.exitCode = await run(process.argv.slice(2));
