import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// FND-07: the inline theme boot script in apps/web/src/index.html needs a CSP hash (FND-22 builds
// the policy). This test fails when the script changes without its recorded hash.
const root = path.resolve(import.meta.dirname, '../../..');
const html = readFileSync(path.join(root, 'apps/web/src/index.html'), 'utf8');
const recorded = JSON.parse(readFileSync(path.join(root, 'apps/web/csp-hashes.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function inlineScriptHashes(source: string): string[] {
  return [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) =>
      `sha256-${createHash('sha256')
        .update(match[1] ?? '')
        .digest('base64')}`,
  );
}

describe('CSP hashes for inline scripts', () => {
  it('records the hash of every inline script in index.html', () => {
    expect(inlineScriptHashes(html).sort()).toEqual(Object.values(recorded.scripts).sort());
  });
});
