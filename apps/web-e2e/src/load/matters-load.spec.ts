import { expect, test } from '@playwright/test';

import {
  disableBackgroundTriggers,
  enableBackgroundTriggers,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, table, uniqueOrg } from '../support/matters';

/**
 * The Matters list's first paint with 500 matters (CORE-03), seeded with the Functions emulator's
 * background triggers off. In production triggers run on their own servers, but the emulator runs
 * them on the test's own CPU, one at a time: 500 matters set off over 3,000 runs (list fields,
 * metrics, audit entries, and the activity and audit checks those set off). Measured while they
 * ran, the first paint took 1,056 and 1,069 ms on CI, and 1,012 to 1,995 ms locally on two cores;
 * with the triggers off, 554 to 988 ms. Waiting for every matter's audit entry instead took over a
 * minute and still left the rest running (2026-10-07). The list shows only what the seed writes:
 * the triggers add nothing it reads.
 *
 * Switching triggers off affects every test using the emulators, so this runs in its own Playwright
 * project after the other projects (see playwright.config.mts).
 */

test.describe('matters under load', () => {
  test.skip(({ isMobile }) => isMobile, 'The dense list is a desktop feature');
  test.afterEach(({ request }) => enableBackgroundTriggers(request));

  test('with 500 matters the first rows paint within a second, and scrolling loads more', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Busy Practice' },
      displayName: 'Jordan Fictional',
    });
    await disableBackgroundTriggers(request);
    await seedClient(request, orgId, account.uid);
    const surnames = ['Abernathy', 'Blackwood', 'Corrigan', 'Delacroix', 'Ellery', 'Fairweather', 'Galloway', 'Hollis'];
    await setEmulatorDocuments(
      request,
      Array.from({ length: 500 }, (_, i) =>
        matterDoc(orgId, account.uid, {
          id: `m-${String(i + 1).padStart(4, '0')}`,
          number: `M-2026-${String(i + 1).padStart(4, '0')}`,
          title: `Estate of ${surnames[i % surnames.length]} ${i + 1}`,
          type: i % 3 === 0 ? 'will' : 'probate',
          responsibleUid: account.uid,
          daysAgo: i / 10,
        }),
      ),
    );

    // Warm-up visit (loads the route's code once, as a returning user would have it cached).
    await page.goto('/matters');
    await expect(table(page).locator('tbody tr[data-index]').first()).toBeVisible(FIRST_LOAD);
    await page.goto('/today');
    await expect(page).toHaveURL(/\/today$/);

    // From the click on Matters to the first painted row.
    const firstPaint = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let start = 0;
          document.addEventListener('click', () => (start = performance.now()), { capture: true, once: true });
          const observer = new MutationObserver(() => {
            if (!start || !document.querySelector('mt-table tbody tr[data-index]')) return;
            observer.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - start));
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }),
    );
    await page.locator('nav a[href="/matters"]').first().click();
    const elapsed = await firstPaint;
    test.info().annotations.push({ type: 'first rows painted (ms)', description: elapsed.toFixed(0) });
    expect(elapsed).toBeLessThan(1000);

    // The first page is 50 rows, most recently active first; scrolling to the end loads the next.
    const rows = table(page).locator('tbody tr[data-index]');
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText('M-2026-0001');
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(100);
  });
});
