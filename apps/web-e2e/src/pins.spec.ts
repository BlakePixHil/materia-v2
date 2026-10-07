import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
  toFirestoreRestFields,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, table, uniqueOrg } from './support/matters';

/**
 * Pinned matters (CORE-23) against the emulators: pin from the matter's "…" menu, ⌘K and a Matters
 * row's menu; the sidebar keeps them in pinning order across a reload, collapses, and hides in the
 * rail; `p` unpins the focused row. On phones the pins lead the Matters list. Each test is its own
 * fictional practice.
 */

const USER_DOCS = `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/users`;
const ADMIN = { Authorization: 'Bearer owner' };

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const pinned = (page: Page) => sidebar(page).getByRole('navigation', { name: 'Pinned matters' });
const toasts = (page: Page) => page.getByRole('region', { name: /Notifications/ });

/** The stored pins in the org, or null while `users/{uid}` doesn't exist yet (auth-syncClaims writes it). */
async function storedPins(request: APIRequestContext, uid: string, orgId: string): Promise<string[] | null> {
  const response = await request.get(`${USER_DOCS}/${uid}`, { headers: ADMIN });
  if (response.status() === 404) return null;
  const body = (await response.json()) as {
    fields?: {
      pinnedMatterIds?: {
        mapValue?: { fields?: Record<string, { arrayValue?: { values?: { stringValue: string }[] } }> };
      };
    };
  };
  const list = body.fields?.pinnedMatterIds?.mapValue?.fields?.[orgId]?.arrayValue;
  return list?.values?.map((value) => value.stringValue) ?? [];
}

/** A practice with three of my matters, and my profile ready to take pins. */
async function practice(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const claims = { orgId, role: 'lawyer', orgName: 'Fictional Pins Practice' };
  const jordan = await signInAsTestUser(page, request, { claims, displayName: 'Jordan Fictional' });
  await seedClient(request, orgId, jordan.uid);
  await setEmulatorDocuments(
    request,
    [
      { id: 'm-quill', number: 'M-2026-0001', title: 'Estate of Ada Quillfeather', daysAgo: 1 },
      { id: 'm-marsh', number: 'M-2026-0002', title: 'Will for Ottilie Marsh', type: 'will', daysAgo: 2 },
      { id: 'm-vale', number: 'M-2026-0003', title: 'Vale v Vale', type: 'fp', daysAgo: 3 },
    ].map((matter) => matterDoc(orgId, jordan.uid, { ...matter, responsibleUid: jordan.uid })),
  );
  await expect.poll(() => storedPins(request, jordan.uid, orgId), FIRST_CALL).not.toBeNull();
  return { orgId, uid: jordan.uid };
}

test.describe('pinned matters', () => {
  test.skip(({ isMobile }) => isMobile, 'The sidebar, row menus and shortcuts are desktop features');

  test('pin from the matter, ⌘K and the list; the sidebar keeps the order, collapses and hides in the rail', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await practice(page, request);

    // The matter's "…" menu.
    await page.goto('/matters/m-quill');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Ada Quillfeather', FIRST_LOAD);
    await expect(sidebar(page).getByRole('button', { name: 'Pinned' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More matter actions' }).click();
    await page.getByRole('menuitem', { name: 'Pin matter' }).click();
    await expect(toasts(page).getByText('Pinned M-2026-0001')).toBeVisible();
    const quill = pinned(page).getByRole('link', { name: 'Estate of Ada Quillfeather' });
    await expect(quill).toHaveAttribute('aria-current', 'page');
    // Only one item reads as current: the pinned matter, not Matters.
    await expect(sidebar(page).getByRole('link', { name: 'Matters', exact: true })).not.toHaveAttribute('aria-current');

    // ⌘K on another matter.
    await page.goto('/matters/m-marsh');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Will for Ottilie Marsh', FIRST_LOAD);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox').fill('pin');
    await page.getByRole('option', { name: /Pin matter/ }).click();
    await expect(toasts(page).getByText('Pinned M-2026-0002')).toBeVisible();

    // A Matters row's "…" menu, shown on hover.
    await sidebar(page).getByRole('link', { name: 'Matters', exact: true }).click();
    await expect(table(page)).toContainText('Vale v Vale', FIRST_LOAD);
    const row = table(page).locator('tbody tr[data-index]', { hasText: 'Vale v Vale' });
    await row.hover();
    await row.getByRole('button', { name: 'More actions for M-2026-0003' }).click();
    await page.screenshot({ path: test.info().outputPath('pins-row-menu.png') });
    await page.getByRole('menuitem', { name: 'Pin matter' }).click();
    await expect(toasts(page).getByText('Pinned M-2026-0003')).toBeVisible();
    await expect.poll(() => storedPins(request, uid, orgId)).toEqual(['m-quill', 'm-marsh', 'm-vale']);

    // The order survives a reload; both themes are clean.
    await page.reload();
    await expect(pinned(page).getByRole('link')).toHaveText(
      ['Estate of Ada Quillfeather', 'Will for Ottilie Marsh', 'Vale v Vale'],
      FIRST_LOAD,
    );
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expectNoA11yViolations(page);
      await page.screenshot({ path: test.info().outputPath(`pins-${theme}.png`) });
    }

    // Collapse from the keyboard; it stays collapsed after a reload.
    const toggle = sidebar(page).getByRole('button', { name: 'Pinned' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(pinned(page).getByRole('link').first()).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('pins-collapsed.png') });
    await page.reload();
    await expect(sidebar(page).getByRole('button', { name: 'Pinned' })).toHaveAttribute(
      'aria-expanded',
      'false',
      FIRST_LOAD,
    );
    await sidebar(page).getByRole('button', { name: 'Pinned' }).click();
    await expect(pinned(page).getByRole('link').first()).toBeVisible();

    // The rail leaves the section out (⌘K still reaches the matters).
    await page.keyboard.press('[');
    await expect(page.locator('.mt-app')).toHaveAttribute('data-collapsed', '');
    await expect(pinned(page)).toHaveCount(0);
    await page.keyboard.press('[');
    await expect(pinned(page).getByRole('link')).toHaveCount(3);

    // `p` unpins the focused row.
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');
    await page.keyboard.press('j');
    await expect(table(page).locator('tbody tr[data-index="0"]')).toBeFocused();
    await page.keyboard.press('p');
    await expect(toasts(page).getByText('Unpinned M-2026-0001')).toBeVisible();
    await expect(pinned(page).getByRole('link')).toHaveText(['Will for Ottilie Marsh', 'Vale v Vale']);
    await expect.poll(() => storedPins(request, uid, orgId)).toEqual(['m-marsh', 'm-vale']);
  });
});

test.describe('pinned matters on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('lead the Matters list', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await practice(page, request);
    const pins = toFirestoreRestFields({ pinnedMatterIds: { [orgId]: ['m-vale', 'm-quill'] } });
    const response = await request.patch(`${USER_DOCS}/${uid}?updateMask.fieldPaths=pinnedMatterIds`, {
      headers: ADMIN,
      data: { fields: pins },
    });
    expect(response.ok(), await response.text()).toBe(true);

    await page.goto('/matters');
    const strip = page.getByRole('navigation', { name: 'Pinned matters' });
    await expect(strip.getByRole('link')).toHaveText(['Vale v Vale', 'Estate of Ada Quillfeather'], FIRST_LOAD);
    await expectNoA11yViolations(page);
    await page.screenshot({ path: test.info().outputPath('pins-phone.png') });
    await strip.getByRole('link', { name: 'Vale v Vale' }).click();
    await expect(page).toHaveURL(/\/matters\/m-vale\/overview$/);
  });
});
