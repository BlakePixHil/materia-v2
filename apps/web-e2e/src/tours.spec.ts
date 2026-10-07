import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  expectNoA11yViolations,
  FIRST_LOAD,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Guided tours (CORE-24) against the emulators, with `tours.enabled` on for a fresh fictional
 * practice: the welcome tour on first sign-in (axe with the theatre open), Show me around, a page
 * tour on the first visit to Matters, ⇧H, and the phone layout (iPhone 13) docking the card.
 */

const tour = (page: Page) => page.getByRole('dialog');
const title = (page: Page) => tour(page).getByRole('heading', { level: 2 });

async function practice(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Tours Practice' },
    displayName: 'Jordan Fictional',
  });
  await setOrgFlags(request, orgId, { 'tours.enabled': true });
  await seedClient(request, orgId, account.uid);
  await setEmulatorDocuments(request, [
    matterDoc(orgId, account.uid, {
      id: 'm-ashby',
      number: 'M-2026-0310',
      title: 'Estate of Ivy Ashby',
      responsibleUid: account.uid,
      daysAgo: 1,
    }),
  ]);
  // The flags load with the org: reload so the practice's override applies.
  await page.reload();
  return { orgId, uid: account.uid };
}

test.describe('guided tours', () => {
  test('first sign-in offers the welcome tour; taking it walks the shell and turns page tours on', async ({
    page,
    request,
  }) => {
    await practice(page, request);
    await expect(title(page)).toHaveText('Let’s show you around', FIRST_LOAD);
    await expect(page.getByRole('button', { name: 'Show me around' })).toBeFocused();
    await expectNoA11yViolations(page);

    await page.getByRole('button', { name: 'Show me around' }).click();
    await expect(title(page)).toHaveText('Your pages');
    await expect(tour(page)).toContainText(/Welcome · 1 of \d/);
    await page.keyboard.press('ArrowRight');
    await expect(title(page)).toHaveText('Find anything, do anything');
    await expectNoA11yViolations(page);
    // The page behind can't be used while the tour is open.
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page).toHaveURL(/\/today$/);
    await page.keyboard.press('Escape');
    await expect(tour(page)).toHaveCount(0);

    // Page tours are on now: Matters plays its tour the first time it opens.
    await page.goto('/matters');
    await expect(title(page)).toHaveText('List or board', FIRST_LOAD);
    await expect(tour(page)).toContainText('Matters · 1 of');
    for (let step = 0; step < 6 && (await tour(page).count()); step++) {
      await page.getByRole('button', { name: /^(Next|Done)$/ }).click();
    }
    await expect(tour(page)).toHaveCount(0);

    // Not again on the next visit, but ⇧H starts it on demand.
    await page.goto('/today');
    await page.goto('/matters');
    await page.waitForTimeout(1500);
    await expect(tour(page)).toHaveCount(0);
    await page.keyboard.press('Shift+H');
    await expect(title(page)).toHaveText('List or board', FIRST_LOAD);
    await page.getByRole('button', { name: 'End tour' }).click();
    await expect(tour(page)).toHaveCount(0);
  });

  test('Skip closes the welcome tour for good', async ({ page, request }) => {
    await practice(page, request);
    await expect(title(page)).toHaveText('Let’s show you around', FIRST_LOAD);
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(tour(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_LOAD);
    await page.waitForTimeout(1500);
    await expect(tour(page)).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13'];
    test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

    test('the card docks to the edge and the tour uses the TabBar', async ({ page, request }) => {
      await practice(page, request);
      await expect(title(page)).toHaveText('Let’s show you around', FIRST_LOAD);
      await page.getByRole('button', { name: 'Show me around' }).click();
      await expect(title(page)).toHaveText('Your pages');
      const card = await tour(page).boundingBox();
      expect(card?.x).toBe(12);
      expect(card && Math.round(card.width)).toBe((viewport?.width ?? 390) - 24);
      // The TabBar is low on the screen, so the card docks at the top.
      expect(card && card.y).toBeLessThan(200);
      await expectNoA11yViolations(page);
      await page.keyboard.press('Escape');
      await expect(tour(page)).toHaveCount(0);
    });
  });
});
