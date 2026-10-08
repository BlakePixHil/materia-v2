import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import lighthouse, { type Flags } from 'lighthouse';

import { FIRST_LOAD } from '@materia/test-utils/e2e';

import { signInForPerf, writeReport } from './support';

/**
 * Web Vitals budgets for the key screens on a mid-tier phone (SEC-07), against the large practice
 * (`materia-scripts seed-large`) as its full-load fee earner, signed in:
 *
 * - LCP and CLS from Lighthouse navigation runs with its mobile defaults: a Moto G Power screen,
 *   4× CPU slowdown and slow 4G (150 ms RTT, 1.6 Mbps), simulated. Each run starts with an empty
 *   HTTP cache (as after a deploy) and keeps the sign-in and Firestore's local cache (as for a
 *   returning user). TBT is reported beside them, as INP's lab proxy.
 * - INP from the Event Timing API while Playwright works each screen (taps on filters, sections and
 *   tabs, keyboard moves, typing a search) with the CPU slowed 4× on a phone-sized screen, so in the
 *   phone layouts (MOB-02): the slowest interaction, as web-vitals reports INP for fewer than 50
 *   interactions.
 *
 * Budgets fail the test. Reports (Lighthouse HTML per screen, vitals.json) go to PERF_OUT_DIR.
 * Run with E2E_PERF=1 (see docs/ops/perf-report-2026-10.md).
 */
export const VITALS_BUDGETS = { lcpMs: 2500, inpMs: 200, cls: 0.1 } as const;

type ScreenName = 'today' | 'matters' | 'matter' | 'deadlines';
type Metric = keyof typeof VITALS_BUDGETS;

/**
 * Where a screen doesn't meet a budget yet (SEC-07's report): a ceiling at what was measured plus
 * headroom, so the job still catches a regression, until the named follow-up lands and the ceiling
 * goes. Measured at seed-large scale 0.05 on the Hosting emulator (HTTP/1.1, gzip).
 */
export const VITALS_EXCEPTIONS: Partial<Record<ScreenName, Partial<Record<Metric, number>>>> = {
  // LCP, measured ceilings (SEC-07b, MAT-177): the start-up no longer waits for Auth or the org
  // policy (the shell is drawn from the cached session and policy), but the Hosting emulator serves
  // about 100 requests before the first paint over HTTP/1.1 with gzip, which Lighthouse simulates
  // as six connections on slow 4G: 4.6–5.4 s to first paint. Measured on the phone layouts: Today
  // 7.7–7.8 s simulated (0.9 s unthrottled), the Matters list 10.7 s and a matter 9.6–10.1 s. The
  // CDN (HTTP/2, Brotli) is measured on dev: docs/ops/perf-report-2026-10.md. Deadlines 9.3 s once
  // SEC-07c windowed it (13.0–13.2 s before), measured before SEC-07b's start-up change.
  today: { lcpMs: 10_000 },
  matters: { lcpMs: 12_500 },
  matter: { lcpMs: 12_000 },
  deadlines: { lcpMs: 11_500 },
};

/** The budget a screen is held to: its exception's ceiling, or the ticket's. */
export function vitalsBudget(screen: ScreenName, metric: Metric): number {
  return VITALS_EXCEPTIONS[screen]?.[metric] ?? VITALS_BUDGETS[metric];
}

/** Lighthouse's mobile CPU slowdown, used for the INP runs too. */
const CPU_SLOWDOWN = 4;
/** Lighthouse's mobile screen (a Moto G Power), for the INP runs: below 768 px, the phone layouts (MOB-02). */
const PHONE = { width: 412, height: 823 };
/** The Chrome DevTools port Lighthouse connects to (the perf project runs one worker). */
const DEBUG_PORT = Number(process.env['PERF_DEBUG_PORT'] ?? 9339);

interface Screen {
  name: ScreenName;
  path: string;
  /** Resolves once the screen shows its content. */
  ready(page: Page): Promise<void>;
  /** Interactions a person makes on it, for INP. */
  interact(page: Page): Promise<void>;
}

interface VitalsRow {
  lcpMs: number;
  observedLcpMs: number;
  cls: number;
  tbtMs: number;
  fcpMs: number;
  inpMs: number | null;
  interactions: number;
  slowest: string | null;
  warnings: string[];
}

const settle = (page: Page) => page.waitForTimeout(400);

function screens(matterPath: string): Screen[] {
  return [
    {
      name: 'today',
      path: '/today',
      // My tasks: on a phone the cards after it are drawn as they scroll into view (MOB-02b).
      ready: (page) => expect(page.locator('[data-section="tasks"]')).toBeVisible(FIRST_LOAD),
      async interact(page) {
        // j and k move through the rows (CORE-14); each key is an interaction.
        for (const key of ['j', 'j', 'j', 'k', 'j']) {
          await page.keyboard.press(key);
          await settle(page);
        }
      },
    },
    {
      name: 'matters',
      path: '/matters',
      // The phone list (MOB-02): search first, then recents and "My open matters".
      ready: (page) => expect(page.locator('[data-matter]').first()).toBeVisible(FIRST_LOAD),
      async interact(page) {
        // Typing searches; clearing the field draws the view's rows again.
        const search = page.getByRole('searchbox', { name: 'Search matters' });
        await search.click();
        await search.pressSequentially('estate', { delay: 120 });
        await settle(page);
        await search.fill('');
        await settle(page);
      },
    },
    {
      name: 'matter',
      path: matterPath,
      // A phone's Overview (MOB-02): folding sections, with the other tabs under "More on this matter".
      ready: (page) => expect(page.locator('.mt-phone-matter [data-section="deadlines"]')).toBeVisible(FIRST_LOAD),
      async interact(page) {
        for (const section of ['facts', 'deadlines', 'tasks', 'facts', 'deadlines', 'tasks']) {
          await page.locator(`.mt-phone-matter [data-section="${section}"] > summary`).click();
          await settle(page);
        }
        await page
          .getByRole('navigation', { name: 'More on this matter' })
          .getByRole('link', { name: 'Tasks', exact: true })
          .click();
        await expect(page.getByRole('navigation', { name: 'Matter sections' })).toBeVisible();
        await settle(page);
      },
    },
    {
      name: 'deadlines',
      path: '/deadlines',
      // The rows, not just the heading: the toggles filter them. A page of them, with the CPU slowed
      // 4x in the INP tab, can take longer than a first load usually does.
      ready: (page) => expect(page.locator('mt-deadline-row').first()).toBeVisible({ timeout: 60_000 }),
      async interact(page) {
        const filters = page.getByRole('group', { name: 'Filters' });
        for (const name of ['Mine', 'Mine', 'Critical', 'Critical']) {
          await filters.getByRole('button', { name, exact: true }).click();
          await settle(page);
        }
      },
    },
  ];
}

type Timing = { id: number; name: string; duration: number; target: string };
type TimingWindow = { __materiaInteractions?: Timing[] };

/** Records every interaction's event timings from the first paint on (as web-vitals does). */
function observeInteractions(): void {
  const w = window as unknown as TimingWindow;
  w.__materiaInteractions = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { interactionId?: number; target?: Element })[]) {
        if (!entry.interactionId) continue;
        const target = entry.target;
        w.__materiaInteractions?.push({
          id: entry.interactionId,
          name: entry.name,
          duration: entry.duration,
          target: target ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}` : '',
        });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  } catch {
    // No Event Timing: INP stays unknown.
  }
}

/** INP from the recorded timings: each interaction's longest event, and the slowest interaction. */
function inpOf(timings: readonly Timing[]): { inpMs: number | null; interactions: number; slowest: string | null } {
  const byId = new Map<number, Timing>();
  for (const timing of timings) {
    const known = byId.get(timing.id);
    if (!known || timing.duration > known.duration) byId.set(timing.id, timing);
  }
  const worst = [...byId.values()].sort((a, b) => b.duration - a.duration)[0];
  return {
    inpMs: worst ? worst.duration : null,
    interactions: byId.size,
    slowest: worst ? `${worst.name} on ${worst.target || 'the page'}` : null,
  };
}

async function measureInp(context: BrowserContext, baseURL: string, screen: Screen) {
  const page = await context.newPage();
  try {
    await page.setViewportSize(PHONE);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    await page.goto(new URL(screen.path, baseURL).toString());
    await screen.ready(page);
    await page.waitForTimeout(1500);
    // Only what the interactions below cost: not the load.
    await page.evaluate(() => {
      (window as unknown as TimingWindow).__materiaInteractions = [];
    });
    await screen.interact(page);
    await page.waitForTimeout(500);
    const timings = await page.evaluate(() => (window as unknown as TimingWindow).__materiaInteractions ?? []);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return inpOf(timings);
  } finally {
    await page.close();
  }
}

async function runLighthouse(context: BrowserContext, baseURL: string, screen: Screen) {
  // An empty HTTP cache, but the same sign-in and Firestore cache: a returning user after a deploy.
  const blank = await context.newPage();
  const cdp = await context.newCDPSession(blank);
  await cdp.send('Network.clearBrowserCache');
  await blank.close();
  const flags: Flags = {
    port: DEBUG_PORT,
    output: 'html',
    logLevel: 'error',
    onlyCategories: ['performance'],
    // Keep the sign-in (IndexedDB) and the app's local cache; Lighthouse's mobile defaults otherwise.
    disableStorageReset: true,
    // Firestore's listen channel keeps the network from going quiet, so a run would wait out the
    // default 45 s; every screen has painted long before 20 s.
    maxWaitForLoad: 20_000,
  };
  const url = new URL(screen.path, baseURL).toString();
  let result = await lighthouse(url, flags);
  // Now and then Chrome's trace misses the navigation's start (NO_NAVSTART), and Lighthouse asks to
  // be run again. Once: a second failure is real.
  if (result?.lhr.runtimeError) result = await lighthouse(url, flags);
  if (!result) throw new Error(`Lighthouse returned nothing for ${screen.name}`);
  const { lhr } = result;
  if (lhr.runtimeError) throw new Error(`Lighthouse failed on ${screen.name}: ${lhr.runtimeError.message}`);
  writeReport(`lighthouse-${screen.name}.html`, String(result.report));
  writeReport(`lighthouse-${screen.name}.json`, lhr);
  const value = (id: string) => lhr.audits[id]?.numericValue ?? Number.NaN;
  // What the unthrottled browser saw, beside the simulated phone: the gap is network and CPU.
  const observed = (lhr.audits['metrics']?.details as { items?: Record<string, number>[] } | undefined)?.items?.[0];
  return {
    lcpMs: Math.round(value('largest-contentful-paint')),
    observedLcpMs: Math.round(observed?.['observedLargestContentfulPaint'] ?? Number.NaN),
    cls: Number(value('cumulative-layout-shift').toFixed(3)),
    tbtMs: Math.round(value('total-blocking-time')),
    fcpMs: Math.round(value('first-contentful-paint')),
    warnings: lhr.runWarnings.map(String),
  };
}

test.describe('Web Vitals on a mid-tier phone', () => {
  test('Today, Matters, a matter and Deadlines meet LCP, CLS and INP budgets', async () => {
    const testInfo = test.info();
    test.setTimeout(600_000);
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) throw new Error('The perf project needs BASE_URL (the Hosting emulator serving the e2e build).');
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
    const profile = mkdtempSync(path.join(os.tmpdir(), 'materia-vitals-'));
    // A persistent context, so Lighthouse's tabs (over the DevTools port) share its sign-in.
    const context = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : {}),
      args: [`--remote-debugging-port=${DEBUG_PORT}`],
      baseURL,
    });
    await context.addInitScript(observeInteractions);
    const results: Partial<Record<ScreenName, VitalsRow>> = {};
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await signInForPerf(page);
      // The matter a fee earner opens: the most recently active one on the list.
      await page.goto('/matters');
      const row = page.locator('mt-table tbody tr[data-index="0"] td').nth(2);
      await expect(row).toBeVisible(FIRST_LOAD);
      await row.click();
      await expect(page).toHaveURL(/\/matters\/m-lg-\d+\/overview$/);
      const all = screens(new URL(page.url()).pathname);
      // Visit each screen once on the phone, as a returning user has (Firestore's local cache), then
      // leave the app, so the measured tabs don't share a Firestore client with this one.
      await page.setViewportSize(PHONE);
      for (const screen of all) {
        await page.goto(screen.path);
        await screen.ready(page);
      }
      await page.goto('about:blank');

      for (const screen of all) {
        const lab = await runLighthouse(context, baseURL, screen);
        const inp = await measureInp(context, baseURL, screen);
        results[screen.name] = { ...lab, ...inp };
        testInfo.annotations.push({
          type: `${screen.name} vitals`,
          description: `LCP ${lab.lcpMs} ms, CLS ${lab.cls}, TBT ${lab.tbtMs} ms, INP ${inp.inpMs ?? '?'} ms (${inp.interactions} interactions; slowest ${inp.slowest ?? 'none'})`,
        });
        writeReport('vitals.json', {
          budgets: VITALS_BUDGETS,
          exceptions: VITALS_EXCEPTIONS,
          cpuSlowdown: CPU_SLOWDOWN,
          screens: results,
        });
      }
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }

    for (const [name, row] of Object.entries(results) as [ScreenName, VitalsRow][]) {
      expect.soft(row.lcpMs, `${name} LCP (ms)`).toBeLessThanOrEqual(vitalsBudget(name, 'lcpMs'));
      expect.soft(row.cls, `${name} CLS`).toBeLessThanOrEqual(vitalsBudget(name, 'cls'));
      expect.soft(row.inpMs, `${name} INP (ms)`).not.toBeNull();
      expect.soft(row.inpMs ?? Infinity, `${name} INP (ms)`).toBeLessThanOrEqual(vitalsBudget(name, 'inpMs'));
    }
    expect(Object.keys(results)).toHaveLength(4);
  });
});
