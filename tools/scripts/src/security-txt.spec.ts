import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readFirebaseConfig } from './csp.ts';

// SEC-02: /.well-known/security.txt (RFC 9116) and the disclosure policy it points to. This fails a
// month before the file expires, so someone renews `Expires` before scanners start ignoring it.
const root = path.resolve(import.meta.dirname, '../../..');
const text = readFileSync(path.join(root, 'apps/web/public/security.txt'), 'utf8');

function fields(source: string): [string, string][] {
  return source
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    });
}

describe('security.txt', () => {
  const entries = fields(text);
  const values = (name: string) => entries.filter(([key]) => key === name).map(([, value]) => value);

  it('has only known fields, each a "Name: value" line', () => {
    const known = [
      'Contact',
      'Expires',
      'Preferred-Languages',
      'Policy',
      'Canonical',
      'Encryption',
      'Acknowledgments',
      'Hiring',
    ];
    for (const [key, value] of entries) {
      expect(known).toContain(key);
      expect(value).not.toBe('');
    }
  });

  it('gives at least one contact URI and exactly one Expires', () => {
    expect(values('Contact').length).toBeGreaterThan(0);
    for (const contact of values('Contact')) expect(contact).toMatch(/^(https:\/\/|mailto:|tel:)/);
    expect(values('Expires')).toHaveLength(1);
  });

  it('expires more than 30 days from now and at most a year ahead of its last renewal', () => {
    const expires = new Date(values('Expires')[0] ?? '');
    expect(Number.isNaN(expires.getTime())).toBe(false);
    expect(expires.getTime() - Date.now()).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
    expect(expires.getTime() - Date.now()).toBeLessThan(400 * 24 * 60 * 60 * 1000);
  });

  it('points its policy at the published SECURITY.md', () => {
    expect(values('Policy')).toEqual(['https://materia-v2-prod.web.app/SECURITY.md']);
    const project = JSON.parse(readFileSync(path.join(root, 'apps/web/project.json'), 'utf8')) as {
      targets: { build: { options: { assets: ({ glob: string; input: string } | string)[] } } };
    };
    expect(project.targets.build.options.assets).toContainEqual({ glob: 'SECURITY.md', input: '.' });
  });

  it('is served at /.well-known/security.txt, ahead of the app fallback', () => {
    const rewrites = (
      readFirebaseConfig() as unknown as { hosting: { rewrites: { source: string; destination?: string }[] } }
    ).hosting.rewrites;
    const wellKnown = rewrites.findIndex((r) => r.source === '/.well-known/security.txt');
    expect(rewrites[wellKnown]?.destination).toBe('/security.txt');
    expect(wellKnown).toBeLessThan(rewrites.findIndex((r) => r.source === '**'));
  });
});
