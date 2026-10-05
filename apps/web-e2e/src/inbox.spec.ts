import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { uniqueOrg } from './support/matters';

/**
 * The Inbox (CORE-22) against the emulators: filters, keyboard triage, archive and the bell.
 * Fictional data only.
 */

const LIVE = { timeout: 20_000 };

function notification(uid: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return {
    kind: 'task_assigned',
    taskId: 't-1',
    recipientUid: uid,
    title: 'Task assigned to you',
    body: 'Lodge the inventory of assets',
    link: '/tasks',
    channels: ['inapp'],
    priority: 'normal',
    readAt: null,
    summaryId: null,
    createdAt: at,
    createdBy: 'system',
    updatedAt: at,
    updatedBy: 'system',
    schemaVersion: 2,
    ...extra,
  };
}

async function signIn(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Inbox Practice' },
    displayName: 'Jordan Fictional',
  });
  const N = `orgs/${orgId}/notifications`;
  await setEmulatorDocuments(request, [
    {
      path: `${N}/n-mention`,
      data: notification(account.uid, 5, {
        kind: 'mention',
        noteId: 'note-1',
        matterId: 'm-gone',
        title: 'Priya mentioned you',
      }),
    },
    { path: `${N}/n-task`, data: notification(account.uid, 10, { title: 'Draft the will for Bram Ostler' }) },
    {
      path: `${N}/n-system`,
      data: notification(account.uid, 15, {
        kind: 'system',
        taskId: undefined,
        title: 'Welcome to the inbox',
        link: '/today',
      }),
    },
    { path: `${N}/n-read`, data: notification(account.uid, 60 * 30, { title: 'Read yesterday', readAt: new Date() }) },
  ]);
  return { orgId, uid: account.uid };
}

const rows = (page: Page) => page.locator('.mt-inbox mt-notification-row');
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

test.describe('inbox', () => {
  test('filters, triages from the keyboard and archives', async ({ page, request }) => {
    test.setTimeout(90_000);
    await signIn(page, request);
    await page.goto('/inbox');
    await expect(rows(page)).toHaveCount(4, LIVE);
    await expect(page.locator('.mt-inbox .mt-chip[data-filter="all"]')).toContainText('All 4');
    // A matter I can't read: it says so, and no inline action opens it.
    await expect(row(page, 'Priya mentioned you')).toContainText('No longer available', LIVE);
    await expectNoA11yViolations(page);

    await page.locator('.mt-inbox .mt-chip[data-filter="mentions"]').click();
    await expect(rows(page)).toHaveCount(1);
    await page.locator('.mt-inbox .mt-chip[data-filter="all"]').click();

    // j to the first row, e reads it, x selects it and the next, y archives both.
    await page.keyboard.press('j');
    await expect(row(page, 'Priya mentioned you')).toBeFocused();
    await page.keyboard.press('e');
    await expect(row(page, 'Priya mentioned you')).not.toHaveAttribute('data-unread', '');
    await page.keyboard.press('x');
    await page.keyboard.press('j');
    await expect(row(page, 'Draft the will for Bram Ostler')).toBeFocused();
    await page.keyboard.press('x');
    await expect(page.locator('.mt-inbox .bulk')).toContainText('2 selected');
    await page.keyboard.press('y');
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('.mt-toaster')).toContainText('2 notifications archived');

    // Undo brings them back.
    await page.locator('.mt-toaster').getByRole('button', { name: 'Undo' }).click();
    await expect(rows(page)).toHaveCount(4, LIVE);

    // Shift+E reads everything listed; the badge goes.
    await page.keyboard.press('Shift+E');
    await expect(page.locator('.mt-inbox mt-notification-row[data-unread]')).toHaveCount(0, LIVE);
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Inbox/ })
        .locator('.mt-nav-count'),
    ).toHaveCount(0, LIVE);

    // Archived ones stay archived after a reload.
    await row(page, 'Read yesterday').click();
    await page.keyboard.press('y');
    await expect(rows(page)).toHaveCount(3);
    // The row hides at once; "Archived" shows only once the write has gone through, so reloading
    // before it can bring the row back.
    await expect(page.locator('.mt-toaster')).toContainText('Archived', LIVE);
    await page.reload();
    await expect(rows(page)).toHaveCount(3, LIVE);
    await expect(row(page, 'Read yesterday')).toHaveCount(0);
  });

  test('the bell lists unread notifications and opens one', async ({ page, request }) => {
    test.setTimeout(60_000);
    await signIn(page, request);
    await page.goto('/today');
    const bell = page.locator('[data-bell]');
    await expect(bell).toHaveAttribute('aria-label', 'Notifications, 3 unread', LIVE);
    await bell.click();
    const popover = page.locator('.mt-bell');
    await expect(popover).toContainText('Welcome to the inbox');
    await expect(popover).not.toContainText('Read yesterday');
    await expectNoA11yViolations(page);
    await popover.locator('mt-notification-row', { hasText: 'Welcome to the inbox' }).click();
    await expect(bell).toHaveAttribute('aria-label', 'Notifications, 2 unread', LIVE);
    await bell.click();
    await popover.getByRole('link', { name: 'Open Inbox' }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  });
});
