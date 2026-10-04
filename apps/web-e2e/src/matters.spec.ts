import { expect, test, type Page } from '@playwright/test';

import {
  createTestAccount,
  expectNoA11yViolations,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, table, uniqueOrg } from './support/matters';

/**
 * The Matters list (CORE-03) against the emulators: filter, save a view (it survives a reload),
 * bulk assign and open a matter from the keyboard (the 500-matter first paint is in load/). Matters are
 * seeded through the emulator as the server keeps them (`deletedAt: null`, search tokens and last
 * activity from matters-denormalise), each test in its own fictional practice. No callables are
 * called: bulk assign is a client update.
 */

const bar = (page: Page) => page.getByRole('group', { name: 'View and filters' });
const dialog = (page: Page) => page.getByRole('dialog');
const toasts = (page: Page) => page.getByRole('region', { name: /Notifications/ });

/** Picks an item from a filter chip's menu. */
async function pick(page: Page, chip: string | RegExp, item: string): Promise<void> {
  await bar(page).getByRole('button', { name: chip }).click();
  const menu = page.getByRole('menu');
  await menu.getByRole(/^Status$|^Type$/.test(String(chip)) ? 'menuitemcheckbox' : 'menuitem', { name: item }).click();
  if (await menu.isVisible()) await page.keyboard.press('Escape');
}

test.describe('matters', () => {
  test.skip(({ isMobile }) => isMobile, 'Keyboard shortcuts, bulk actions and the dense list are desktop features');

  test('filter, save a view, bulk assign and open a matter from the keyboard', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const claims = { orgId, role: 'lawyer', orgName: 'Fictional Matters Practice' };
    const priya = await createTestAccount(request, { claims, displayName: 'Priya Fictional' });
    const jordan = await signInAsTestUser(page, request, { claims, displayName: 'Jordan Fictional' });

    await seedClient(request, orgId, jordan.uid);
    await setEmulatorDocuments(
      request,
      [
        {
          id: 'm-quill',
          number: 'M-2026-0001',
          title: 'Estate of Ada Quillfeather',
          responsibleUid: jordan.uid,
          labels: ['grant-pending'],
          daysAgo: 1,
        },
        {
          id: 'm-marsh',
          number: 'M-2026-0002',
          title: 'Will for Ottilie Marsh',
          type: 'will',
          jurisdiction: 'NSW',
          responsibleUid: jordan.uid,
          daysAgo: 2,
        },
        { id: 'm-vale', number: 'M-2026-0003', title: 'Estate of Rupert Vale', responsibleUid: priya.uid, daysAgo: 3 },
        {
          id: 'm-hartigan',
          number: 'M-2026-0004',
          title: 'Hartigan family enquiry',
          type: 'will',
          status: 'lead',
          responsibleUid: jordan.uid,
          daysAgo: 4,
        },
        {
          id: 'm-pemble',
          number: 'M-2026-0005',
          title: 'Estate of Cyrus Pemble',
          status: 'on_hold',
          responsibleUid: jordan.uid,
          daysAgo: 5,
        },
      ].map((matter) => matterDoc(orgId, jordan.uid, matter)),
    );

    await page.locator('nav a[href="/matters"]').first().click();
    await expect(page).toHaveTitle('Matters · Materia');
    // "My open matters": open, mine, most recently active first.
    await expect(bar(page).getByRole('button', { name: 'My open matters' })).toBeVisible();
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');
    await expect(table(page)).toContainText('Will for Ottilie Marsh');
    await expect(table(page)).toContainText('Bram Fictional');
    await expect(table(page)).not.toContainText('Estate of Rupert Vale');
    await expect(table(page)).not.toContainText('Hartigan family enquiry');
    await expectNoA11yViolations(page);

    // Filter: anyone's open probate matters.
    await pick(page, 'Mine', 'Anyone');
    await expect(table(page)).toContainText('Estate of Rupert Vale');
    await pick(page, 'Type', 'Probate');
    await expect(table(page)).not.toContainText('Will for Ottilie Marsh');
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(2);
    await expect(bar(page).getByRole('button', { name: 'My open matters (edited)' })).toBeVisible();

    // Save it as a view; it's there after a reload.
    await bar(page).getByRole('button', { name: 'Save view' }).click();
    await dialog(page).getByLabel('View name').fill('Open probate');
    await dialog(page).getByRole('button', { name: 'Save view' }).click();
    await expect(toasts(page).getByText('View saved')).toBeVisible();
    await expect(page).toHaveURL(/\/matters\?view=/);
    await page.reload();
    await expect(bar(page).getByRole('button', { name: 'Open probate', exact: true })).toBeVisible();
    await expect(table(page)).toContainText('Estate of Rupert Vale');
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');
    await expect(table(page)).not.toContainText('Will for Ottilie Marsh');
    await expectNoA11yViolations(page);

    // Bulk assign: both of these to Priya.
    // Click, then wait for the state: the checkbox re-renders on the next change detection, which
    // under load can land after locator.check()'s immediate re-read.
    for (const name of ['M-2026-0001 Estate of Ada Quillfeather', 'M-2026-0003 Estate of Rupert Vale']) {
      const checkbox = table(page).getByRole('checkbox', { name: `Select ${name}` });
      await checkbox.click();
      await expect(checkbox).toBeChecked();
    }
    const bulk = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bulk).toContainText('2 selected');
    await expectNoA11yViolations(page);
    await bulk.getByRole('button', { name: 'Assign' }).click();
    await page.getByRole('menu', { name: 'Assign to' }).getByRole('menuitem', { name: 'Priya Fictional' }).click();
    await expect(toasts(page).getByText('Assigned 2 matters to Priya Fictional')).toBeVisible();
    await expect(bulk).toHaveCount(0);
    // Priya's open probate matters are now both.
    await pick(page, 'Anyone', 'Priya Fictional');
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(2);
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');

    // Keyboard: back to My open matters, j to the first row, Enter opens it.
    await bar(page)
      .getByRole('button', { name: /^Open probate/ })
      .click();
    await page.getByRole('menu', { name: 'Views' }).getByRole('menuitem', { name: 'My open matters' }).click();
    await expect(page).toHaveURL(/\/matters$/);
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(1);
    await expect(table(page)).toContainText('Will for Ottilie Marsh');
    await page.keyboard.press('j');
    // The row takes focus after the next render; Enter goes to whatever has focus.
    await expect(table(page).locator('tbody tr[data-index="0"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-marsh(\/|$)/);
  });
});
