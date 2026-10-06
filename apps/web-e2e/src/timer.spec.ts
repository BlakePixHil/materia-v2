import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  setEmulatorDocument,
  setEmulatorDocuments,
  signInAsTestUser,
  signInThroughUi,
  type TestAccount,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The global timer (BILL-02) against the emulators: start from a matter, still there after a reload
 * and on a second device (a second browser context), switch with "Stop and save" and "Discard",
 * stop and save a draft entry (`time-stopTimer`, `source: 'timer'`, rounded units), the forgotten
 * banner, and the idle question on a fake clock. Fictional data only.
 */

const MIN = 60_000;
const DOCS = `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;
const ADMIN = { headers: { Authorization: 'Bearer owner' } };

const widget = (page: Page) => page.locator('mt-timer-widget');
const header = (page: Page) => page.locator('mt-matter-header');

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Timer Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
      },
    },
    matterDoc(orgId, uid, {
      id: 'm-quill',
      number: 'M-2026-0510',
      title: 'Estate of Harriet Quill',
      responsibleUid: uid,
      daysAgo: 1,
    }),
    matterDoc(orgId, uid, {
      id: 'm-wren',
      number: 'M-2026-0511',
      title: 'Wren v Fictional Holdings',
      responsibleUid: uid,
      daysAgo: 2,
    }),
  ]);
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
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Timer Practice' },
    displayName: 'Jordan Fictional',
  });
  await seed(request, orgId, account.uid);
  return { orgId, account };
}

type Fields = Record<string, Record<string, unknown>>;

async function storedTimer(request: APIRequestContext, uid: string): Promise<Fields | null> {
  const response = await request.get(`${DOCS}/users/${uid}/timer/current`, ADMIN);
  if (response.status() === 404) return null;
  return ((await response.json()) as { fields?: Fields }).fields ?? null;
}

async function entries(request: APIRequestContext, orgId: string, matterId: string): Promise<Fields[]> {
  const response = await request.get(`${DOCS}/orgs/${orgId}/matters/${matterId}/timeEntries?pageSize=50`, ADMIN);
  return ((await response.json()) as { documents?: { fields: Fields }[] }).documents?.map((d) => d.fields) ?? [];
}

/** A running timer as the app stores it, started `ago` ms before now (server time). */
async function seedTimer(
  request: APIRequestContext,
  orgId: string,
  uid: string,
  matter: { id: string; number: string },
  ago: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = Date.now();
  await setEmulatorDocument(request, `users/${uid}/timer/current`, {
    orgId,
    matterId: matter.id,
    matterNumber: matter.number,
    startedAt: new Date(now - ago),
    accumulatedMs: 0,
    running: true,
    narrativeDraft: '',
    lastHeartbeatAt: new Date(now),
    createdAt: new Date(now - ago),
    createdBy: uid,
    updatedAt: new Date(now),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });
}

async function openMatter(page: Page, id: string, title: string) {
  await page.goto(`/matters/${id}/overview`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 });
}

test.describe('global timer', () => {
  test('start, reload, a second device, switch, stop and save', async ({ page, request, browser, isMobile }) => {
    test.skip(isMobile, 'Switching lives in the desktop widget; phones get pause and stop');
    test.setTimeout(180_000);
    const { orgId, account } = await setUp(page, request);
    const uid = account.uid;

    // Start from the matter header.
    await openMatter(page, 'm-quill', 'Estate of Harriet Quill');
    await header(page)
      .getByRole('button', { name: /^Start timer/ })
      .click();
    await expect(widget(page).getByTestId('timer-matter')).toHaveText('M-2026-0510');
    await expect(widget(page).getByTestId('timer-elapsed')).toHaveText(/^00:0\d$/);
    await expect(widget(page).getByTestId('timer-elapsed')).toHaveAttribute('aria-live', 'off');
    await expect(header(page).getByRole('button', { name: /^Pause timer/ })).toBeVisible();
    await expect
      .poll(() => storedTimer(request, uid), { timeout: 20_000 })
      .toMatchObject({
        matterId: { stringValue: 'm-quill' },
        running: { booleanValue: true },
      });
    await expectNoA11yViolations(page);

    // It survives a reload.
    await page.reload();
    await expect(widget(page).getByTestId('timer-matter')).toHaveText('M-2026-0510', { timeout: 20_000 });

    // And shows on a second device.
    const other = await secondDevice(browser, account);
    await expect(widget(other).getByTestId('timer-matter')).toHaveText('M-2026-0510', { timeout: 20_000 });

    // 24 minutes later (moved back on the server), on both.
    await seedTimer(request, orgId, uid, { id: 'm-quill', number: 'M-2026-0510' }, 23 * MIN + 45_000);
    await expect(widget(page).getByTestId('timer-elapsed')).toHaveText(/^2[34]:\d\d$/, { timeout: 20_000 });
    await expect(widget(other).getByTestId('timer-elapsed')).toHaveText(/^2[34]:\d\d$/, { timeout: 20_000 });

    // Starting on another matter asks first: stop and save the 0.4 h.
    await openMatter(page, 'm-wren', 'Wren v Fictional Holdings');
    await header(page)
      .getByRole('button', { name: /^Start timer/ })
      .click();
    const ask = page.getByRole('dialog', { name: 'Stop and save M-2026-0510 (0.4)?' });
    await expect(ask).toBeVisible();
    await expectNoA11yViolations(page);
    await ask.getByRole('button', { name: 'Stop and save' }).click();
    // The first time-stopTimer call spins up its emulator worker, which can take a while on a busy CI
    // runner. Wait for the save to report (success or the error toast in the trace), then the restart.
    await expect(page.locator('.mt-toaster')).toContainText(/Saved the time on M-2026-0510|didn’t save/, {
      timeout: 60_000,
    });
    await expect(page.locator('.mt-toaster')).not.toContainText('didn’t save');
    await expect(widget(page).getByTestId('timer-matter')).toHaveText('M-2026-0511', { timeout: 20_000 });
    await expect(widget(other).getByTestId('timer-matter')).toHaveText('M-2026-0511', { timeout: 20_000 });
    await expect
      .poll(async () => (await entries(request, orgId, 'm-quill'))[0], { timeout: 30_000 })
      .toMatchObject({
        source: { stringValue: 'timer' },
        status: { stringValue: 'draft' },
        minutes: { integerValue: '24' },
        units: { integerValue: '4' },
        amountCents: { integerValue: '17600' },
      });

    // Switch back to Quill and discard Wren's time.
    await widget(page).getByRole('button', { name: 'Switch matter' }).click();
    const picker = page.getByRole('dialog', { name: 'Switch the timer' });
    await picker.getByRole('searchbox', { name: 'Matter' }).fill('quill');
    await picker.getByRole('button', { name: /M-2026-0510/ }).click();
    const again = page.getByRole('dialog', { name: /^Stop and save M-2026-0511/ });
    await again.getByRole('button', { name: 'Discard' }).click();
    await expect(widget(page).getByTestId('timer-matter')).toHaveText('M-2026-0510', { timeout: 20_000 });
    expect(await entries(request, orgId, 'm-wren')).toEqual([]);

    // Stop: the save dialog with the rounded units, the narrative and billable.
    await seedTimer(request, orgId, uid, { id: 'm-quill', number: 'M-2026-0510' }, 30 * MIN + 45_000);
    await expect(widget(page).getByTestId('timer-elapsed')).toHaveText(/^3[01]:\d\d$/, { timeout: 20_000 });
    await widget(page).getByRole('button', { name: 'Stop timer' }).click();
    const save = page.getByRole('dialog', { name: 'Save timer' });
    await expect(save).toBeVisible();
    await expect(save.getByTestId('timer-units')).toHaveText('0.6 h');
    await expect(save.getByRole('checkbox', { name: 'Billable' })).toBeChecked();
    await save.getByRole('combobox', { name: 'Narrative' }).fill('Telephone attendance on executor');
    await expectNoA11yViolations(page);
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(save).toHaveCount(0);
    await expect(page.getByText('Saved 0.6 h on M-2026-0510', { exact: true })).toBeVisible();
    await expect(widget(page).getByTestId('timer-elapsed')).toHaveCount(0);
    await expect(widget(other).getByTestId('timer-elapsed')).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await entries(request, orgId, 'm-quill')).find(
            (e) => e['narrative']?.['stringValue'] === 'Telephone attendance on executor',
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({
        source: { stringValue: 'timer' },
        status: { stringValue: 'draft' },
        billable: { booleanValue: true },
        minutes: { integerValue: '31' },
        units: { integerValue: '6' },
      });
    expect(await storedTimer(request, uid)).toBeNull();
    await other.context().close();
  });

  test('the forgotten banner, and the idle question on a fake clock', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { orgId, account } = await setUp(page, request);
    const uid = account.uid;

    // The server job flagged a timer left running for 11 hours.
    await seedTimer(request, orgId, uid, { id: 'm-quill', number: 'M-2026-0510' }, 11 * 60 * MIN, {
      forgotten: { reason: 'long', at: new Date() },
    });
    await page.clock.install();
    await page.goto('/today');
    const banner = page.getByTestId('timer-forgotten');
    await expect(banner).toContainText('has been running for more than 10 hours', { timeout: 20_000 });
    await expectNoA11yViolations(page);
    await banner.getByRole('button', { name: 'Keep it running' }).click();
    await expect(banner).toHaveCount(0);
    await expect
      .poll(async () => (await storedTimer(request, uid))?.['forgottenSeenAt'], { timeout: 20_000 })
      .toBeDefined();

    // 16 minutes with no input: the idle question, with the time it began.
    await page.clock.fastForward('16:00');
    const idle = page.getByRole('dialog', { name: /^You were idle from \d{1,2}:\d\d$/ });
    await expect(idle).toBeVisible({ timeout: 20_000 });
    await expect(idle.getByRole('button', { name: /^Stop at / })).toBeVisible();
    await idle.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(idle).toHaveCount(0);
    expect((await storedTimer(request, uid))?.['running']).toEqual({ booleanValue: true });
  });
});

async function secondDevice(browser: import('@playwright/test').Browser, account: TestAccount): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInThroughUi(page, account);
  await expect(page).toHaveURL(/\/today$/, { timeout: 20_000 });
  return page;
}
