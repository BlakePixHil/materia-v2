import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SourceMapGenerator } from 'source-map-js';

import { decodeStack, dirLoader } from './decode-stack.ts';

function fixtureMaps(): string {
  const generator = new SourceMapGenerator({ file: 'chunk-ABC.js' });
  generator.addMapping({
    generated: { line: 1, column: 204 },
    original: { line: 42, column: 6 },
    source: 'apps/web/src/app/pages/matter-layout.ts',
    name: 'openMatter',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'maps-'));
  writeFileSync(path.join(dir, 'chunk-ABC.js.map'), generator.toString());
  return dir;
}

describe('decode-stack', () => {
  it('maps V8 and Firefox frames to the original source and keeps other lines', () => {
    const load = dirLoader(fixtureMaps());
    const stack = [
      'TypeError: Cannot read properties of undefined (reading [quoted])',
      '    at Kx (https://materia-v2-dev.web.app/chunk-ABC.js:1:205)',
      '    at https://materia-v2-dev.web.app/chunk-ABC.js:1:205',
      'Kx@https://materia-v2-dev.web.app/chunk-ABC.js:1:205',
      '    at y (https://materia-v2-dev.web.app/main-XYZ.js:1:10)',
      '    at z (https://materia-v2-dev.web.app/chunk-ABC.js:9:1)',
    ].join('\n');
    expect(decodeStack(stack, load).split('\n')).toEqual([
      'TypeError: Cannot read properties of undefined (reading [quoted])',
      '    at openMatter (apps/web/src/app/pages/matter-layout.ts:42:7)',
      '    at openMatter (apps/web/src/app/pages/matter-layout.ts:42:7)',
      'at openMatter (apps/web/src/app/pages/matter-layout.ts:42:7)',
      '    at y (https://materia-v2-dev.web.app/main-XYZ.js:1:10)   [no sourcemap for main-XYZ.js]',
      '    at z (https://materia-v2-dev.web.app/chunk-ABC.js:9:1)   [not mapped]',
    ]);
  });
});
