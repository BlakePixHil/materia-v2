#!/usr/bin/env node
// Runs the TypeScript entry point through tsx, so the tool needs no build step.
import { register } from 'tsx/esm/api';

register();
const { run } = await import('../src/main.ts');
process.exitCode = await run(process.argv.slice(2));
