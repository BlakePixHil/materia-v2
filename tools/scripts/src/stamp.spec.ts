import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FUNCTIONS_ENV_FILE, main, renderWebVersion, validate, WEB_VERSION_FILE } from './stamp.ts';

describe('stamp', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  afterAll(() => log.mockRestore());

  it('writes the web version file and the functions env file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stamp-'));
    await main(['--target', 'web', '--version', 'v0.1.0', '--sha', 'abc1234def'], root);
    await main(['--target', 'functions', '--version', 'v0.1.0', '--sha', 'abc1234def'], root);
    expect(readFileSync(path.join(root, WEB_VERSION_FILE), 'utf8')).toContain(
      "export const RELEASE = { version: 'v0.1.0', sha: 'abc1234def' } as const;",
    );
    expect(readFileSync(path.join(root, FUNCTIONS_ENV_FILE), 'utf8')).toBe(
      'MATERIA_RELEASE_VERSION=v0.1.0\nMATERIA_RELEASE_SHA=abc1234def\n',
    );
  });

  it('matches the committed web version file format', () => {
    const committed = readFileSync(path.resolve(import.meta.dirname, '../../..', WEB_VERSION_FILE), 'utf8');
    expect(committed).toBe(renderWebVersion('0.0.0-dev', '0000000'));
  });

  it('rejects bad input, so nothing odd lands in source or env files', async () => {
    expect(() => validate("1.0'; alert(1)", 'abc1234')).toThrow('Invalid --version');
    expect(() => validate('1.0.0', 'not-a-sha')).toThrow('Invalid --sha');
    await expect(main(['--target', 'mobile', '--version', '1.0.0', '--sha', 'abc1234'])).rejects.toThrow('--target');
  });
});
