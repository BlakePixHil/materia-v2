import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hostingPolicy, parsePolicy, readFirebaseConfig } from './csp.ts';

// FND-07: the inline theme boot script in apps/web/src/index.html needs a CSP hash. FND-22 puts
// every recorded hash in script-src (firebase.json). This test fails when the script changes
// without its recorded hash, or a recorded hash is missing from the policy.
const root = path.resolve(import.meta.dirname, '../../..');
const html = readFileSync(path.join(root, 'apps/web/src/index.html'), 'utf8');
const recorded = JSON.parse(readFileSync(path.join(root, 'apps/web/csp-hashes.json'), 'utf8')) as {
  scripts: Record<string, string>;
  build: Record<string, string>;
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

  it('allows every recorded hash, and only those, in the Hosting script-src', () => {
    const scriptSrc = parsePolicy(hostingPolicy(readFirebaseConfig())).get('script-src') ?? [];
    const hashes = scriptSrc.filter((source) => source.startsWith("'sha256-"));
    const expected = [...Object.values(recorded.scripts), ...Object.values(recorded.build)].map((h) => `'${h}'`);
    expect(hashes.sort()).toEqual(expected.sort());
  });
});
