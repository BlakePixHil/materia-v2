/**
 * `materia-scripts ci-summary --coverage coverage [--base-coverage base/coverage]
 *   [--bundle bundle.json] [--base-bundle base/bundle.json] [--out summary.md]`
 * Builds the PR comment (FND-04): coverage per project and bundle sizes, with deltas against the
 * latest main run when its artefacts are available.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { formatKb, type BundleReport } from './bundle-size.ts';

export const MARKER = '<!-- materia-ci-summary -->';
const METRICS = ['lines', 'statements', 'functions', 'branches'] as const;
type Metric = (typeof METRICS)[number];
export type CoverageByProject = Record<string, Record<Metric, number>>;

/** Collects every coverage-summary.json under `dir`, keyed by its path relative to `dir`. */
export function readCoverage(dir: string): CoverageByProject {
  const result: CoverageByProject = {};
  if (!existsSync(dir)) return result;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'coverage-summary.json') {
        const total = (JSON.parse(readFileSync(full, 'utf8')) as { total: Record<Metric, { pct: number }> }).total;
        const project = path.relative(dir, current) || '.';
        result[project] = Object.fromEntries(METRICS.map((m) => [m, total[m].pct])) as Record<Metric, number>;
      }
    }
  };
  walk(dir);
  return result;
}

function delta(current: number, base: number | undefined, unit: string, decimals = 1): string {
  if (base === undefined) return '';
  const diff = current - base;
  if (Math.abs(diff) < 10 ** -decimals / 2) return ' (±0)';
  return ` (${diff > 0 ? '+' : ''}${diff.toFixed(decimals)}${unit})`;
}

export function renderSummary(input: {
  coverage: CoverageByProject;
  baseCoverage?: CoverageByProject;
  bundle?: BundleReport;
  baseBundle?: BundleReport;
}): string {
  const lines = [MARKER, '### CI summary', ''];
  const projects = Object.keys(input.coverage).sort();
  if (projects.length) {
    lines.push(
      '**Coverage** (affected projects)',
      '',
      '| Project | Lines | Statements | Functions | Branches |',
      '| -- | -- | -- | -- | -- |',
    );
    for (const project of projects) {
      const cur = input.coverage[project] as Record<Metric, number>;
      const base = input.baseCoverage?.[project];
      const cells = METRICS.map((m) => `${cur[m].toFixed(1)}%${delta(cur[m], base?.[m], ' pp')}`);
      lines.push(`| \`${project}\` | ${cells.join(' | ')} |`);
    }
  } else {
    lines.push('**Coverage:** no affected projects with tests.');
  }
  lines.push('');
  if (input.bundle) {
    const b = input.bundle;
    const kb = (bytes: number): number => bytes / 1000;
    lines.push(
      '**Bundle** (`apps/web`, gzip)',
      '',
      '| Measure | Size | Budget |',
      '| -- | -- | -- |',
      `| Initial | ${formatKb(b.initialGzipBytes)}${delta(kb(b.initialGzipBytes), input.baseBundle && kb(input.baseBundle.initialGzipBytes), ' kB')} | 300 kB |`,
      `| Largest lazy chunk | ${formatKb(b.largestLazyGzipBytes)}${delta(kb(b.largestLazyGzipBytes), input.baseBundle && kb(input.baseBundle.largestLazyGzipBytes), ' kB')} | 150 kB |`,
      '',
    );
    if (b.violations.length) lines.push(`⚠️ ${b.violations.join('; ')}`, '');
  } else {
    lines.push('**Bundle:** `apps/web` not affected.', '');
  }
  if (!input.baseCoverage && !input.baseBundle) lines.push('_No main baseline available yet, so no deltas._');
  return lines.join('\n') + '\n';
}

function readJson<T>(file: string | undefined): T | undefined {
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      coverage: { type: 'string', default: 'coverage' },
      'base-coverage': { type: 'string' },
      bundle: { type: 'string' },
      'base-bundle': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const baseCoverage = values['base-coverage'] ? readCoverage(values['base-coverage']) : undefined;
  const bundle = readJson<BundleReport>(values.bundle);
  const baseBundle = readJson<BundleReport>(values['base-bundle']);
  const markdown = renderSummary({
    coverage: readCoverage(values.coverage),
    ...(baseCoverage && Object.keys(baseCoverage).length ? { baseCoverage } : {}),
    ...(bundle ? { bundle } : {}),
    ...(baseBundle ? { baseBundle } : {}),
  });
  if (values.out) writeFileSync(values.out, markdown);
  else console.log(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
