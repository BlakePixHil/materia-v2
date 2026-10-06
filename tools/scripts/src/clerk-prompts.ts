/**
 * `materia-scripts clerk-prompts [--check]` (AI-02): compiles libs/clerk/prompts/*.md into
 * libs/clerk/src/lib/prompt-sources.generated.ts, so Functions bundle the prompts. Each file is
 * parsed first (front-matter, sections, output schema), so a broken prompt fails here. It also
 * compiles the data-use disclosure (libs/clerk/disclosure/disclosure@N.md, AI-13) into
 * @materia/domain for the web app and the gateway. `--check` writes nothing and fails on drift
 * (the libs/clerk unit tests check the same).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as clerkModule from '@materia/clerk';

import { unwrap } from './seed/interop.ts';

export const PROMPTS_DIR = 'libs/clerk/prompts';
export const GENERATED_FILE = 'libs/clerk/src/lib/prompt-sources.generated.ts';
export const DISCLOSURE_DIR = 'libs/clerk/disclosure';
export const DISCLOSURE_FILE = 'libs/domain/src/lib/clerk-disclosure.generated.ts';

export function readPromptFiles(root: string, dir = PROMPTS_DIR): { name: string; content: string }[] {
  const full = path.join(root, dir);
  return readdirSync(full)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ name: file.slice(0, -3), content: readFileSync(path.join(full, file), 'utf8') }));
}

export async function main(argv: string[], root = process.cwd()): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } });
  const clerk = unwrap(clerkModule);
  const files = readPromptFiles(root);
  const outputs = [
    { file: GENERATED_FILE, next: clerk.generatePromptModule(files) },
    { file: DISCLOSURE_FILE, next: clerk.generateDisclosureModule(readPromptFiles(root, DISCLOSURE_DIR)) },
  ].map((output) => ({ ...output, current: readFileSync(path.join(root, output.file), 'utf8') }));
  const stale = outputs.filter((output) => output.current !== output.next);
  if (values.check) {
    if (stale.length)
      throw new Error(
        `${stale.map((o) => o.file).join(', ')} out of date. Run \`pnpm materia-scripts clerk-prompts\`.`,
      );
    console.log(`${files.length} Clerk prompt(s) and the disclosure compiled and in sync.`);
    return;
  }
  for (const output of stale) writeFileSync(path.join(root, output.file), output.next);
  console.log(
    stale.length ? `Compiled ${files.length} Clerk prompt(s) and the disclosure.` : 'Clerk prompts already compiled.',
  );
}
