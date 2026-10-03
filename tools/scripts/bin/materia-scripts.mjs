#!/usr/bin/env node
// Runs the TypeScript entry point through tsx, so the tool needs no build step.
import { fileURLToPath } from 'node:url';

import { register } from 'tsx/esm/api';

// Use this package's tsconfig so the @materia/* path aliases resolve.
register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
const { run } = await import('../src/main.ts');
process.exitCode = await run(process.argv.slice(2));
