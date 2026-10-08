import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Under tsx, the bin loads workspace libs as CommonJS, and Node can't see their re-exported names
 * from an ES module: `import { walkCollectionIds } from '@materia/domain'` passes the unit tests
 * (vitest loads the TypeScript source) but fails when the command runs. Scripts import a lib as a
 * namespace and `unwrap` it (interop.ts); type-only imports are fine.
 */
const src = path.resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [file] : [];
  });
}

describe('workspace lib imports', () => {
  it('imports workspace libs as a namespace, never by name, so the bin can load them', () => {
    const named = sources(src).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)\{[^}]*\}\s+from\s+'(@materia\/[^']+)'/gm)].map(
        (match) => `${path.relative(src, file)}: ${match[1]}`,
      ),
    );
    expect(named).toEqual([]);
  });
});
