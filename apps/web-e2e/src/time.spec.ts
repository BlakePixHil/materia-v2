import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  setEmulatorDocument,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Time entries (BILL-01) against the emulators: recording time three ways (the Time tab's add row
 * with `t`, quick entry with `t` on another tab, ⌘K "Log time"), editing a draft, filtering by
 * person, and `time-onWrite` pricing each entry and counting it into the matter's WIP. Keyboard
 * only. Fictional data only.
 */

const URL = '/matters/m-quill/time';

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** Today in Melbourne (the org's time zone), as entries store it. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
}

async function seed(request: APIRequestContext, orgId: string, uid: string, colleague: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0510',
    title: 'Estate of Harriet Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Time Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
      },
    },
    // WIP so far: the colleague's entry below.
    { ...matter, data: { ...matter.data, wipCents: 30000 } },
    // A colleague's entry from earlier in the week (counted into WIP already).
    {
      path: `orgs/${orgId}/matters/m-quill/timeEntries/te-colleague`,
      data: {
        orgId,
        matterId: 'm-quill',
        uid: colleague,
        date: '2026-09-29',
        minutes: 60,
        units: 10,
        rateCents: 30000,
        amountCents: 30000,
        narrative: 'Attendance on executor at Geelong office',
        billable: true,
        status: 'draft',
        source: 'manual',
        wipCountedCents: 30000,
        deletedAt: null,
        ...meta(colleague),
      },
    },
  ]);
  // My rate.
  await setEmulatorDocument(request, `orgs/${orgId}/members/${uid}`, {
    role: 'lawyer',
    status: 'active',
    email: `${uid}@example.test`,
    displayName: 'Jordan Fictional',
    defaultRateCents: 44000,
    rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }],
  });
}

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Time Practice' },
    displayName: 'Jordan Fictional',
  });
  const colleague = await createTestAccount(request, {
    claims: { orgId, role: 'lawyer' },
    displayName: 'Priya Fictional',
  });
  await seed(request, orgId, account.uid, colleague.uid);
  await page.goto(URL);
  await expect(page.getByRole('heading', { level: 2, name: 'Time' })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  return { orgId, uid: account.uid };
}

const rows = (page: Page) => page.locator('mt-matter-time .rows mt-time-entry');
const addRow = (page: Page) => page.locator('mt-matter-time .add');

/** The stored entries of the matter (narrative → fields). */
async function storedEntries(request: APIRequestContext, orgId: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-quill/timeEntries?pageSize=100`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as { documents?: { fields: Record<string, Record<string, unknown>> }[] };
  return new Map((body.documents ?? []).map((doc) => [String(doc.fields['narrative']?.['stringValue']), doc.fields]));
}

/**
 * Entries are written in the background (offline-first), so a full page load straight after one can
 * drop the write still in flight. Waits until the matter has `count` stored entries.
 */
async function expectStored(request: APIRequestContext, orgId: string, count: number): Promise<void> {
  await expect.poll(async () => (await storedEntries(request, orgId)).size, { timeout: 20_000 }).toBe(count);
}

async function wip(request: APIRequestContext, orgId: string): Promise<unknown> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-quill`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields?.['wipCents'];
}

test.describe('time entries', () => {
  test('records time three ways by keyboard; the trigger prices it and counts WIP', async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(isMobile, 'The t shortcut and ⌘K are desktop features');
    test.setTimeout(120_000);
    const { orgId } = await setUp(page, request);
    const seeded = (await storedEntries(request, orgId)).size;
    await expectNoA11yViolations(page);

    // 1. The Time tab's add row: `t` focuses the duration; 0.25 is 15 minutes, 3 units.
    await page.keyboard.press('t');
    const duration = addRow(page).getByRole('textbox', { name: 'Time' });
    await expect(duration).toBeFocused();
    await duration.fill('0.25');
    await expect(addRow(page)).toContainText('0.3 h');
    await expect(addRow(page)).toContainText('$132.00');
    await page.keyboard.press('Tab');
    const narrative = addRow(page).getByRole('combobox', { name: 'Narrative' });
    await expect(narrative).toBeFocused();
    // The phrase library on `/`.
    await narrative.pressSequentially('/perus');
    await expect(addRow(page).getByRole('listbox', { name: 'Phrases' })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press('Enter');
    await narrative.pressSequentially('the will');
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('mt-matter-time .day').first()).toContainText('Today');
    await expectStored(request, orgId, seeded + 1);

    // 2. Quick entry with `t` from another tab of the matter: the matter is picked already.
    await page.goto('/matters/m-quill/overview');
    await expect(page.getByRole('heading', { name: 'Estate of Harriet Quill' })).toBeVisible();
    await page.keyboard.press('t');
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('M-2026-0510');
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeFocused();
    await expectNoA11yViolations(page);
    await page.keyboard.type('1h 12m');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Letter to beneficiaries');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expectStored(request, orgId, seeded + 2);

    // 3. ⌘K "Log time" from the Matters list: pick the matter (recent first), then the time.
    await page.goto('/matters');
    await expect(page.getByRole('table', { name: 'Matters' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('log time');
    await expect(page.getByRole('option').first()).toContainText('Log time');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('searchbox', { name: 'Matter' }).fill('quill');
    await dialog.getByRole('button', { name: /M-2026-0510/ }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('textbox', { name: 'Time' })).toBeFocused();
    await page.keyboard.type('18m');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Telephone attendance on bank');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);

    // time-onWrite priced each one at my rate and counted it: 30000 + 13200 + 52800 + 13200.
    await expect
      .poll(async () => (await storedEntries(request, orgId)).get('Letter to beneficiaries'), { timeout: 30_000 })
      .toMatchObject({
        minutes: { integerValue: '72' },
        units: { integerValue: '12' },
        amountCents: { integerValue: '52800' },
        wipCountedCents: { integerValue: '52800' },
      });
    await expect.poll(() => wip(request, orgId), { timeout: 30_000 }).toEqual({ integerValue: '109200' });
  });

  test('edits a draft and filters by person', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await setUp(page, request);
    // An entry of mine to edit.
    await setEmulatorDocument(request, `orgs/${orgId}/matters/m-quill/timeEntries/te-mine`, {
      orgId,
      matterId: 'm-quill',
      uid,
      date: today(),
      minutes: 18,
      units: 3,
      rateCents: 44000,
      amountCents: 13200,
      narrative: 'Perusing and considering the will',
      billable: true,
      status: 'draft',
      source: 'manual',
      wipCountedCents: 13200,
      deletedAt: null,
      ...meta(uid),
    });
    await expect(rows(page)).toHaveCount(2);

    // Edit from the row's menu.
    await page.getByRole('button', { name: 'More actions for Perusing and considering the will' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const form = page.getByRole('form', { name: 'Edit time' });
    await expect(form).toBeVisible();
    await form.getByRole('textbox', { name: 'Time' }).fill('30m');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveCount(0);
    await expect(rows(page).filter({ hasText: 'Perusing and considering the will' })).toContainText('30m');
    await expect
      .poll(async () => (await storedEntries(request, orgId)).get('Perusing and considering the will'), {
        timeout: 30_000,
      })
      .toMatchObject({ units: { integerValue: '5' }, amountCents: { integerValue: '22000' } });

    // Filter by person.
    await page.getByLabel('Person').selectOption({ label: 'Priya Fictional' });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('Attendance on executor at Geelong office');
    await expect(page.getByTestId('time-totals')).toHaveText('1.0 h · $300.00');
    await expectNoA11yViolations(page);
  });
});
