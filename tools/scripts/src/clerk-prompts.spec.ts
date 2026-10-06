import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DISCLOSURE_DIR, DISCLOSURE_FILE, GENERATED_FILE, main, PROMPTS_DIR } from './clerk-prompts.ts';

const PROMPT =
  '---\nid: demo\nversion: 1.0.0\neffort: low\nmaxTokens: 100\n---\n\n# System\n\nYou are Clerk.\n\n# User\n\nHi {{name}}.\n';

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'clerk-prompts-'));
  mkdirSync(path.join(root, PROMPTS_DIR), { recursive: true });
  mkdirSync(path.dirname(path.join(root, GENERATED_FILE)), { recursive: true });
  writeFileSync(path.join(root, PROMPTS_DIR, 'demo@1.0.0.md'), PROMPT);
  writeFileSync(path.join(root, PROMPTS_DIR, 'README.txt'), 'not a prompt');
  writeFileSync(path.join(root, GENERATED_FILE), 'stale');
  mkdirSync(path.join(root, DISCLOSURE_DIR), { recursive: true });
  mkdirSync(path.dirname(path.join(root, DISCLOSURE_FILE)), { recursive: true });
  writeFileSync(path.join(root, DISCLOSURE_DIR, 'disclosure@1.md'), '## Where\n\nOutside Australia.\n');
  writeFileSync(path.join(root, DISCLOSURE_FILE), 'stale');
  return root;
}

describe('clerk-prompts', () => {
  it('compiles the prompts, and --check fails on drift', async () => {
    const root = workspace();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main(['--check'], root)).rejects.toThrow(/out of date/);
    await main([], root);
    const generated = readFileSync(path.join(root, GENERATED_FILE), 'utf8');
    expect(generated).toContain('"demo@1.0.0"');
    expect(generated).not.toContain('README');
    const disclosure = readFileSync(path.join(root, DISCLOSURE_FILE), 'utf8');
    expect(disclosure).toContain('export const CLERK_DISCLOSURE_VERSION = 1;');
    expect(disclosure).toContain('Outside Australia.');
    await expect(main(['--check'], root)).resolves.toBeUndefined();
    await main([], root);
    expect(log).toHaveBeenLastCalledWith('Clerk prompts already compiled.');
    log.mockRestore();
  });

  it('rejects a broken prompt', async () => {
    const root = workspace();
    writeFileSync(path.join(root, PROMPTS_DIR, 'demo@1.0.0.md'), PROMPT.replace('effort: low', 'effort: extreme'));
    await expect(main([], root)).rejects.toThrow(/effort/);
  });
});
