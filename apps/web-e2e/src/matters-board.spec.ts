import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The Matters board (CORE-04) against the emulators: drag a card across columns (the real
 * `matters-changeStatus` validates it and the move survives a reload), a refused move rolls back,
 * and a keyboard move ("Move to…" with `m`, then Alt+↑) whose order is stable after a reload.
 * Each test in its own fictional practice.
 */

const column = (page: Page, title: string) => page.getByRole('list', { name: new RegExp(`^${title}: `) });
const card = (scope: Page | Locator, title: string) =>
  scope.locator('.card').filter({ has: scope.getByRole('button', { name: title, exact: true }) });
const toasts = (page: Page) => page.getByRole('region', { name: /Notifications/ });

/** Drags a card by its top row onto a column with the mouse, in small steps as CDK expects. */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('Nothing to drag');
  const x = start.x + start.width * 0.3;
  const y = start.y + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + 24, { steps: 20 });
  await page.mouse.move(end.x + end.width / 2, end.y + 28, { steps: 4 });
  await page.mouse.up();
}

test.describe('matters board', () => {
  test.skip(({ isMobile }) => isMobile, 'Dragging with a mouse and keyboard moves are desktop features');

  test('drag across columns, a refused move rolls back, and keyboard moves persist', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const jordan = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Board Practice' },
      displayName: 'Jordan Fictional',
    });
    await seedClient(request, orgId, jordan.uid);
    const lead = matterDoc(orgId, jordan.uid, {
      id: 'm-lead',
      number: 'M-2026-0004',
      title: 'Hartigan family enquiry',
      type: 'will',
      status: 'lead',
      responsibleUid: jordan.uid,
      daysAgo: 4,
    });
    await setEmulatorDocuments(request, [
      ...[
        { id: 'm-quill', number: 'M-2026-0001', title: 'Estate of Ada Quillfeather', daysAgo: 1 },
        { id: 'm-marsh', number: 'M-2026-0002', title: 'Will for Ottilie Marsh', type: 'will', daysAgo: 2 },
        { id: 'm-vale', number: 'M-2026-0003', title: 'Estate of Rupert Vale', daysAgo: 3 },
      ].map((matter) => matterDoc(orgId, jordan.uid, { ...matter, responsibleUid: jordan.uid })),
      // A lead whose conflict check isn't done: it can't open.
      { ...lead, data: { ...lead.data, conflictCheck: { status: 'pending' } } },
    ]);

    await page.goto('/matters');
    await page
      .getByRole('radio', { name: 'Board' })
      .or(page.getByRole('button', { name: 'Board' }))
      .click();
    await expect(page).toHaveURL(/\/matters\/board/);
    await expect(column(page, 'Open')).toContainText('Estate of Ada Quillfeather');
    await expect(column(page, 'Open')).toContainText('Will for Ottilie Marsh');
    await expect(column(page, 'Lead')).toContainText('Hartigan family enquiry');
    await expectNoA11yViolations(page);

    // Drag Ada to On hold: matters-changeStatus moves it, and it stays there after a reload.
    await drag(page, card(page, 'Estate of Ada Quillfeather'), column(page, 'On hold'));
    await expect(column(page, 'On hold')).toContainText('Estate of Ada Quillfeather');
    await expect(page.getByText('Moved M-2026-0001 to On hold, 1 of 1.')).toBeAttached({ timeout: 20_000 });
    await page.reload();
    await expect(column(page, 'On hold')).toContainText('Estate of Ada Quillfeather', { timeout: 20_000 });
    await expect(column(page, 'Open')).not.toContainText('Estate of Ada Quillfeather');

    // The lead can't open before its conflict check: the server refuses and the card goes back.
    await drag(page, card(page, 'Hartigan family enquiry'), column(page, 'Open'));
    await expect(toasts(page).getByText('Couldn’t move M-2026-0004 to Open')).toBeVisible({ timeout: 20_000 });
    await expect(column(page, 'Lead')).toContainText('Hartigan family enquiry');
    await expect(column(page, 'Open')).not.toContainText('Hartigan family enquiry');

    // Keyboard: m opens "Move to…"; Ada goes back to Open, then Alt+↑ puts Vale above Marsh.
    await card(page, 'Estate of Ada Quillfeather').getByRole('button', { name: 'Estate of Ada Quillfeather' }).focus();
    await page.keyboard.press('m');
    await page.getByRole('menu', { name: 'Move M-2026-0001 to' }).getByRole('menuitem', { name: 'Open' }).click();
    await expect(column(page, 'Open')).toContainText('Estate of Ada Quillfeather', { timeout: 20_000 });
    await expect(page.getByText(/Moved M-2026-0001 to Open, 1 of 3\./)).toBeAttached({ timeout: 20_000 });
    const names = () => column(page, 'Open').locator('.card .name').allTextContents();
    await expect
      .poll(async () => (await names()).map((n) => n.trim()))
      .toEqual(['Estate of Ada Quillfeather', 'Will for Ottilie Marsh', 'Estate of Rupert Vale']);
    await card(page, 'Estate of Rupert Vale').getByRole('button', { name: 'Estate of Rupert Vale' }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByText('Moved M-2026-0003 to Open, 2 of 3.')).toBeAttached();
    await expectNoA11yViolations(page);

    // The order is the same after a reload (it is saved on the matters, so for everyone).
    await page.reload();
    await expect
      .poll(async () => (await names()).map((n) => n.trim()), { timeout: 20_000 })
      .toEqual(['Estate of Ada Quillfeather', 'Estate of Rupert Vale', 'Will for Ottilie Marsh']);
  });
});
