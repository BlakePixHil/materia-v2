import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BundleReport } from './bundle-size.ts';
import { main, MARKER, readCoverage, renderSummary } from './ci-summary.ts';

function coverageDir(pct: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'materia-cov-'));
  mkdirSync(path.join(dir, 'libs/domain'), { recursive: true });
  const metric = { pct };
  writeFileSync(
    path.join(dir, 'libs/domain/coverage-summary.json'),
    JSON.stringify({ total: { lines: metric, statements: metric, functions: metric, branches: metric } }),
  );
  return dir;
}

const bundle = (initial: number): BundleReport => ({
  initial: [],
  lazy: [],
  initialGzipBytes: initial,
  largestLazyGzipBytes: 300,
  violations: [],
});

describe('ci-summary', () => {
  it('reads coverage summaries by project path', () => {
    expect(readCoverage(coverageDir(91))).toEqual({
      'libs/domain': { lines: 91, statements: 91, functions: 91, branches: 91 },
    });
    expect(readCoverage('/no/such/dir')).toEqual({});
  });

  it('renders coverage and bundle deltas against the main baseline', () => {
    const md = renderSummary({
      coverage: readCoverage(coverageDir(92.5)),
      baseCoverage: readCoverage(coverageDir(90)),
      bundle: bundle(60_000),
      baseBundle: bundle(58_000),
    });
    expect(md.startsWith(MARKER)).toBe(true);
    expect(md).toContain('| `libs/domain` | 92.5% (+2.5 pp) |');
    expect(md).toContain('| Initial | 60.0 kB (+2.0 kB) | 300 kB |');
    expect(md).not.toContain('No main baseline');
  });

  it('says when there is nothing to compare', () => {
    const md = renderSummary({ coverage: {} });
    expect(md).toContain('no affected projects with tests');
    expect(md).toContain('`apps/web` not affected');
    expect(md).toContain('No main baseline available yet');
  });

  it('writes the summary file', async () => {
    const dir = coverageDir(80);
    const out = path.join(dir, 'summary.md');
    const bundleFile = path.join(dir, 'bundle.json');
    writeFileSync(bundleFile, JSON.stringify({ ...bundle(400_000), violations: ['initial bundle is 400.0 kB gzip'] }));
    await main(['--coverage', dir, '--base-coverage', dir, '--bundle', bundleFile, '--out', out]);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('80.0% (±0)');
    expect(md).toContain('⚠️ initial bundle is 400.0 kB gzip');
  });
});
