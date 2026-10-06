import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_LOAD,
  setEmulatorDocument,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Tasks (CORE-08) against the emulators: quick-add with parsed tokens, completing, keyboard
 * reordering, bulk assignment and creating a task offline that syncs once back online (the
 * `tasks-onWrite` trigger then counts it). Fictional data only.
 */

const URL = '/matters/m-larch/tasks';

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

function taskDoc(orgId: string, uid: string, id: string, title: string, order: number) {
  return {
    path: `orgs/${orgId}/matters/m-larch/tasks/${id}`,
    data: {
      orgId,
      matterId: 'm-larch',
      title,
      status: 'todo',
      priority: 'none',
      checklist: [],
      order,
      source: 'manual',
      countedOpen: true,
      deletedAt: null,
      ...meta(uid),
    },
  };
}

/** A matter with three tasks. */
async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-larch',
    number: 'M-2026-0420',
    title: 'Estate of Wilfred Larch',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake', openTaskCount: 3 } },
    taskDoc(orgId, uid, 't-1', 'Order the death certificate', 1024),
    taskDoc(orgId, uid, 't-2', 'Locate the original will', 2048),
    taskDoc(orgId, uid, 't-3', 'Write to the bank', 3072),
  ]);
}

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Tasks Practice' },
    displayName: 'Jordan Fictional',
  });
  await seed(request, orgId, account.uid);
  // A colleague to assign tasks to.
  const colleague = await createTestAccount(request, {
    claims: { orgId, role: 'lawyer' },
    displayName: 'Priya Fictional',
  });
  await page.goto(URL);
  await expect(page.getByRole('heading', { level: 2, name: 'Tasks' })).toBeVisible(FIRST_LOAD);
  await expect(titles(page)).toHaveCount(3);
  return { orgId, uid: account.uid, colleague: colleague.uid };
}

const titles = (page: Page) => page.locator('mt-task-list .mt-task-title');
const row = (page: Page, title: string) =>
  page.locator('mt-task-list li.row').filter({ has: page.locator('.mt-task-title', { hasText: title }) });

/** A stored document's fields, read through the emulator's admin access. */
async function stored(request: APIRequestContext, path: string): Promise<Record<string, Record<string, unknown>>> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!response.ok()) return {};
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
}

/** The stored tasks of the matter (title → fields). */
async function storedTasks(request: APIRequestContext, orgId: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-larch/tasks?pageSize=100`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as { documents?: { fields: Record<string, Record<string, unknown>> }[] };
  return new Map((body.documents ?? []).map((doc) => [String(doc.fields['title']?.['stringValue']), doc.fields]));
}

test.describe('tasks', () => {
  test('quick-add parses @name, !priority and a due date, then completes the task', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, colleague } = await setUp(page, request);
    await expectNoA11yViolations(page);

    await page.getByRole('button', { name: 'Add task' }).click();
    const field = page.getByRole('textbox', { name: 'New task' });
    await expect(field).toBeFocused();
    await field.fill('Lodge the inventory @priya !high due 15/12/2026 @nobody');
    const quickAdd = page.locator('mt-task-quick-add');
    await expect(quickAdd).toContainText('Assigned to Priya Fictional · High priority · Due 15 Dec 2026');
    await expect(quickAdd).toContainText('No one in the team matches @nobody');
    await expectNoA11yViolations(page);
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(row(page, 'Lodge the inventory @nobody')).toBeVisible();
    await field.press('Escape');
    await expect(quickAdd).toHaveCount(0);

    await expect
      .poll(async () => (await storedTasks(request, orgId)).get('Lodge the inventory @nobody'), { timeout: 20_000 })
      .toMatchObject({
        assigneeUid: { stringValue: colleague },
        priority: { stringValue: 'high' },
        dueDate: { stringValue: '2026-12-15' },
      });

    // tasks-onWrite counts the new task as open.
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/matters/m-larch`))['openTaskCount'], { timeout: 20_000 })
      .toEqual({ integerValue: '4' });

    // Complete it with its checkbox; the trigger takes it off the matter's open count.
    await row(page, 'Lodge the inventory @nobody')
      .getByRole('checkbox', { name: /^Done:/ })
      .click();
    await expect(page.locator('.mt-toaster')).toContainText('Task done');
    await expect(row(page, 'Lodge the inventory @nobody').locator('mt-task-row')).toHaveAttribute('data-done', '');
    await expect
      .poll(async () => (await storedTasks(request, orgId)).get('Lodge the inventory @nobody')?.['status'], {
        timeout: 20_000,
      })
      .toEqual({ stringValue: 'done' });
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/matters/m-larch`))['openTaskCount'], { timeout: 20_000 })
      .toEqual({ integerValue: '3' });
  });

  test('selects tasks and assigns them in bulk', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, colleague } = await setUp(page, request);
    await page.getByRole('checkbox', { name: 'Select Order the death certificate' }).check();
    await page.getByRole('checkbox', { name: 'Select Write to the bank' }).check();
    const bar = page.getByRole('region', { name: 'Selected tasks' });
    await expect(bar).toContainText('2 selected');
    await expectNoA11yViolations(page);
    await bar.getByRole('button', { name: 'Assign' }).click();
    await page.getByRole('menuitem', { name: 'Priya Fictional' }).click();
    await expect(page.locator('.mt-toaster')).toContainText('2 tasks assigned to Priya Fictional');
    await expect
      .poll(
        async () => {
          const tasks = await storedTasks(request, orgId);
          return ['Order the death certificate', 'Locate the original will', 'Write to the bank'].map(
            (title) => tasks.get(title)?.['assigneeUid']?.['stringValue'] ?? null,
          );
        },
        { timeout: 20_000 },
      )
      .toEqual([colleague, null, colleague]);
  });

  test('creates a task offline and syncs it after reconnecting', async ({ page, request, context }) => {
    test.setTimeout(90_000);
    const { orgId } = await setUp(page, request);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Add task' }).click();
    const field = page.getByRole('textbox', { name: 'New task' });
    await field.fill('Call the executor !urgent');
    // The parser was loaded with the tab, so tokens still work offline.
    await expect(page.locator('mt-task-quick-add')).toContainText('Urgent priority');
    await field.press('Enter');
    // Shown straight away from the local cache.
    await expect(row(page, 'Call the executor')).toBeVisible();
    await page.waitForTimeout(500);
    expect((await storedTasks(request, orgId)).has('Call the executor')).toBe(false);

    await context.setOffline(false);
    await expect
      .poll(async () => (await storedTasks(request, orgId)).get('Call the executor')?.['priority'], {
        timeout: 20_000,
      })
      .toEqual({ stringValue: 'urgent' });
    // tasks-onWrite counts it as open.
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/matters/m-larch`))['openTaskCount'], { timeout: 20_000 })
      .toEqual({ integerValue: '4' });
    await page.reload();
    await expect(row(page, 'Call the executor')).toBeVisible(FIRST_LOAD);
  });
});

test.describe('tasks with the keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'Keyboard shortcuts are desktop features');

  test('c opens quick-add; Alt+Down moves a task, announced and saved; x and Space work', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId } = await setUp(page, request);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);

    await page.keyboard.press('c');
    await expect(page.getByRole('textbox', { name: 'New task' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('mt-task-quick-add')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add task' })).toBeFocused();

    // j jumps into the list; Alt+Down moves the focused task.
    await page.keyboard.press('j');
    await expect(page.getByRole('button', { name: 'Edit title: Order the death certificate' })).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(titles(page)).toHaveText([
      'Locate the original will',
      'Order the death certificate',
      'Write to the bank',
    ]);
    await expect(page.locator('mt-task-list [aria-live="polite"]')).toHaveText(
      'Moved Order the death certificate to position 2 of 3 in Other tasks.',
    );
    await expect(page.getByRole('button', { name: 'Edit title: Order the death certificate' })).toBeFocused();
    await expect
      .poll(
        async () => {
          const tasks = await storedTasks(request, orgId);
          const order = (title: string) => Number(Object.values(tasks.get(title)?.['order'] ?? {})[0]);
          return order('Order the death certificate') > order('Locate the original will');
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // x selects; Space completes.
    await page.keyboard.press('x');
    await expect(page.getByRole('region', { name: 'Selected tasks' })).toContainText('1 selected');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Selected tasks' })).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(page.locator('.mt-toaster')).toContainText('Task done');

    await page.reload();
    await expect(titles(page)).toHaveText(
      ['Locate the original will', 'Order the death certificate', 'Write to the bank'],
      FIRST_LOAD,
    );
  });
});

test.describe('my tasks', () => {
  test('lists my tasks by due date and adds a personal task', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await setUp(page, request);
    await setEmulatorDocument(request, `orgs/${orgId}/matters/m-larch/tasks/t-mine`, {
      ...taskDoc(orgId, uid, 't-mine', 'Review the draft affidavit', 4096).data,
      assigneeUid: uid,
    });
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^No date/ })).toBeVisible();
    await expect(row(page, 'Review the draft affidavit')).toContainText('M-2026-0420');

    await page.getByRole('button', { name: 'Add personal task' }).click();
    const field = page.getByRole('textbox', { name: 'New personal task' });
    await field.fill('Renew my practising certificate !low');
    await field.press('Enter');
    await expect(row(page, 'Renew my practising certificate')).toContainText('Personal');
    await expectNoA11yViolations(page);

    // Today's short list (CORE-14): the personal task has no date, so it's on My tasks only.
    await page.goto('/today');
    const today = page.getByRole('region', { name: 'My tasks' });
    await expect(today).toContainText('No open tasks with a date', FIRST_LOAD);
    await expectNoA11yViolations(page);
  });
});
