import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { permissionsTable } from './permissions';

const README = path.resolve(import.meta.dirname, '../../README.md');
const START = '<!-- permissions:start -->';
const END = '<!-- permissions:end -->';

function withTable(readme: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end < start) throw new Error('README is missing the permissions markers');
  return `${readme.slice(0, start + START.length)}\n\n${permissionsTable()}\n\n${readme.slice(end)}`;
}

describe('libs/domain/README.md', () => {
  it('contains the permissions table generated from PERMISSIONS', () => {
    const current = readFileSync(README, 'utf8');
    const expected = withTable(current);
    if (process.env['UPDATE_PERMISSIONS_README'] === '1' && expected !== current) writeFileSync(README, expected);
    else expect(current, 'Run: UPDATE_PERMISSIONS_README=1 pnpm nx test domain').toBe(expected);
  });

  it('requires the markers', () => {
    expect(() => withTable('no markers')).toThrow('missing the permissions markers');
  });
});
