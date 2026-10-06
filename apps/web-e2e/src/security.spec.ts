import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  createTestAccount,
  expectNoA11yViolations,
  setEmulatorDocuments,
  signInAsTestUser,
  signInThroughUi,
  TEST_PASSWORD,
} from '@materia/test-utils/e2e';

/**
 * Org security policies (SEC-04) against the emulators: the inactivity sign-out across two tabs
 * on a fake clock, required MFA sending a member to set it up, and "Sign out everywhere else".
 * A fictional practice and people only. (The Auth emulator has no TOTP, so MFA set-up itself
 * is covered by unit tests.)
 */

const uniqueOrg = () => `org-security-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function seedOrg(request: APIRequestContext, orgId: string, security: Record<string, unknown>) {
  const now = new Date();
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Security Legal',
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
          invoicePrefix: 'FS-',
          paymentTermsDays: 14,
        },
        matterNumberFormat: 'M-{YYYY}-{seq:4}',
        fy: { startMonth: 7 },
        plan: 'trial',
        security,
        createdAt: now,
        createdBy: 'e2e',
        updatedAt: now,
        updatedBy: 'e2e',
        schemaVersion: 1,
      },
    },
  ]);
}

const claims = (orgId: string, role = 'lawyer') => ({ orgId, role, orgName: 'Fictional Security Legal' });

test.describe('session security', () => {
  test('signs every tab out after the org’s inactivity limit, warning a minute before', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    await seedOrg(request, orgId, { mfaRequired: false, sessionIdleMinutes: 15 });
    await context.clock.install();
    await signInAsTestUser(page, request, { claims: claims(orgId), displayName: 'Casey Fictional' });
    const other = await context.newPage();
    // Both tabs have the org's 15-minute limit once Settings → Security shows it.
    for (const tab of [page, other]) {
      await tab.goto('/settings/security');
      await expect(tab.locator('[data-value="sessionIdleMinutes"]')).toHaveText('15 minutes', { timeout: 20_000 });
    }

    // A minute before the limit both tabs warn; "Stay signed in" in one clears both.
    await context.clock.fastForward('14:01');
    const warning = page.getByRole('dialog', { name: 'Are you still there?' });
    await expect(warning).toBeVisible();
    await expect(other.getByRole('dialog', { name: 'Are you still there?' })).toBeVisible();
    await expectNoA11yViolations(page);
    await warning.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(warning).toBeHidden();
    await expect(other.getByRole('dialog', { name: 'Are you still there?' })).toBeHidden();

    // No activity for the whole limit: every tab signs out and says why.
    await context.clock.fastForward('15:01');
    for (const tab of [page, other]) {
      await expect(tab).toHaveURL(/\/auth\/signed-out\?reason=idle$/);
      await expect(tab.getByRole('heading', { name: 'Signed out due to inactivity' })).toBeVisible();
    }
    await expectNoA11yViolations(page);
  });

  test('sends a member without MFA to set it up once the org requires it', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    await seedOrg(request, orgId, { mfaRequired: true, sessionIdleMinutes: 60 });
    // Signing in lands on MFA set-up rather than Today.
    const account = await createTestAccount(request, { claims: claims(orgId), displayName: 'Casey Fictional' });
    await signInThroughUi(page, account);
    await expect(page).toHaveURL(/\/auth\/mfa\/enrol/, { timeout: 20_000 });
    await page.goto('/matters');
    await expect(page).toHaveURL(/\/auth\/mfa\/enrol/);
  });

  test('an owner changes the policy and signs out everywhere else', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'The settings sidebar is the desktop layout');
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    await seedOrg(request, orgId, { mfaRequired: false, sessionIdleMinutes: 60 });
    await signInAsTestUser(page, request, { claims: claims(orgId, 'owner'), displayName: 'Priya Fictional' });

    await page.goto('/settings/security');
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByLabel('Sign out after inactivity').selectOption({ label: '2 hours' });
    await expect(page.getByText('Security settings saved').first()).toBeVisible();
    await expect(page.getByText('This device')).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere else' }).click();
    const reauth = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect(reauth).toBeVisible({ timeout: 20_000 });
    await reauth.getByLabel('Password').fill(TEST_PASSWORD);
    await reauth.getByRole('button', { name: 'Confirm' }).click();
    // The page reloads on a new sign-in, which still works.
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Sign out after inactivity').locator('option:checked')).toHaveText('2 hours');
  });
});
