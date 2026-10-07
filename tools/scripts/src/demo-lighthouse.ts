/**
 * `materia-scripts demo-lighthouse --project <id> [--path /today] [--runs 5] [--account owner]
 *   [--url <origin>] [--dry-run]`
 *
 * Mobile Lighthouse on a signed-in page (MOB-02b): signs in to the demo practice (`demo-reset`) in
 * a headless Chrome, then runs Lighthouse's mobile preset (simulated throttling, 4× CPU) on the page
 * `--runs` times in that browser. Storage is kept between runs, as for a person who's signed in, so
 * each run is a repeat visit: the service worker, the Firestore cache and the session are there.
 * Prints each run, the median run's metrics and where its main thread went, and writes the reports
 * and a summary to dist/lighthouse (the `dev-script` workflow uploads them; on GitHub the summary
 * also goes to the job summary).
 *
 * - On dev (through the `dev-script` workflow) the password is the `demo-login-password` secret,
 *   never printed. `--url` measures a Hosting preview channel of dev instead of the live site
 *   (`https://materia-v2-dev--<channel>.web.app`, from the PR's preview comment).
 * - In the emulators, after `demo-reset --project demo-…`, `--url` is the Hosting emulator
 *   (default http://127.0.0.1:5000) and the password is the seed's.
 * - `--account` is owner (the default), lawyer, paralegal or readonly.
 * - `--dry-run` signs in, opens the page once and stops, without Lighthouse.
 *
 * Chrome is PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when set, else the installed Chrome (GitHub's
 * runners have one). Lighthouse runs with npx at a pinned version. Never prod: resolveDemoTarget
 * refuses any project but dev and the emulators'.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

import type { Page } from '@playwright/test';

import { DEMO_APP_URL, DEMO_EMAILS, type DemoTarget, demoPassword, resolveDemoTarget } from './demo-reset.ts';

const run = promisify(execFile);

/** The Lighthouse the local measurements used (MOB-02b); pinned so runs compare. */
export const LIGHTHOUSE = 'lighthouse@13.5.0';
const OUT_DIR = path.resolve(import.meta.dirname, '../../../dist/lighthouse');
const DEBUG_PORT = 9333;

/** The demo account behind each `--account`. */
export const DEMO_ACCOUNTS: Readonly<Record<string, string>> = {
  owner: 'user-priya',
  lawyer: 'user-jordan',
  paralegal: 'user-daniel',
  readonly: 'user-sam',
};

export interface LighthouseArgs {
  project: string | undefined;
  path: string;
  runs: number;
  account: string;
  url: string | undefined;
  dryRun: boolean;
}

export function parseLighthouseArgs(argv: string[]): LighthouseArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      path: { type: 'string', default: '/today' },
      runs: { type: 'string', default: '5' },
      account: { type: 'string', default: 'owner' },
      url: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 15) throw new Error('--runs is a whole number from 1 to 15.');
  if (!/^\/[\w\-/]*$/.test(values.path))
    throw new Error(`--path is an app path such as /today (got "${values.path}").`);
  if (!Object.hasOwn(DEMO_ACCOUNTS, values.account))
    throw new Error(`--account is one of ${Object.keys(DEMO_ACCOUNTS).join(', ')}.`);
  return {
    project: values.project ?? process.env['GCLOUD_PROJECT'],
    path: values.path,
    runs,
    account: values.account,
    url: values.url,
    dryRun: values['dry-run'],
  };
}

/**
 * The site to measure: dev's live site or one of its preview channels, or the Hosting emulator.
 * Anything else is refused, so the demo password only ever goes to the demo's own app.
 */
export function siteOrigin(target: DemoTarget, url: string | undefined): string {
  if (target.kind === 'emulator') {
    const origin = new URL(url ?? 'http://127.0.0.1:5000').origin;
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
      throw new Error(`In the emulators --url is the local Hosting emulator (got ${origin}).`);
    return origin;
  }
  if (!url) return DEMO_APP_URL;
  const origin = new URL(url).origin;
  const site = target.projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^https://${site}(--[a-z0-9-]+)?\\.web\\.app$`).test(origin))
    throw new Error(`--url is ${DEMO_APP_URL} or one of its preview channels (got ${origin}).`);
  return origin;
}

// ---------- reading a Lighthouse report ----------

interface Audit {
  score?: number | null;
  numericValue?: number;
  displayValue?: string;
  details?: { items?: Record<string, unknown>[] };
}

export interface Lhr {
  finalDisplayedUrl?: string;
  categories: { performance?: { score: number | null } };
  audits: Record<string, Audit | undefined>;
  environment?: { benchmarkIndex?: number };
  runtimeError?: { code?: string; message?: string };
  runWarnings?: string[];
}

export interface RunRow {
  run: number;
  score: number;
  fcp: number;
  lcp: number;
  tbt: number;
  si: number;
  cls: number;
  benchmark: number;
  error: string | undefined;
}

const ms = (lhr: Lhr, id: string) => Math.round(lhr.audits[id]?.numericValue ?? Number.NaN);

export function runRow(run: number, lhr: Lhr): RunRow {
  return {
    run,
    score: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    fcp: ms(lhr, 'first-contentful-paint'),
    lcp: ms(lhr, 'largest-contentful-paint'),
    tbt: ms(lhr, 'total-blocking-time'),
    si: ms(lhr, 'speed-index'),
    cls: Number((lhr.audits['cumulative-layout-shift']?.numericValue ?? Number.NaN).toFixed(3)),
    benchmark: Math.round(lhr.environment?.benchmarkIndex ?? Number.NaN),
    error: lhr.runtimeError?.code,
  };
}

/** The median run by score (ties: the lower blocking time), from the runs without an error. */
export function medianRun(rows: RunRow[]): RunRow | undefined {
  const sorted = rows.filter((row) => !row.error).sort((a, b) => a.score - b.score || b.tbt - a.tbt);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text);
  if (value && typeof value === 'object' && 'url' in value) return String((value as { url: unknown }).url);
  return value === undefined || value === null ? '' : String(value);
};
const num = (value: unknown) => (typeof value === 'number' ? Math.round(value) : Number.NaN);
const short = (url: string) => (url.length > 90 ? `${url.slice(0, 60)}…${url.slice(-28)}` : url);

/** The table rows of an audit's details, mapped to cells, largest first. */
function top(lhr: Lhr, id: string, cells: (item: Record<string, unknown>) => (string | number)[], n: number) {
  return (lhr.audits[id]?.details?.items ?? []).slice(0, n).map((item) => `| ${cells(item).join(' | ')} |`);
}

/** The summary, in Markdown: every run, then the median run's metrics and where its main thread went. */
export function summary(rows: RunRow[], median: Lhr | undefined, heading: string): string {
  const lines = [
    `## ${heading}`,
    '',
    '| Run | Score | FCP | LCP | TBT | SI | CLS | Benchmark | Error |',
    '| -- | -- | -- | -- | -- | -- | -- | -- | -- |',
    ...rows.map(
      (r) =>
        `| ${r.run} | ${r.score} | ${r.fcp} ms | ${r.lcp} ms | ${r.tbt} ms | ${r.si} ms | ${r.cls} | ${r.benchmark} | ${r.error ?? ''} |`,
    ),
  ];
  const mid = medianRun(rows);
  if (!mid || !median) return [...lines, '', 'No run finished without an error.'].join('\n');
  lines.push(
    '',
    `**Median: ${mid.score}** (run ${mid.run}): FCP ${mid.fcp} ms, LCP ${mid.lcp} ms, TBT ${mid.tbt} ms, SI ${mid.si} ms, CLS ${mid.cls}.`,
  );
  const lcpElement = median.audits['largest-contentful-paint-element']?.details?.items?.[0];
  const lcpNode = (lcpElement?.['items'] as { node?: { snippet?: string } }[] | undefined)?.[0]?.node?.snippet;
  if (lcpNode) lines.push('', `LCP element: \`${lcpNode.slice(0, 160)}\``);
  const sections: [string, string, string[]][] = [
    [
      'Main thread by category',
      '| Category | Time |\n| -- | -- |',
      top(median, 'mainthread-work-breakdown', (i) => [text(i['groupLabel']), `${num(i['duration'])} ms`], 8),
    ],
    [
      'JavaScript by script',
      '| Script | Total | Scripting | Parse and compile |\n| -- | -- | -- | -- |',
      top(
        median,
        'bootup-time',
        (i) => [
          short(text(i['url'])),
          `${num(i['total'])} ms`,
          `${num(i['scripting'])} ms`,
          `${num(i['scriptParseCompile'])} ms`,
        ],
        10,
      ),
    ],
    [
      'Third parties',
      '| Entity | Main thread | Blocking | Transfer |\n| -- | -- | -- | -- |',
      top(
        median,
        'third-party-summary',
        (i) => [
          text(i['entity']),
          `${num(i['mainThreadTime'])} ms`,
          `${num(i['blockingTime'])} ms`,
          `${Math.round(num(i['transferSize']) / 1024)} kB`,
        ],
        6,
      ),
    ],
    [
      'Long tasks',
      '| Script | Start | Duration |\n| -- | -- | -- |',
      top(
        median,
        'long-tasks',
        (i) => [short(text(i['url'])), `${num(i['startTime'])} ms`, `${num(i['duration'])} ms`],
        12,
      ),
    ],
  ];
  for (const [title, head, rowsOf] of sections) if (rowsOf.length) lines.push('', `### ${title}`, '', head, ...rowsOf);
  if (median.runWarnings?.length)
    lines.push('', '### Lighthouse warnings', '', ...median.runWarnings.map((w) => `- ${w}`));
  return lines.join('\n');
}

// ---------- the browser ----------

export async function signIn(page: Page, origin: string, email: string, password: string): Promise<void> {
  await page.goto(`${origin}/auth/sign-in`);
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/today$/, { timeout: 60_000 });
}

/** A first sign-in can open the welcome tour (CORE-24): skip it, so the runs measure the page. */
export async function skipTour(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: /^Skip/ });
  await skip
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => skip.click())
    .catch(() => undefined);
}

const log = (line: string) => console.log(line);

export async function main(argv: string[] = []): Promise<void> {
  const args = parseLighthouseArgs(argv);
  const target = resolveDemoTarget(args.project, process.env);
  if (target.kind === 'dev') process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] = target.projectId;
  const origin = siteOrigin(target, args.url);
  const uid = DEMO_ACCOUNTS[args.account] as string;
  const email = DEMO_EMAILS[uid] as string;
  const pageUrl = `${origin}${args.path}`;
  const password = await demoPassword(target);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = path.join(tmpdir(), `demo-lighthouse-${process.pid}`);
  const { chromium } = await import('@playwright/test');
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: [`--remote-debugging-port=${DEBUG_PORT}`],
    viewport: { width: 412, height: 823 },
    timezoneId: 'Australia/Melbourne',
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    log(`Signing in to ${origin} as the demo ${args.account} (${email}).`);
    try {
      await signIn(page, origin, email, password);
    } catch (err) {
      await page.screenshot({ path: path.join(OUT_DIR, 'sign-in-failed.png') }).catch(() => undefined);
      throw new Error(`Sign-in failed at ${page.url()}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await skipTour(page);
    // One visit first, so the runs find what a returning person's browser has (and the tour seen).
    await page.goto(pageUrl);
    await page.waitForTimeout(5_000);
    await skipTour(page);
    await page.screenshot({ path: path.join(OUT_DIR, 'warm-up.png') });
    await page.goto('about:blank');
    if (args.dryRun) {
      log(`Dry run: signed in and opened ${pageUrl}; Lighthouse would run ${args.runs} times.`);
      return;
    }

    const rows: RunRow[] = [];
    const reports: Lhr[] = [];
    for (let i = 1; i <= args.runs; i++) {
      const base = path.join(OUT_DIR, `run-${i}`);
      await run(
        'npx',
        [
          '--yes',
          LIGHTHOUSE,
          pageUrl,
          `--port=${DEBUG_PORT}`,
          '--disable-storage-reset',
          '--only-categories=performance',
          '--output=json',
          '--output=html',
          `--output-path=${base}`,
          '--max-wait-for-load=60000',
          '--quiet',
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const lhr = JSON.parse(readFileSync(`${base}.report.json`, 'utf8')) as Lhr;
      reports.push(lhr);
      const row = runRow(i, lhr);
      rows.push(row);
      log(JSON.stringify(row));
    }
    const mid = medianRun(rows);
    const heading = `Mobile Lighthouse: ${args.path} on ${origin} (${args.runs} runs, signed in as the demo ${args.account})`;
    const report = summary(rows, mid ? reports[mid.run - 1] : undefined, heading);
    writeFileSync(path.join(OUT_DIR, 'summary.md'), `${report}\n`);
    if (mid) log(`Median report: dist/lighthouse/run-${mid.run}.report.html`);
    log(report);
    const jobSummary = process.env['GITHUB_STEP_SUMMARY'];
    if (jobSummary) appendFileSync(jobSummary, `${report}\n`);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
