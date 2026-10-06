import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { suggestionBasis, suggestionBasisParts } from '@materia/domain';
import { expectNoA11yViolations, setEmulatorDocuments, setOrgFlags, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The Inbox (CORE-22) against the emulators: filters, keyboard triage, archive, the bell, and
 * reviewing a Clerk suggestion in place (CORE-22a). Fictional data only.
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

/** A matter with a Clerk suggestion on it (as `proposeSuggestions` stores it) and its notification. */
async function signInWithSuggestion(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'clerk.features.suggestions': true });
  const { uid } = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Inbox Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedClient(request, orgId, uid);
  const seeded = matterDoc(orgId, uid, {
    id: 'm-marlow',
    number: 'M-2026-0412',
    title: 'Estate of Edwin Marlow',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const matter = { ...seeded.data, stageId: 'intake' };
  const now = new Date();
  const payload = { title: 'Order a valuation of 9 Fictional Lane', priority: 'medium' };
  const { basis, parts } = suggestionBasis(
    suggestionBasisParts({ kind: 'task', payload, citations: [] }, { matter, documents: {} }),
  );
  await setEmulatorDocuments(request, [
    { path: seeded.path, data: matter },
    {
      path: `${seeded.path}/suggestions/s-valuation`,
      data: {
        kind: 'task',
        payload,
        citations: [],
        rationale: 'The will leaves the house to the residuary beneficiaries.',
        status: 'proposed',
        promptId: 'suggest-matter',
        promptVersion: '1.0.0',
        model: 'test-model',
        privileged: false,
        basis,
        basisParts: parts,
        dedupeKey: `task:${JSON.stringify(payload)}`,
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
        orgId,
        matterId: 'm-marlow',
        createdAt: now,
        createdBy: 'clerk',
        updatedAt: now,
        updatedBy: 'clerk',
        schemaVersion: 1,
      },
    },
    {
      path: `orgs/${orgId}/notifications/n-suggest`,
      data: notification(uid, 5, {
        kind: 'suggestion',
        taskId: undefined,
        matterId: 'm-marlow',
        suggestionId: 's-valuation',
        title: 'Clerk suggests a task on M-2026-0412',
        link: '/matters/m-marlow/overview',
      }),
    },
  ]);
}

const rows = (page: Page) => page.locator('.mt-inbox mt-notification-row');
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

test.describe('inbox', () => {
  test('filters, triages from the keyboard and archives', async ({ page, request }) => {
    test.setTimeout(90_000);
    await signIn(page, request);
    // Arrive from a page with buttons on it, so the button styles load before the Inbox's own.
    await page.goto('/today');
    await expect(page.getByRole('link', { name: 'New matter' })).toBeVisible(LIVE);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Inbox/ })
      .click();
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
    // A hovered action takes the light hover fill with dark text, like the other bulk bars, not the
    // bar's white text.
    const bar = page.locator('.mt-inbox .bulk');
    const markRead = bar.getByRole('button', { name: /Mark read/ });
    await markRead.hover();
    await expect(markRead).toHaveAttribute('data-hover', '');
    const barColor = await bar.evaluate((el) => getComputedStyle(el).color);
    await expect(markRead).not.toHaveCSS('color', barColor);
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
    // Focused rather than clicked: on a phone a tap opens the notification.
    await row(page, 'Read yesterday').focus();
    await page.keyboard.press('y');
    await expect(rows(page)).toHaveCount(3);
    // The row hides at once; "Archived" shows only once the write has gone through, so reloading
    // before it can bring the row back.
    await expect(page.locator('.mt-toaster')).toContainText('Archived', LIVE);
    await page.reload();
    await expect(rows(page)).toHaveCount(3, LIVE);
    await expect(row(page, 'Read yesterday')).toHaveCount(0);
  });

  test('the bell lists unread notifications and opens one', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'The bell is in the desktop top bar; phones reach the Inbox from the TabBar');
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

  test('reviews a Clerk suggestion without leaving the Inbox (CORE-22a)', async ({ page, request }) => {
    test.setTimeout(120_000);
    await signInWithSuggestion(page, request);
    await page.goto('/inbox');
    const notice = row(page, 'Clerk suggests a task');
    await expect(notice).toBeVisible(LIVE);
    // Wide: the suggestion shows beside the list. Narrow: in a dialog.
    await notice.getByRole('button', { name: 'Review' }).click();
    const card = page.locator('mt-inbox-suggestion mt-suggestion-card');
    await expect(card).toContainText('Order a valuation of 9 Fictional Lane', LIVE);
    await expectNoA11yViolations(page);
    await card.getByRole('button', { name: 'Add task' }).click();
    await expect(page.locator('.mt-toaster')).toContainText('Suggestion accepted', { timeout: 30_000 });
    await expect(notice).toContainText('You accepted it', LIVE);
    await expect(notice).not.toHaveAttribute('data-unread', '');
    await expect(page).toHaveURL(/\/inbox$/);
  });
});
