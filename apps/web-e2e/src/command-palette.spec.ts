import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { documentSearchTokens, taskSearchTokens } from '@materia/domain';
import {
  createTestAccount,
  expectNoA11yViolations,
  FIRST_LOAD,
  setEmulatorDocument,
  signInAsTestUser,
  type TestAccount,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * ⌘K search and commands (CORE-15): matters by number in any form and by name, people, tasks and
 * documents, Tab into a matter's actions, the open matter's commands, the list's commands, and
 * Recent. Each test has its own org; every record is fictional.
 */

const palette = (page: Page) => page.getByRole('combobox');
const groupLabels = (page: Page) => page.locator('.mt-cmdk .mt-menu-label');
const option = (page: Page, name: string | RegExp) => page.getByRole('option', { name });

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeFocused();
}

/** An org with two matters, a task, a document and a client; signed in as its lawyer. */
async function setup(page: Page, request: APIRequestContext): Promise<{ orgId: string; me: TestAccount }> {
  const orgId = uniqueOrg();
  const claims = { orgId, role: 'lawyer', orgName: 'Fictional Search Practice' };
  const other = await createTestAccount(request, { claims, displayName: 'Priya Fictional' });
  const me = await signInAsTestUser(page, request, { claims, displayName: 'Jordan Fictional' });
  await seedClient(request, orgId, me.uid);
  for (const doc of [
    matterDoc(orgId, me.uid, {
      id: 'm-wren',
      number: 'M-2026-0142',
      title: 'Estate of Margaret Wren',
      responsibleUid: me.uid,
      daysAgo: 1,
    }),
    matterDoc(orgId, me.uid, {
      id: 'm-vale',
      number: 'M-2026-1420',
      title: 'Estate of Rupert Vale',
      responsibleUid: other.uid,
      daysAgo: 2,
    }),
  ]) {
    await setEmulatorDocument(request, doc.path, doc.data);
  }
  const meta = { createdAt: new Date(), createdBy: me.uid, updatedAt: new Date(), updatedBy: me.uid, schemaVersion: 1 };
  await setEmulatorDocument(request, `orgs/${orgId}/matters/m-wren/tasks/t-inventory`, {
    orgId,
    matterId: 'm-wren',
    title: 'Lodge the inventory of assets',
    status: 'todo',
    priority: 'none',
    assigneeUid: me.uid,
    checklist: [],
    order: 1000,
    source: 'manual',
    search: taskSearchTokens('Lodge the inventory of assets'),
    deletedAt: null,
    ...meta,
  });
  await setEmulatorDocument(request, `orgs/${orgId}/matters/m-wren/documents/d-grant`, {
    orgId,
    matterId: 'm-wren',
    name: 'Grant of probate – Wren.pdf',
    category: 'grant',
    privileged: false,
    tags: [],
    version: 1,
    versions: [],
    scan: { status: 'clean' },
    ingest: { status: 'done' },
    source: 'upload',
    search: documentSearchTokens('Grant of probate – Wren.pdf'),
    deletedAt: null,
    ...meta,
  });
  return { orgId, me };
}

test.describe('command palette (CORE-15)', () => {
  test.skip(({ isMobile }) => isMobile, '⌘K is a desktop feature');

  test('finds a matter by its number with or without the prefix, ranks the exact one first and opens it', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await openPalette(page);
    for (const typed of ['142', '2026-0142', 'M-2026-0142']) {
      await palette(page).fill(typed);
      await expect(groupLabels(page).first()).toHaveText('Matters');
      await expect(page.getByRole('option').first()).toContainText('Estate of Margaret Wren');
      await expect(page.getByRole('option').first()).toContainText('M-2026-0142');
    }
    // One character matches commands only.
    await palette(page).fill('w');
    await expect(groupLabels(page)).toHaveText(['Actions']);

    await palette(page).fill('wren');
    await expect(option(page, /Estate of Margaret Wren/)).toBeVisible();
    await expect(option(page, /Lodge the inventory/)).toHaveCount(0);
    await expect(option(page, /Grant of probate – Wren\.pdf/)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-wren\/overview$/);
    await expect(palette(page)).toHaveCount(0);

    // What I opened is Recent the next time.
    await openPalette(page);
    await expect(groupLabels(page).first()).toHaveText('Recent');
    await expect(page.getByRole('option').first()).toContainText('Estate of Margaret Wren');
  });

  test('finds people, tasks and documents, and opens a task where it lives', async ({ page, request }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await openPalette(page);
    await palette(page).fill('fictional bram');
    await expect(option(page, /Bram Fictional/)).toBeVisible();
    await palette(page).fill('inventory');
    await expect(groupLabels(page).first()).toHaveText('Tasks');
    await option(page, /Lodge the inventory of assets/).click();
    await expect(page).toHaveURL(/\/matters\/m-wren\/tasks\?task=t-inventory$/);
    await expect(page.getByText('Lodge the inventory of assets')).toBeVisible();
  });

  test('Tab drills into a matter’s actions; Add task opens quick add on its tasks', async ({ page, request }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await openPalette(page);
    await palette(page).fill('M-2026-0142');
    await expect(page.getByRole('option').first()).toContainText('Estate of Margaret Wren');
    await page.keyboard.press('Tab');
    await expect(page.locator('.mt-cmdk-input .scope')).toHaveText('M-2026-0142');
    await expect(option(page, /Upload document/)).toBeVisible();
    // Backspace in the empty input leaves the matter; Tab goes back in.
    await page.keyboard.press('Backspace');
    await expect(page.locator('.mt-cmdk-input .scope')).toHaveCount(0);
    await palette(page).fill('M-2026-0142');
    await expect(page.getByRole('option').first()).toContainText('Estate of Margaret Wren');
    await page.keyboard.press('Tab');
    await palette(page).fill('add task');
    await expect(page.getByRole('option').first()).toContainText('Add task');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-wren\/tasks$/);
    await expect(page.getByRole('textbox', { name: 'New task' })).toBeVisible();
  });

  test('the open matter’s commands: Upload document opens the file picker, Assign changes the lawyer', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await page.goto('/matters/m-vale/overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Estate of Rupert Vale' })).toBeVisible();
    await openPalette(page);
    await expect(groupLabels(page)).toContainText(['This matter']);
    await palette(page).fill('upload');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-vale\/documents$/);
    await chooser;

    await openPalette(page);
    await palette(page).fill('assign');
    await page.keyboard.press('Enter');
    await expect(option(page, 'Jordan Fictional')).toBeVisible();
    await palette(page).fill('jordan');
    await page.keyboard.press('Enter');
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator('mt-matter-header')).toContainText('Jordan Fictional');
  });

  test('the list’s commands: Filter by… narrows the Matters list', async ({ page, request }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await page.goto('/matters');
    await expect(page.getByRole('table', { name: 'Matters' })).toBeVisible(FIRST_LOAD);
    await openPalette(page);
    await palette(page).fill('filter by');
    await page.keyboard.press('Enter');
    await palette(page).fill('responsible me');
    await page.keyboard.press('Enter');
    // The filter starts a new query, and the table waits for its first answer.
    await expect(page.getByRole('table', { name: 'Matters' })).toContainText('Estate of Margaret Wren', FIRST_LOAD);
    await expect(page.getByRole('table', { name: 'Matters' })).not.toContainText('Estate of Rupert Vale');
  });

  test('global commands: New contact from anywhere opens the contact form', async ({ page, request }) => {
    test.setTimeout(90_000);
    await setup(page, request);
    await openPalette(page);
    await palette(page).fill('new contact');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/contacts/);
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`results have no WCAG 2.2 AA violations (${theme})`, async ({ page, request }) => {
      test.setTimeout(90_000);
      await page.emulateMedia({ colorScheme: theme });
      await setup(page, request);
      await openPalette(page);
      await palette(page).fill('wren');
      await expect(option(page, /Estate of Margaret Wren/)).toBeVisible();
      await expectNoA11yViolations(page);
      await page.screenshot({ path: test.info().outputPath(`command-palette-${theme}.png`) });
    });
  }
});
