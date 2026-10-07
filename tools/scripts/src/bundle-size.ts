/**
 * `materia-scripts bundle-size [--dist dist/apps/web/browser] [--json out.json]`
 * Gzip bundle budgets for apps/web (Testing & quality strategy, FND-04): initial JS + CSS
 * ≤ 300 kB gzip, and every lazy chunk ≤ 150 kB gzip except PDF.js's library, ≤ 170 kB (ADR-028).
 * Exits 1 when a budget is exceeded, or when a development-only hook (the SEC-07 Firestore reads
 * counter) is in the bundle: production builds define `MATERIA_READS_COUNTER` false, so the bundler
 * must drop it.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

export const BUDGETS = { initialKb: 300, lazyChunkKb: 150, pdfJsChunkKb: 170 } as const;

/**
 * How PDF.js's library chunk is recognised: the build publishes every export as
 * `globalThis.pdfjsLib`, a name that survives minification and that no other chunk has.
 */
export const PDFJS_MARKER = 'pdfjsLib';

/** Strings only development and e2e builds may contain (libs/data-access read-counter.ts). */
export const DEV_ONLY_MARKERS = ['__materiaReads'] as const;

export interface BundleFile {
  file: string;
  gzipBytes: number;
}

export interface BundleReport {
  initial: BundleFile[];
  lazy: BundleFile[];
  initialGzipBytes: number;
  /** The largest lazy chunk other than PDF.js's library. */
  largestLazyGzipBytes: number;
  /** PDF.js's library chunk, or 0 when the build has none. */
  pdfJsGzipBytes: number;
  violations: string[];
}

const KB = 1000;

/** The files the browser loads up front: scripts, module preloads and stylesheets in index.html. */
export function initialFilesFromHtml(html: string): string[] {
  const files = new Set<string>();
  for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) files.add(match[1] ?? '');
  for (const match of html.matchAll(/<link[^>]*rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g)) {
    files.add(match[1] ?? '');
  }
  for (const match of html.matchAll(/<link[^>]*href="([^"]+)"[^>]*rel="(?:modulepreload|stylesheet)"/g)) {
    files.add(match[1] ?? '');
  }
  return [...files].filter((file) => file && !/^https?:/.test(file));
}

function gzipBytes(file: string): number {
  return gzipSync(readFileSync(file), { level: 9 }).length;
}

export function analyseBundle(distDir: string): BundleReport {
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const initialNames = new Set(initialFilesFromHtml(html));
  const all = readdirSync(distDir).filter((file) => /\.(js|css)$/.test(file));

  const initial = all
    .filter((f) => initialNames.has(f))
    .map((file) => ({ file, gzipBytes: gzipBytes(path.join(distDir, file)) }));
  const lazy = all
    .filter((f) => !initialNames.has(f) && f.endsWith('.js'))
    .map((file) => ({ file, gzipBytes: gzipBytes(path.join(distDir, file)) }));

  const source = (file: BundleFile): string => readFileSync(path.join(distDir, file.file), 'utf8');
  const pdfJs = lazy.find((f) => source(f).includes(PDFJS_MARKER));
  const others = lazy.filter((f) => f !== pdfJs);

  const initialGzipBytes = initial.reduce((sum, f) => sum + f.gzipBytes, 0);
  const largestLazyGzipBytes = Math.max(0, ...others.map((f) => f.gzipBytes));
  const pdfJsGzipBytes = pdfJs?.gzipBytes ?? 0;
  const violations: string[] = [];
  if (initialGzipBytes > BUDGETS.initialKb * KB) {
    violations.push(`initial bundle is ${formatKb(initialGzipBytes)} gzip (budget ${BUDGETS.initialKb} kB)`);
  }
  for (const file of [...initial, ...lazy].filter((f) => f.file.endsWith('.js'))) {
    const text = source(file);
    for (const marker of DEV_ONLY_MARKERS.filter((m) => text.includes(m))) {
      violations.push(`${file.file} contains the development-only ${marker} (build it with the production define)`);
    }
  }
  for (const chunk of others) {
    if (chunk.gzipBytes > BUDGETS.lazyChunkKb * KB) {
      violations.push(
        `lazy chunk ${chunk.file} is ${formatKb(chunk.gzipBytes)} gzip (budget ${BUDGETS.lazyChunkKb} kB)`,
      );
    }
  }
  if (pdfJs && pdfJs.gzipBytes > BUDGETS.pdfJsChunkKb * KB) {
    violations.push(
      `PDF.js chunk ${pdfJs.file} is ${formatKb(pdfJs.gzipBytes)} gzip (budget ${BUDGETS.pdfJsChunkKb} kB)`,
    );
  }
  return { initial, lazy, initialGzipBytes, largestLazyGzipBytes, pdfJsGzipBytes, violations };
}

export function formatKb(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} kB`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { dist: { type: 'string', default: 'dist/apps/web/browser' }, json: { type: 'string' } },
  });
  const report = analyseBundle(values.dist);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2));
  console.log(
    `initial ${formatKb(report.initialGzipBytes)} gzip (budget ${BUDGETS.initialKb} kB), ` +
      `largest lazy chunk ${formatKb(report.largestLazyGzipBytes)} (budget ${BUDGETS.lazyChunkKb} kB), ` +
      `PDF.js ${formatKb(report.pdfJsGzipBytes)} (budget ${BUDGETS.pdfJsChunkKb} kB)`,
  );
  if (report.violations.length) throw new Error(`Bundle budget exceeded:\n- ${report.violations.join('\n- ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
