import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The Time and billing screen (BILL-03) against the emulators: finalising my week, and approving
 * and writing down a supervisee's time from Approvals (`time-setStatus`, `time-writeDown`).
 * Fictional data only.
 */

/** Callables on the emulator can be slow to start on CI runners. */
const CALLABLE_TIMEOUT = 30_000;

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** Today in Melbourne (the org's time zone), as entries store it. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
}

/** A draft as the client writes it once time-onWrite has priced it (the org default rate). */
function draft(orgId: string, uid: string, id: string, minutes: number, narrative: string) {
  const units = minutes / 6;
  return {
    path: `orgs/${orgId}/matters/m-quill/timeEntries/${id}`,
    data: {
      orgId,
      matterId: 'm-quill',
      uid,
      date: today(),
      minutes,
      units,
      rateCents: 30000,
      amountCents: units * 3000,
      narrative,
      billable: true,
      status: 'draft',
      source: 'manual',
      wipCountedCents: units * 3000,
      deletedAt: null,
      ...meta(uid),
    },
  };
}

/**
 * A practice where I (a lawyer) supervise Daniel (a paralegal): one matter, two drafts of mine and
 * two of Daniel's, all today.
 */
async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Billing Practice' },
    displayName: 'Jordan Fictional',
  });
  const daniel = await createTestAccount(request, {
    claims: { orgId, role: 'paralegal' },
    displayName: 'Daniel Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0610',
    title: 'Estate of Harriet Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Billing Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
      },
    },
    {
      path: `orgs/${orgId}/members/${uid}`,
      data: { role: 'lawyer', status: 'active', email: `${uid}@example.test`, displayName: 'Jordan Fictional' },
    },
    {
      path: `orgs/${orgId}/members/${daniel.uid}`,
      data: {
        role: 'paralegal',
        status: 'active',
        email: `${daniel.uid}@example.test`,
        displayName: 'Daniel Fictional',
        supervisorUid: uid,
      },
    },
    { ...matter, data: { ...matter.data, wipCents: 30000 } },
    draft(orgId, uid, 'te-mine-1', 30, 'Perusing and considering the will'),
    draft(orgId, uid, 'te-mine-2', 12, 'Letter to executor'),
    draft(orgId, daniel.uid, 'te-daniel-1', 36, 'Searching the probate register'),
    draft(orgId, daniel.uid, 'te-daniel-2', 12, 'Filing the inventory'),
  ]);
  return { orgId, uid, daniel: daniel.uid };
}

/** The stored entries of the matter (id → fields). */
async function stored(request: APIRequestContext, orgId: string, id: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-quill/timeEntries/${id}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
}

test.describe('time and billing', () => {
  test('finalises my week', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId } = await setUp(page, request);
    await page.goto('/billing');
    await expect(page.getByRole('heading', { level: 1, name: 'Time and billing' })).toBeVisible();
    const myTime = page.locator('mt-my-time');
    await expect(myTime.locator('mt-time-entry')).toHaveCount(2);
    await expect(myTime).toContainText('2 drafts this week to finalise.');
    await expect(page.getByTestId('stat-week')).toContainText('0.7');
    await expectNoA11yViolations(page);

    await myTime.getByRole('button', { name: 'Finalise week' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(confirm).toContainText('Finalise 2 entries?');
    await confirm.getByRole('button', { name: 'Finalise week' }).click();
    // The first call to a callable can take a while on a cold emulator.
    await expect(myTime).not.toContainText('drafts this week', { timeout: CALLABLE_TIMEOUT });
    await expect(myTime.locator('mt-time-entry[data-status="final"]')).toHaveCount(2);
    for (const id of ['te-mine-1', 'te-mine-2']) {
      await expect.poll(async () => (await stored(request, orgId, id))['status']).toEqual({ stringValue: 'final' });
    }
  });

  test('approves and writes down a supervisee’s time', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await setUp(page, request);
    await page.goto('/billing?tab=approvals');
    const approvals = page.locator('mt-approvals-tab');
    const daniel = approvals.locator('section.person', { hasText: 'Daniel Fictional' });
    await expect(daniel.locator('mt-time-entry')).toHaveCount(2);
    // Only my supervisee's drafts, not mine.
    await expect(approvals).not.toContainText('Letter to executor');
    await expect(page.getByRole('tab', { name: /Approvals/ })).toContainText('2');
    await expectNoA11yViolations(page);

    // Approve one.
    await daniel.getByRole('button', { name: 'Approve Filing the inventory' }).click();
    await expect(daniel.locator('mt-time-entry')).toHaveCount(1, { timeout: CALLABLE_TIMEOUT });
    await expect
      .poll(async () => (await stored(request, orgId, 'te-daniel-2'))['status'])
      .toEqual({ stringValue: 'final' });

    // Write the other down to 4 units with a reason.
    await daniel.getByRole('button', { name: 'More actions for Searching the probate register' }).click();
    await page.getByRole('menuitem', { name: 'Write down or off…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Write down this entry' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'New units' }).fill('4');
    await expect(dialog.getByTestId('write-down-preview')).toHaveText('$180.00 becomes $120.00.');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('A simple search, over-recorded');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Write down' }).click();
    await expect(dialog).toHaveCount(0, { timeout: CALLABLE_TIMEOUT });
    await expect(approvals.getByText('Nothing to approve')).toBeVisible({ timeout: CALLABLE_TIMEOUT });
    await expect
      .poll(async () => {
        const fields = await stored(request, orgId, 'te-daniel-1');
        return [fields['status'], fields['units'], fields['amountCents']];
      })
      .toEqual([{ stringValue: 'final' }, { integerValue: '4' }, { integerValue: '12000' }]);
    const writeDown = (await stored(request, orgId, 'te-daniel-1'))['writeDown'] as {
      mapValue: { fields: Record<string, unknown> };
    };
    expect(writeDown.mapValue.fields).toMatchObject({
      originalUnits: { integerValue: '6' },
      originalAmountCents: { integerValue: '18000' },
      by: { stringValue: uid },
      reason: { stringValue: 'A simple search, over-recorded' },
    });
  });
});
