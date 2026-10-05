import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { setEmulatorDocument, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { uniqueOrg } from './support/matters';

/**
 * Notifications in the shell (FND-20) against the emulators: the unread count on Inbox, and a
 * toast when an urgent one arrives while the app is open. The inbox itself is CORE-22. Fictional
 * data only.
 */

/** The badge waits for the page's own reads, then the emulators answer. */
const BADGE = { timeout: 20_000 };

function notification(uid: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    kind: 'task_assigned',
    taskId: 't-1',
    matterId: 'm-1',
    recipientUid: uid,
    title: 'Task assigned to you',
    body: 'Lodge the inventory of assets',
    link: '/tasks',
    channels: ['inapp', 'email'],
    priority: 'normal',
    readAt: null,
    summaryId: null,
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: 2,
    ...extra,
  };
}

async function signIn(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Notice Practice' },
    displayName: 'Jordan Fictional',
  });
  return { orgId, uid: account.uid };
}

const inboxCount = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Inbox/ })
    .locator('.mt-nav-count');

test.describe('notifications', () => {
  test('counts my unread in-app notifications on Inbox and toasts an urgent arrival', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await signIn(page, request);
    const N = `orgs/${orgId}/notifications`;
    await setEmulatorDocuments(request, [
      { path: `${N}/n-1`, data: notification(uid) },
      { path: `${N}/n-2`, data: notification(uid, { kind: 'mention', title: 'You were mentioned' }) },
      { path: `${N}/n-read`, data: notification(uid, { readAt: new Date() }) },
      { path: `${N}/n-email`, data: notification(uid, { channels: ['email'] }) },
      { path: `${N}/n-burst`, data: notification(uid, { summaryId: 'burst-x' }) },
      { path: `${N}/n-other`, data: notification('someone-else') },
    ]);
    await page.goto('/today');
    await expect(inboxCount(page)).toHaveText('2', BADGE);

    // An urgent one arrives while the app is open.
    await setEmulatorDocument(
      request,
      `${N}/n-urgent`,
      notification(uid, {
        kind: 'conflict_alert',
        checkId: 'check-1',
        contactId: 'c-1',
        priority: 'high',
        title: 'Possible conflict on M-2026-0042',
        body: 'A party just added is on other matters. Review the conflict check.',
        link: '/matters',
      }),
    );
    const toast = page.locator('.mt-toaster');
    await expect(toast).toContainText('Possible conflict on M-2026-0042', BADGE);
    await expect(inboxCount(page)).toHaveText('3');
    await toast.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/matters$/);
  });

  test('nothing toasts for what was there on load, and the count goes once read', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { orgId, uid } = await signIn(page, request);
    const N = `orgs/${orgId}/notifications`;
    await setEmulatorDocuments(request, [
      { path: `${N}/n-waiting`, data: notification(uid, { priority: 'critical', title: 'Waiting since yesterday' }) },
      { path: `${N}/n-old`, data: notification(uid, { priority: 'critical', readAt: new Date(), title: 'Handled' }) },
    ]);
    await page.goto('/today');
    await expect(inboxCount(page)).toHaveText('1', BADGE);
    await expect(page.locator('.mt-toaster')).not.toContainText('Waiting since yesterday');

    // Read elsewhere (the inbox, another device): the count goes.
    await setEmulatorDocument(
      request,
      `${N}/n-waiting`,
      notification(uid, { priority: 'critical', title: 'Waiting since yesterday', readAt: new Date() }),
    );
    await expect(inboxCount(page)).toHaveCount(0, BADGE);
  });
});
