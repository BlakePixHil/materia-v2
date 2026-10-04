/**
 * `materia-scripts clerk-prompts [--check]` (AI-02): compiles libs/clerk/prompts/*.md into
 * libs/clerk/src/lib/prompt-sources.generated.ts, so Functions bundle the prompts. Each file is
 * parsed first (front-matter, sections, output schema), so a broken prompt fails here. `--check`
 * writes nothing and fails on drift (the libs/clerk unit tests check the same).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as clerkModule from '@materia/clerk';

import { unwrap } from './seed/interop.ts';

export const PROMPTS_DIR = 'libs/clerk/prompts';
export const GENERATED_FILE = 'libs/clerk/src/lib/prompt-sources.generated.ts';

export function readPromptFiles(root: string): { name: string; content: string }[] {
  const dir = path.join(root, PROMPTS_DIR);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ name: file.slice(0, -3), content: readFileSync(path.join(dir, file), 'utf8') }));
}

export async function main(argv: string[], root = process.cwd()): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } });
  const files = readPromptFiles(root);
  const next = unwrap(clerkModule).generatePromptModule(files);
  const target = path.join(root, GENERATED_FILE);
  const current = readFileSync(target, 'utf8');
  if (values.check) {
    if (current !== next)
      throw new Error(`${GENERATED_FILE} is out of date. Run \`pnpm materia-scripts clerk-prompts\`.`);
    console.log(`${files.length} Clerk prompt(s) compiled and in sync.`);
    return;
  }
  if (current !== next) writeFileSync(target, next);
  console.log(current === next ? 'Clerk prompts already compiled.' : `Compiled ${files.length} Clerk prompt(s).`);
}
