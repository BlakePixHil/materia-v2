/**
 * `materia-scripts demo-phone-check --project <id> [--paths /inbox,/settings/preferences]
 *   [--account owner] [--url <origin>] [--dry-run]`
 *
 * Checks pages of dev on a phone, signed in to the demo practice: opens each page in a headless
 * Chrome sized as an iPhone 13 and reports what a person would see broken there (Blake's phone
 * feedback, #306):
 *
 * - content under the sticky top bar when the page opens;
 * - a page wider than the screen;
 * - a switch not drawn at phone size: a 44px target whose clear border shows a 30–32px track, the
 *   thumb inside it and the label level with it, whether on or off.
 *
 * Prints a table (and adds it to the job summary on GitHub), saves a screenshot of each page to
 * dist/phone-check (the `dev-script` workflow uploads them) and fails when any page fails a check.
 * `--dry-run` checks the first page only. The sign-in, the targets and the password are
 * `demo-lighthouse`'s: dev's live site or a preview channel of it, or the Hosting emulator; never prod.
 */
/// <reference lib="dom" />
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { DEMO_ACCOUNTS, signIn, siteOrigin, skipTour } from './demo-lighthouse.ts';
import { DEMO_EMAILS, demoPassword, resolveDemoTarget } from './demo-reset.ts';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../dist/phone-check');
const DEFAULT_PATHS = ['/inbox', '/settings/preferences'];

export interface PhoneCheckArgs {
  project: string | undefined;
  paths: string[];
  account: string;
  url: string | undefined;
  dryRun: boolean;
}

export function parsePhoneCheckArgs(argv: string[]): PhoneCheckArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      paths: { type: 'string', default: DEFAULT_PATHS.join(',') },
      account: { type: 'string', default: 'owner' },
      url: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const paths = values.paths
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length) throw new Error('--paths lists at least one app path, such as /inbox.');
  for (const p of paths)
    if (!/^\/[\w\-/]*$/.test(p)) throw new Error(`--paths are app paths such as /inbox (got "${p}").`);
  if (!Object.hasOwn(DEMO_ACCOUNTS, values.account))
    throw new Error(`--account is one of ${Object.keys(DEMO_ACCOUNTS).join(', ')}.`);
  return {
    project: values.project ?? process.env['GCLOUD_PROJECT'],
    paths,
    account: values.account,
    url: values.url,
    dryRun: values['dry-run'],
  };
}

/** One switch as drawn: its target, the track inside its clear border, its thumb and its label. */
export interface SwitchShape {
  label: string;
  checked: boolean;
  target: number;
  track: number;
  clip: string;
  thumbInTrack: boolean;
  /** How far the visible label's middle sits from the track's; null when the label is for screen readers only. */
  labelOffCentre: number | null;
}

/** What a page looks like on the phone when it opens. */
export interface PhonePage {
  path: string;
  /** Visible elements of the page that start under the sticky top bar. */
  underTopBar: string[];
  /** How many pixels wider than the screen the page is. */
  overflowX: number;
  switches: SwitchShape[];
}

/**
 * Runs in the page: measures the top bar, the page and every switch. Self-contained, because
 * Playwright sends it to the browser as source.
 */
export function measurePhonePage(pagePath: string): PhonePage {
  const bar = document.querySelector('.mt-topbar')?.getBoundingClientRect();
  const underTopBar: string[] = [];
  if (bar) {
    for (const el of document.querySelectorAll<HTMLElement>('.mt-page *')) {
      // The pull-to-refresh hint waits, hidden, under the bar; screen-reader text is 1px.
      if (el.closest('.mt-ptr, .mt-sr')) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.visibility === 'hidden' || style.display === 'contents') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.top < bar.bottom - 0.5 && rect.bottom > bar.top) {
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
        underTopBar.push(`${el.tagName.toLowerCase()}${cls} at ${Math.round(rect.top)}px`);
      }
    }
  }
  const switches = [...document.querySelectorAll<HTMLElement>('.mt-switch')]
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const top = box.top + parseFloat(style.borderTopWidth);
      const bottom = box.bottom - parseFloat(style.borderBottomWidth);
      const thumb = el.querySelector('.mt-switch-thumb')?.getBoundingClientRect();
      const labelEl = document.getElementById(el.getAttribute('aria-labelledby') ?? '');
      const label = labelEl?.getBoundingClientRect();
      return {
        label: (labelEl?.textContent ?? '').trim().slice(0, 40),
        checked: el.getAttribute('aria-checked') === 'true',
        target: Math.round(box.height),
        track: Math.round(bottom - top),
        clip: style.backgroundClip,
        thumbInTrack: !!thumb && thumb.top >= top - 0.5 && thumb.bottom <= bottom + 0.5,
        labelOffCentre:
          label && label.height >= 2
            ? Math.round(Math.abs((label.top + label.bottom) / 2 - (top + bottom) / 2) * 10) / 10
            : null,
      };
    });
  return {
    path: pagePath,
    underTopBar,
    overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    switches,
  };
}

/** Why a switch isn't drawn at phone size, or nothing when it is. */
export function switchProblems(s: SwitchShape): string[] {
  const problems: string[] = [];
  if (s.target < 43.5) problems.push(`target ${s.target}px, under 44px`);
  if (s.track < 30 || s.track > 32) problems.push(`track ${s.track}px, not 30–32px`);
  if (s.clip !== 'padding-box') problems.push(`its colour fills the clear border (${s.clip})`);
  if (!s.thumbInTrack) problems.push('thumb outside the track');
  if (s.labelOffCentre !== null && s.labelOffCentre >= 2) problems.push(`label ${s.labelOffCentre}px off centre`);
  return problems;
}

/** Every problem on a page, one line each. */
export function pageProblems(page: PhonePage): string[] {
  const problems: string[] = [];
  if (page.underTopBar.length)
    problems.push(`${page.underTopBar.length} element(s) under the top bar, first ${page.underTopBar[0]}`);
  if (page.overflowX > 1) problems.push(`${page.overflowX}px wider than the screen`);
  for (const s of page.switches) {
    const found = switchProblems(s);
    if (found.length) problems.push(`switch “${s.label}” (${s.checked ? 'on' : 'off'}): ${found.join(', ')}`);
  }
  return problems;
}

/** The report, in Markdown: a row per page, then each problem. */
export function phoneReport(pages: PhonePage[], heading: string): string {
  const lines = [
    `## ${heading}`,
    '',
    '| Page | Under the top bar | Wider than the screen | Switches at phone size | Result |',
    '| -- | -- | -- | -- | -- |',
  ];
  for (const page of pages) {
    const ok = page.switches.filter((s) => !switchProblems(s).length).length;
    const shapes = page.switches.map((s) => `${s.target}/${s.track}px ${s.checked ? 'on' : 'off'}`).join(', ');
    lines.push(
      `| ${page.path} | ${page.underTopBar.length} | ${page.overflowX}px | ${ok} of ${page.switches.length}${shapes ? ` (${shapes})` : ''} | ${pageProblems(page).length ? 'Fail' : 'Pass'} |`,
    );
  }
  const problems = pages.flatMap((page) => pageProblems(page).map((p) => `- ${page.path}: ${p}`));
  lines.push(
    '',
    problems.length ? '### Problems' : 'No problems found.',
    ...(problems.length ? ['', ...problems] : []),
  );
  return lines.join('\n');
}

const log = (line: string) => console.log(line);

export async function main(argv: string[] = []): Promise<void> {
  const args = parsePhoneCheckArgs(argv);
  const target = resolveDemoTarget(args.project, process.env);
  if (target.kind === 'dev') process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] = target.projectId;
  const origin = siteOrigin(target, args.url);
  const email = DEMO_EMAILS[DEMO_ACCOUNTS[args.account] as string] as string;
  const password = await demoPassword(target);
  const paths = args.dryRun ? args.paths.slice(0, 1) : args.paths;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const { chromium, devices } = await import('@playwright/test');
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  });
  try {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13'];
    const context = await browser.newContext({
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      timezoneId: 'Australia/Melbourne',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    log(`Signing in to ${origin} as the demo ${args.account} (${email}) on an iPhone 13 screen.`);
    try {
      await signIn(page, origin, email, password);
    } catch (err) {
      await page.screenshot({ path: path.join(OUT_DIR, 'sign-in-failed.png') }).catch(() => undefined);
      throw new Error(`Sign-in failed at ${page.url()}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await skipTour(page);

    const pages: PhonePage[] = [];
    for (const pagePath of paths) {
      await page.goto(`${origin}${pagePath}`);
      // Firestore keeps its connection open, so there is no network idle: give the page time to fill.
      await page.waitForTimeout(6_000);
      await skipTour(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const name = pagePath.replace(/^\//, '').replace(/\//g, '-') || 'root';
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
      const measured = await page.evaluate(measurePhonePage, pagePath);
      pages.push(measured);
      log(JSON.stringify(measured));
    }

    const report = phoneReport(pages, `Phone check: ${origin} on an iPhone 13, signed in as the demo ${args.account}`);
    writeFileSync(path.join(OUT_DIR, 'summary.md'), `${report}\n`);
    log(report);
    const jobSummary = process.env['GITHUB_STEP_SUMMARY'];
    if (jobSummary) appendFileSync(jobSummary, `${report}\n`);
    const failed = pages.filter((p) => pageProblems(p).length).map((p) => p.path);
    if (failed.length) throw new Error(`Phone check failed on ${failed.join(', ')}.`);
  } finally {
    await browser.close();
  }
}
