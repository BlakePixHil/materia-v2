import { expect, test } from '@playwright/test';

import {
  createTestAccount,
  expectNoA11yViolations,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

/**
 * Org settings (CORE-21) against the emulators: an owner edits the practice details, changes a
 * colleague's role and rate on the team page, and finds both in the audit log. A fictional
 * practice and people only.
 */

const uniqueOrg = () => `org-settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test.describe('org settings', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings sidebar is the desktop layout');

  test('edit the practice, change a member’s role and rate, and view the audit log', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const now = new Date();
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}`,
        data: {
          name: 'Fictional Settings Legal',
          practiceType: 'wills_estates',
          jurisdictions: ['VIC'],
          primaryJurisdiction: 'VIC',
          timezone: 'Australia/Melbourne',
          holidayLocality: 'VIC_MELBOURNE',
          retentionYears: 7,
          billing: {
            unitMinutes: 6,
            rounding: 'up',
            gstRegistered: true,
            defaultRateCents: 45000,
            invoicePrefix: 'FS-',
            paymentTermsDays: 14,
          },
          matterNumberFormat: 'M-{YYYY}-{seq:4}',
          fy: { startMonth: 7 },
          plan: 'trial',
          security: { mfaRequired: false, sessionIdleMinutes: 60 },
          createdAt: now,
          createdBy: 'e2e',
          updatedAt: now,
          updatedBy: 'e2e',
          schemaVersion: 1,
        },
      },
    ]);
    await createTestAccount(request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Settings Legal' },
      displayName: 'Casey Fictional',
    });
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'owner', orgName: 'Fictional Settings Legal' },
      displayName: 'Priya Fictional',
    });

    // Practice: an invalid ABN is caught, a valid one saves.
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/practice$/);
    await expect(page.getByRole('heading', { name: 'Practice', level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByLabel('ABN').fill('51 824 753 557');
    await expect(page.getByText('This isn’t a valid ABN. Check the digits.')).toBeVisible();
    await page.getByLabel('ABN').fill('51 824 753 556');
    await page.getByLabel('Keep records for').fill('10');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Practice settings saved').first()).toBeVisible();

    // Team: a new role and rate for Casey.
    await page
      .getByRole('navigation', { name: 'Settings pages' })
      .getByRole('link', { name: 'Team and roles' })
      .click();
    await expect(page).toHaveURL(/\/settings\/team$/);
    await page.getByLabel('Role for Casey Fictional').selectOption({ label: 'Paralegal' });
    await expect(page.getByText('Casey Fictional is now Paralegal').first()).toBeVisible();
    await page.getByRole('button', { name: 'Rate and budget for Casey Fictional' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Hourly rate').fill('320');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Casey Fictional’s rate and budget saved').first()).toBeVisible();
    await expect(page.getByText('$320.00/h')).toBeVisible();
    await expectNoA11yViolations(page);

    // Audit log: both changes are there.
    await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('link', { name: 'Audit log' }).click();
    await expect(page).toHaveURL(/\/settings\/audit$/);
    const log = page.getByRole('table', { name: 'Audit log' });
    await expect(log.getByText('Settings changed').first()).toBeVisible({ timeout: 20_000 });
    await expect(log.getByText('Role changed').first()).toBeVisible();
    await page.getByLabel('Action').selectOption({ label: 'Role changed' });
    await expect(log.getByText('Settings changed')).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});
