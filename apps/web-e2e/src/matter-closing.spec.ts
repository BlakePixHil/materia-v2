import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoA11yViolations, FIRST_CALL, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';
import { matterTabs } from './support/phone';

/**
 * Closing a matter (CORE-19) against the emulators: the closing checklist through the real
 * `matters-closingChecklist` and `matters-close` callables (bulk-cancelling the open task and
 * overriding the unbilled WIP with a reason, CORE-19b), the
 * read-only closed state with its banner, then reopening with a reason. Fictional data only.
 */

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-fern',
    number: 'M-2026-0519',
    title: 'Estate of Hollis Fern',
    responsibleUid: uid,
    daysAgo: 3,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, openTaskCount: 1 } },
    {
      path: `orgs/${orgId}/matters/m-fern/tasks/t-1`,
      data: {
        orgId,
        matterId: 'm-fern',
        title: 'Send the fictional final account',
        status: 'todo',
        priority: 'none',
        checklist: [],
        order: 1024,
        source: 'manual',
        countedOpen: true,
        deletedAt: null,
        ...meta(uid),
      },
    },
  ]);
}

/**
 * The answer to a POST to the callable `name`. Its first call starts the function's worker in the
 * emulator, which on a busy runner has taken longer than the UI check's timeout: wait for the
 * server's answer itself, then the UI check after it keeps its own timeout.
 */
const answered = (page: Page, name: string) =>
  page.waitForResponse((res) => res.url().endsWith(`/${name}`) && res.request().method() === 'POST', FIRST_CALL);

/** A checkbox in the close dialog, by its label. */
const checkbox = (page: Page, label: string) =>
  page.getByRole('dialog').locator('mt-checkbox', { hasText: label }).getByRole('checkbox');

test.describe('closing a matter', () => {
  test('close with the checklist, then reopen', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Closing Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);

    await page.goto('/matters/m-fern/overview');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Hollis Fern');

    // The checklist: one open task, the fixture's $1,200 of unbilled time, nothing answered yet.
    await page.getByRole('button', { name: 'More matter actions' }).click();
    const checked = answered(page, 'matters-closingChecklist');
    await page.getByRole('menuitem', { name: 'Close matter…' }).click();
    await checked;
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('1 task still open.');
    await expect(dialog).toContainText('$1,200.00 of time and disbursements not yet billed');
    await expect(dialog).toContainText(/Kept until at least .* \(7 years\)/);
    const close = dialog.getByRole('button', { name: 'Close matter' });
    await expect(close).toBeDisabled();
    await expectNoA11yViolations(page);

    await checkbox(page, 'Cancel the 1 open task when closing').click();
    await dialog.getByLabel('Why cancel them').fill('Superseded by the final account');
    await dialog.getByRole('radio', { name: 'We hold no originals' }).click();
    await expect(dialog).toContainText('Original documents returned or in safe custody. Done');
    await checkbox(page, 'Closing letter sent').click();
    await checkbox(page, 'Final distribution recorded').click();
    await dialog.getByLabel('Reason for closing').fill('Estate fully administered');
    await expect(close).toBeDisabled();
    await dialog.getByLabel('Or say why it won’t be billed').fill('Written off by agreement with the executor');
    await expect(dialog).toContainText('No unbilled WIP. Skipped with a reason');
    await expect(close).toBeEnabled();
    const closed = answered(page, 'matters-close');
    await close.click();
    await closed;

    // Closed: a banner, the status, and nothing editable. (The emulator starts the function on its
    // first call, which can take a while.)
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    const banner = page.locator('mt-note.closed');
    await expect(banner).toContainText('Closed on');
    await expect(banner).toContainText('read-only apart from notes');
    await expect(page.getByRole('button', { name: 'Status: Closed. Change status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit title' })).toHaveCount(0);
    const tabs = matterTabs(page);
    await tabs.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('button', { name: /Add task/ })).toHaveCount(0);
    await expectNoA11yViolations(page);

    // Reopen with a reason.
    await page.getByRole('button', { name: 'Status: Closed. Change status' }).click();
    await page.getByRole('menuitem', { name: 'Reopen…' }).click();
    await page.getByRole('dialog').getByLabel('Reason').fill('Further fictional assets found');
    const reopened = answered(page, 'matters-reopen');
    await page.getByRole('dialog').getByRole('button', { name: 'Reopen matter' }).click();
    await reopened;
    await expect(page.getByRole('button', { name: 'Status: Open. Change status' })).toBeVisible({ timeout: 20_000 });
    await expect(banner).toBeHidden();
    await tabs.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('button', { name: 'Edit title' })).toBeVisible();
  });
});
