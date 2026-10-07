import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { addDays, recentMatterId, today } from '@materia/domain';
import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Today (CORE-14) against the emulators: an overdue deadline and a pending change under Needs
 * attention, today's deadline and task under Due today and this week, a clear day, a new practice's
 * checklist, the keyboard, the matters opened lately, the device-time-zone hint, and the screen
 * staying up when the connection drops. Fictional data only.
 */

const ZONE = 'Australia/Melbourne';
test.use({ timezoneId: ZONE });

const TODAY = today(ZONE);
const MATTER_NUMBER = 'M-2026-0614';

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

function deadlineDoc(orgId: string, uid: string, id: string, title: string, dueDate: string) {
  return {
    path: `orgs/${orgId}/matters/m-pell/deadlines/${id}`,
    data: {
      orgId,
      matterId: 'm-pell',
      title,
      dueDate,
      kind: 'internal',
      critical: false,
      status: 'upcoming',
      assigneeUid: uid,
      reminders: [],
      pastOnCreation: false,
      deletedAt: null,
      ...meta(uid),
    },
  };
}

function taskDoc(orgId: string, uid: string, id: string, title: string, dueDate: string) {
  return {
    path: `orgs/${orgId}/matters/m-pell/tasks/${id}`,
    data: {
      orgId,
      matterId: 'm-pell',
      title,
      dueDate,
      status: 'todo',
      priority: 'high',
      checklist: [],
      order: 1024,
      source: 'manual',
      countedOpen: true,
      assigneeUid: uid,
      deletedAt: null,
      ...meta(uid),
    },
  };
}

/** A matter of mine with an overdue deadline, a change to review, and a deadline and a task due today. */
async function seedDay(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-pell',
    number: MATTER_NUMBER,
    title: 'Estate of Harold Pell',
    responsibleUid: uid,
    daysAgo: 2,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake', openTaskCount: 1 } },
    deadlineDoc(orgId, uid, 'd-late', 'Lodge the inventory of assets', addDays(TODAY, -3)),
    deadlineDoc(orgId, uid, 'd-today', 'Send the costs disclosure update', TODAY),
    taskDoc(orgId, uid, 't-today', 'Call the executor about the bank accounts', TODAY),
    {
      path: `orgs/${orgId}/matters/m-pell/deadlineChanges/c-advert`,
      data: {
        orgId,
        matterId: 'm-pell',
        deadlineId: 'd-today',
        ruleId: 'org.costs_update',
        title: 'Send the costs disclosure update',
        critical: false,
        kind: 'moved',
        cause: 'event',
        status: 'pending',
        fromDueDate: TODAY,
        toDueDate: addDays(TODAY, 7),
        earlier: false,
        intoPast: false,
        assigneeUid: uid,
        recomputeVersion: 1,
        ...meta(uid),
      },
    },
  ]);
}

async function signIn(page: Page, request: APIRequestContext, role: 'lawyer' | 'owner' = 'lawyer') {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role, orgName: 'Fictional Today Practice' },
    displayName: 'Jordan Fictional',
  });
  return { orgId, uid: account.uid };
}

const region = (page: Page, name: string) => page.getByRole('region', { name });
const greeting = (page: Page) =>
  page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Jordan$/ });

/** Whether the server has my Recent matters entry for a matter (read with the emulator's admin access). */
async function storedRecent(
  request: APIRequestContext,
  orgId: string,
  uid: string,
  matterId: string,
): Promise<boolean> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/users/${uid}/recent/${recentMatterId(orgId, matterId)}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  return response.ok();
}

async function storedTaskStatus(request: APIRequestContext, orgId: string): Promise<string | undefined> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-pell/tasks/t-today`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as { fields?: { status?: { stringValue?: string } } };
  return body.fields?.status?.stringValue;
}

test.describe('today', () => {
  test('shows what is overdue and what is due today', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await signIn(page, request);
    await seedDay(request, orgId, uid);
    await page.goto('/today');
    await expect(greeting(page)).toBeVisible();
    await expect(page.locator('[data-zone-hint]')).toHaveCount(0);

    const attention = region(page, 'Needs attention');
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeVisible(
      FIRST_LOAD,
    );
    await expect(
      attention.getByRole('link', { name: 'Change to review: Send the costs disclosure update' }),
    ).toBeVisible();
    await expect(attention).toContainText(`${MATTER_NUMBER} · Estate of Harold Pell`);

    const due = region(page, 'Due today and this week');
    await expect(due.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(due.getByRole('link', { name: 'Deadline: Send the costs disclosure update' })).toBeVisible();
    await expect(due.getByRole('link', { name: 'Task: Call the executor about the bank accounts' })).toBeVisible();

    await expect(region(page, 'My tasks')).toContainText('Call the executor about the bank accounts');
    await expect(page.locator('[data-stat="open-matters"] .v')).toHaveText('1');
    await expect(page.locator('[data-stat="deadlines"] .v')).toHaveText('1');
    await expect(page.locator('[data-stat="deadlines"] .f')).toHaveText('1 overdue');
    await expectNoA11yViolations(page);
  });

  test('moves through the day with j and k, and completes a task with Space', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await signIn(page, request);
    await seedDay(request, orgId, uid);
    await page.goto('/today');
    const attention = region(page, 'Needs attention');
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeVisible(
      FIRST_LOAD,
    );
    await expect(region(page, 'My tasks')).toContainText('Call the executor about the bank accounts');

    await page.keyboard.press('j');
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeFocused();
    await page.keyboard.press('j');
    await expect(
      attention.getByRole('link', { name: 'Change to review: Send the costs disclosure update' }),
    ).toBeFocused();
    await page.keyboard.press('j');
    const task = region(page, 'My tasks').getByRole('button', {
      name: 'Call the executor about the bank accounts',
      exact: true,
    });
    await expect(task).toBeFocused();
    await page.keyboard.press('k');
    await expect(
      attention.getByRole('link', { name: 'Change to review: Send the costs disclosure update' }),
    ).toBeFocused();
    await page.keyboard.press('j');
    await expect(task).toBeFocused();

    await page.keyboard.press('Space');
    await expect(page.locator('.mt-toaster')).toContainText('Task done');
    await expect.poll(() => storedTaskStatus(request, orgId), { timeout: 20_000 }).toBe('done');
    await expect(region(page, 'My tasks')).not.toContainText('Call the executor about the bank accounts');

    // Enter opens the focused row.
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-pell\/deadlines$/);
  });

  test('celebrates a clear day', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { orgId, uid } = await signIn(page, request);
    await seedClient(request, orgId, uid);
    await setEmulatorDocuments(request, [
      matterDoc(orgId, uid, {
        id: 'm-quiet',
        number: 'M-2026-0615',
        title: 'Will for Ada Quiet',
        responsibleUid: uid,
        daysAgo: 5,
      }),
    ]);
    await page.goto('/today');
    await expect(greeting(page)).toBeVisible();
    await expect(region(page, 'Needs attention')).toContainText('Nothing needs attention', FIRST_LOAD);
    await expect(region(page, 'Due today and this week')).toContainText('Your week is clear');
    await expect(page.locator('.mt-today')).not.toContainText('!');
    await expect(page.locator('[data-section="onboarding"]')).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('gives a new practice a checklist', async ({ page, request }) => {
    test.setTimeout(60_000);
    await signIn(page, request, 'owner');
    await page.goto('/today');
    const checklist = page.getByRole('region', { name: 'Set up your practice' });
    await expect(checklist).toBeVisible(FIRST_LOAD);
    await expect(checklist.getByRole('link', { name: 'Create a matter' })).toHaveAttribute('href', '/matters/new');
    await expect(checklist.getByRole('link', { name: 'Invite people' })).toHaveAttribute('href', '/settings/team');
    await expect(checklist.getByRole('button', { name: 'Connect a calendar' })).toBeDisabled();
    await expect(checklist).toContainText('Coming soon');
    await expectNoA11yViolations(page);
  });

  test('lists the matters I opened lately', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { orgId, uid } = await signIn(page, request);
    await seedDay(request, orgId, uid);
    await page.goto('/matters/m-pell/overview');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Harold Pell', FIRST_LOAD);
    // Opening a matter records it without waiting; a full page load before the write reaches the
    // server would drop it, so wait for the server to have it first.
    await expect.poll(() => storedRecent(request, orgId, uid, 'm-pell'), FIRST_LOAD).toBe(true);
    await page.goto('/today');
    await expect(region(page, 'Recent matters').getByRole('link', { name: /Estate of Harold Pell/ })).toBeVisible(
      FIRST_LOAD,
    );
  });

  test('keeps showing the day when the connection drops', async ({ page, request, context }) => {
    test.setTimeout(60_000);
    const { orgId, uid } = await signIn(page, request);
    await seedDay(request, orgId, uid);
    await page.goto('/today');
    const attention = region(page, 'Needs attention');
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeVisible(
      FIRST_LOAD,
    );
    await expect(region(page, 'My tasks')).toContainText('Call the executor about the bank accounts');

    await context.setOffline(true);
    await expect(page.locator('[data-offline]')).toContainText('You’re offline');
    // Back to the tab while offline: nothing is cleared.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(attention.getByRole('link', { name: 'Overdue: Lodge the inventory of assets' })).toBeVisible();
    await expect(region(page, 'My tasks')).toContainText('Call the executor about the bank accounts');
    await expectNoA11yViolations(page);
    await context.setOffline(false);
    await expect(page.locator('[data-offline]')).toHaveCount(0);
  });
});

test.describe('today on a device in another time zone', () => {
  test.use({ timezoneId: 'Europe/London' });

  test('says the dates follow the practice’s time zone', async ({ page, request }) => {
    test.setTimeout(60_000);
    await signIn(page, request);
    await page.goto('/today');
    await expect(page.locator('[data-zone-hint]')).toHaveText(
      'Dates follow Melbourne time, the practice’s time zone. This device is on London time.',
      FIRST_LOAD,
    );
    await expectNoA11yViolations(page);
  });
});
