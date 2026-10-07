import { expect, test, type Page } from '@playwright/test';

import { FIRST_LOAD } from '@materia/test-utils/e2e';

import {
  readSnapshot,
  resetReads,
  settledReads,
  signInForPerf,
  topLabels,
  writeReport,
  type ReadSnapshot,
} from './support';

/**
 * Firestore reads per screen load (SEC-07), counted by the e2e build's reads counter
 * (libs/data-access read-counter.ts: what Firestore bills, as the client sees it) for the large
 * practice's full-load fee earner. Each screen is opened from another one in the running app (the
 * shell's own listeners are already up), the way a person moves around; Today is also measured as
 * a full page load, shell included. Run with E2E_PERF=1 against `materia-scripts seed-large`
 * (see docs/ops/perf-report-2026-10.md).
 */
export const READ_BUDGETS = {
  /**
   * The ticket's (warm). Measured 75 at seed-large scale 0.05 with the firm's 50 members, after WIP
   * moved to the month rollup.
   */
  today: 150,
  /**
   * Measured 165: one page of matters, the firm's 50 members, and one read per client contact on
   * the page (63, an N+1 bounded by the page size). Exception until "Denormalise client names onto
   * matters" lands; then about 100.
   */
  matters: 200,
  /** The ticket's. Measured 62, 50 of them the firm's members (fewer when that listener resumes). */
  matter: 100,
  /**
   * Measured 688: the firm-wide list reads up to 500 upcoming deadlines live, the firm's 50
   * members, then each deadline's matter (136 here: an N+1 of up to 500 at the target scale, so
   * about 1,050 there). Exception until "Window the Deadlines page and denormalise matter fields
   * onto deadlines" lands; the target is then 200.
   */
  deadlines: 800,
} as const;

type Screen = keyof typeof READ_BUDGETS;

const results: Record<string, { reads: number; cached: number; budget?: number | undefined; top: string[] }> = {};

function record(name: string, snapshot: ReadSnapshot, budget?: number) {
  results[name] = { reads: snapshot.reads, cached: snapshot.cached, budget, top: topLabels(snapshot) };
  test.info().annotations.push({
    type: `${name} reads`,
    description: `${snapshot.reads} (cached ${snapshot.cached})${budget ? `, budget ${budget}` : ''}: ${topLabels(snapshot, 4).join('; ')}`,
  });
  writeReport('reads.json', results);
}

/**
 * Opens a screen from the nav after resetting the counter, and waits for its reads to settle: its
 * first server answer, then quiet (on a busy emulator that answer can take longer than the quiet).
 */
async function open(page: Page, screen: Screen, go: () => Promise<void>, ready: () => Promise<void>) {
  await resetReads(page);
  await go();
  await ready();
  await expect.poll(async () => (await readSnapshot(page)).reads, FIRST_LOAD).toBeGreaterThan(0);
  const snapshot = await settledReads(page);
  record(screen, snapshot, READ_BUDGETS[screen]);
  return snapshot;
}

test.describe('reads per screen', () => {
  test.describe.configure({ mode: 'serial' });

  test('Today, Matters, a matter and Deadlines stay within their read budgets', async ({ page }) => {
    test.setTimeout(240_000);
    await signInForPerf(page);
    await expect(page.locator('[data-section="stats"]')).toBeVisible(FIRST_LOAD);
    await settledReads(page);

    // A full page load of Today: the shell (session, org, flags, policy) plus the screen.
    await page.reload();
    await expect(page.locator('[data-section="stats"]')).toBeVisible(FIRST_LOAD);
    record('today (page load)', await settledReads(page));

    const nav = (href: string) => page.locator(`nav a[href="${href}"]`).first();
    const matters = await open(
      page,
      'matters',
      () => nav('/matters').click(),
      () => expect(page.locator('mt-table tbody tr[data-index]').first()).toBeVisible(FIRST_LOAD),
    );
    const today = await open(
      page,
      'today',
      () => nav('/today').click(),
      () => expect(page.locator('[data-section="stats"]')).toBeVisible(FIRST_LOAD),
    );
    await nav('/matters').click();
    // The most recently active matter (the list's first row); a click on the row opens it.
    const row = page.locator('mt-table tbody tr[data-index="0"] td').nth(2);
    await expect(row).toBeVisible(FIRST_LOAD);
    await settledReads(page);
    const matter = await open(
      page,
      'matter',
      () => row.click(),
      () => expect(page).toHaveURL(/\/matters\/m-lg-\d+\/overview$/),
    );
    const deadlines = await open(
      page,
      'deadlines',
      () => nav('/deadlines').click(),
      () => expect(page.locator('mt-deadline-row').first()).toBeVisible(FIRST_LOAD),
    );

    expect.soft(today.reads, `Today: ${topLabels(today).join('; ')}`).toBeLessThanOrEqual(READ_BUDGETS.today);
    expect.soft(matters.reads, `Matters: ${topLabels(matters).join('; ')}`).toBeLessThanOrEqual(READ_BUDGETS.matters);
    expect.soft(matter.reads, `Matter: ${topLabels(matter).join('; ')}`).toBeLessThanOrEqual(READ_BUDGETS.matter);
    expect
      .soft(deadlines.reads, `Deadlines: ${topLabels(deadlines).join('; ')}`)
      .toBeLessThanOrEqual(READ_BUDGETS.deadlines);
    // Nothing reads in the background while a screen sits open.
    await resetReads(page);
    await page.waitForTimeout(3000);
    expect((await readSnapshot(page)).reads).toBe(0);
  });
});
