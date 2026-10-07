import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { analyseBundle, initialFilesFromHtml, main } from './bundle-size.ts';

function randomish(bytes: number): string {
  // Random-looking content barely compresses, so its gzip size stays close to its raw size.
  let text = '';
  let seed = 7;
  while (text.length < bytes) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    text += seed.toString(36);
  }
  return text;
}

function fixtureDist(lazyChunkBytes: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'materia-bundle-'));
  writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head><link rel="stylesheet" href="styles-A.css"><link rel="modulepreload" href="chunk-shared.js"></head>' +
      '<body><script src="main-B.js" type="module"></script></body></html>',
  );
  writeFileSync(path.join(dir, 'main-B.js'), 'console.log("main");'.repeat(50));
  writeFileSync(path.join(dir, 'chunk-shared.js'), 'export const shared = 1;');
  writeFileSync(path.join(dir, 'styles-A.css'), 'body { margin: 0; }');
  writeFileSync(path.join(dir, 'chunk-lazy.js'), randomish(lazyChunkBytes));
  return dir;
}

describe('bundle-size', () => {
  it('finds the initial files in index.html', () => {
    const html =
      '<link href="a.css" rel="stylesheet"><script src="https://cdn.example/x.js"></script><script src="m.js"></script>';
    expect(initialFilesFromHtml(html).sort()).toEqual(['a.css', 'm.js']);
  });

  it('separates initial files from lazy chunks and passes small bundles', () => {
    const report = analyseBundle(fixtureDist(1000));
    expect(report.initial.map((f) => f.file).sort()).toEqual(['chunk-shared.js', 'main-B.js', 'styles-A.css']);
    expect(report.lazy.map((f) => f.file)).toEqual(['chunk-lazy.js']);
    expect(report.violations).toEqual([]);
  });

  it('flags a lazy chunk over 150 kB gzip and fails the command', async () => {
    const dist = fixtureDist(400_000);
    expect(analyseBundle(dist).violations[0]).toMatch(/lazy chunk chunk-lazy\.js is .* \(budget 150 kB\)/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main(['--dist', dist])).rejects.toThrow('Bundle budget exceeded');
    log.mockRestore();
  });

  it('holds PDF.js to its own budget and leaves it out of the largest lazy chunk', () => {
    const dist = fixtureDist(1000);
    writeFileSync(path.join(dist, 'chunk-pdf.js'), `globalThis.pdfjsLib={};${randomish(240_000)}`);
    const report = analyseBundle(dist);
    expect(report.pdfJsGzipBytes).toBeGreaterThan(150_000);
    expect(report.largestLazyGzipBytes).toBeLessThan(2000);
    expect(report.violations).toEqual([]);

    writeFileSync(path.join(dist, 'chunk-pdf.js'), `globalThis.pdfjsLib={};${randomish(300_000)}`);
    expect(analyseBundle(dist).violations).toEqual([
      expect.stringMatching(/^PDF\.js chunk chunk-pdf\.js is .* \(budget 170 kB\)$/),
    ]);
  });

  it('fails a bundle that still carries the development-only reads counter', () => {
    const dist = fixtureDist(1000);
    writeFileSync(path.join(dist, 'chunk-dev.js'), 'globalThis.__materiaReads = {};');
    expect(analyseBundle(dist).violations).toEqual([
      'chunk-dev.js contains the development-only __materiaReads (build it with the production define)',
    ]);
  });
});
