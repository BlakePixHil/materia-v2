import { expect, test, type APIRequestContext } from '@playwright/test';

import { TERMS_VERSION } from '@materia/domain';
import {
  createTestAccount,
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInThroughUi,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient } from './support/matters';

/**
 * Data rights (SEC-05) against the emulators: an owner schedules the practice's deletion, which
 * makes it read-only everywhere, and cancels it; and an owner removes a member through the
 * offboarding wizard, handing their task and matter to a colleague. A fictional practice only.
 */

const NAME = 'Fictional Data Rights Legal';
const uniqueOrg = () => `org-data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** The practice, its terms already accepted (SEC-01) so its owner goes straight in. */
async function seedOrg(request: APIRequestContext, orgId: string): Promise<void> {
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: NAME,
        practiceType: 'wills_estates',
        jurisdictions: ['VIC'],
        primaryJurisdiction: 'VIC',
        timezone: 'Australia/Melbourne',
        holidayLocality: 'VIC_GREATER_GEELONG',
        retentionYears: 7,
        billing: {
          unitMinutes: 6,
          rounding: 'up',
          gstRegistered: true,
          defaultRateCents: 45000,
          invoicePrefix: 'FD-',
          paymentTermsDays: 14,
        },
        matterNumberFormat: 'M-{YYYY}-{seq:4}',
        fy: { startMonth: 7 },
        plan: 'trial',
        security: { mfaRequired: false, sessionIdleMinutes: 480 },
        termsAcceptedVersion: TERMS_VERSION,
        ...meta('e2e'),
      },
    },
  ]);
}

async function stored(request: APIRequestContext, path: string): Promise<Record<string, Record<string, unknown>>> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!response.ok()) return {};
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
}

test.describe('data rights', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings pages are the desktop layout');

  test('an owner schedules the practice’s deletion, which makes it read-only, then cancels it', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = uniqueOrg();
    await seedOrg(request, orgId);
    const owner = await createTestAccount(request, {
      claims: { orgId, role: 'owner', orgName: NAME },
      displayName: 'Olive Fictional',
    });
    await signInThroughUi(page, owner);
    await expect(page).toHaveURL(/\/today$/, FIRST_LOAD);

    await page.goto('/settings/data');
    await expect(page.getByRole('heading', { level: 1, name: 'Data and deletion' })).toBeVisible(FIRST_LOAD);
    await expect(page.getByText('A legal hold, or an export still being made, stops the deletion.')).toBeVisible();
    await expectNoA11yViolations(page);

    // Deleting asks for the practice's name.
    await page.getByRole('button', { name: 'Delete this practice…' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Delete ${NAME}?` });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Delete practice' })).toBeDisabled();
    await confirm.getByRole('textbox', { name: `Type ${NAME} to confirm` }).fill(NAME);
    await confirm.getByRole('button', { name: 'Delete practice' }).click();

    // Every page now says when, and that it's read-only.
    const banner = page.locator('[data-deletion-banner]');
    await expect(banner).toContainText(`${NAME} will be deleted on`, FIRST_CALL);
    await expect(banner).toContainText('Until then it’s read-only.');
    await expect(page.locator('[data-deletion-row]')).toContainText('Deletion scheduled');
    await expect.poll(async () => Object.keys(await stored(request, `orgs/${orgId}`))).toContain('deletionScheduledAt');
    await expectNoA11yViolations(page);

    // A change is refused, and says why.
    await page.goto('/settings/team');
    await expect(banner).toBeVisible(FIRST_LOAD);
    await page.getByLabel('Email').fill('new.colleague@example.test');
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('This practice is scheduled for deletion, so it’s read-only.').first()).toBeVisible(
      FIRST_CALL,
    );

    // The banner leads the owner back to cancel it.
    await banner.getByRole('link', { name: 'Cancel or export' }).click();
    await expect(page).toHaveURL(/\/settings\/data$/);
    await page.getByRole('button', { name: 'Cancel deletion' }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel the deletion?' });
    await cancel.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(page.getByText('The deletion is cancelled').first()).toBeVisible(FIRST_CALL);
    await expect(banner).toHaveCount(0, FIRST_CALL);
    await expect(page.getByRole('button', { name: 'Delete this practice…' })).toBeVisible();
    await expect
      .poll(async () => Object.keys(await stored(request, `orgs/${orgId}`)))
      .not.toContain('deletionScheduledAt');
  });

  test('an owner removes a member through the offboarding wizard, handing on their work', async ({ page, request }) => {
    test.setTimeout(150_000);
    const orgId = uniqueOrg();
    await seedOrg(request, orgId);
    const claims = (role: string) => ({ orgId, role, orgName: NAME });
    const owner = await createTestAccount(request, { claims: claims('owner'), displayName: 'Olive Fictional' });
    const sam = await createTestAccount(request, { claims: claims('lawyer'), displayName: 'Sam Fictional' });
    const jordan = await createTestAccount(request, { claims: claims('lawyer'), displayName: 'Jordan Fictional' });
    // Sam is responsible for a matter and has a task on it.
    await seedClient(request, orgId, owner.uid);
    await setEmulatorDocuments(request, [
      matterDoc(orgId, owner.uid, {
        id: 'm-wren',
        number: 'M-2026-0101',
        title: 'Estate of Ada Wren',
        responsibleUid: sam.uid,
        daysAgo: 1,
      }),
      {
        path: `orgs/${orgId}/matters/m-wren/tasks/t-certificate`,
        data: {
          orgId,
          matterId: 'm-wren',
          title: 'Order the death certificate',
          status: 'todo',
          priority: 'none',
          assigneeUid: sam.uid,
          checklist: [],
          order: 1024,
          source: 'manual',
          countedOpen: true,
          deletedAt: null,
          ...meta(owner.uid),
        },
      },
    ]);

    await signInThroughUi(page, owner);
    await expect(page).toHaveURL(/\/today$/, FIRST_LOAD);
    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Remove Sam Fictional' }).click();

    // Step 1: who takes their task and their matter.
    const wizard = page.getByRole('dialog', { name: 'Remove Sam Fictional' });
    await expect(wizard).toContainText('Step 1 of 2');
    const tasks = wizard.getByLabel('Who takes their open tasks');
    await expect(tasks).toBeVisible(FIRST_CALL);
    await expect(wizard.getByLabel('Who takes their deadlines')).toHaveCount(0);
    await expectNoA11yViolations(page);
    await tasks.selectOption({ label: 'Jordan Fictional' });
    await wizard.getByLabel('Who becomes responsible for their matters').selectOption({ label: 'Jordan Fictional' });
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Step 2: what happens, then remove.
    await expect(wizard).toContainText('1 open task goes to Jordan Fictional.');
    await expect(wizard).toContainText('1 matter they’re responsible for goes to Jordan Fictional.');
    await expect(wizard).toContainText('Sam Fictional loses access to the practice straight away.');
    await expectNoA11yViolations(page);
    await wizard.getByRole('button', { name: 'Remove Sam Fictional' }).click();
    await expect(page.getByText('Sam Fictional removed').first()).toBeVisible(FIRST_CALL);
    await expect(wizard).toHaveCount(0);

    // Jordan has their work now, and Sam is no longer a member.
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/matters/m-wren/tasks/t-certificate`))['assigneeUid'])
      .toEqual({ stringValue: jordan.uid });
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/matters/m-wren`))['responsibleUid'])
      .toEqual({ stringValue: jordan.uid });
    await expect
      .poll(async () => (await stored(request, `orgs/${orgId}/members/${sam.uid}`))['status'])
      .toEqual({ stringValue: 'removed' });
  });
});
