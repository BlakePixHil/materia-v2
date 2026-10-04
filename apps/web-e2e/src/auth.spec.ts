import { expect, test } from '@playwright/test';

import {
  createInvite,
  createTestAccount,
  expectNoA11yViolations,
  latestOobCode,
  signInThroughUi,
  TEST_PASSWORD,
  uniqueEmail,
} from '@materia/test-utils/e2e';

/**
 * Sign-in flows (FND-16) against the Auth, Firestore and Functions emulators. The emulator project
 * has open sign-up off, like prod. TOTP MFA isn't supported by the Auth emulator, so enrolment and
 * the challenge are covered by unit tests instead.
 */

test('a signed-out visit goes to sign-in, then back to where it was going', async ({ page, request }) => {
  const account = await createTestAccount(request);
  await page.goto('/matters');
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnUrl=%2Fmatters$/);
  await page.getByLabel('Work email').fill(account.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('don’t match');
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/matters$/);
});

test('sign-out leaves no cached Firestore data', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'Sign-out lives in the desktop user menu');
  const account = await createTestAccount(request);
  await signInThroughUi(page, account);
  await expect(page).toHaveURL(/\/today$/);
  // The data layer (FND-19) keeps Firestore's persistent cache in IndexedDB once a listener starts.
  const firestoreDbs = () =>
    page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('firestore/')),
    );
  await expect.poll(firestoreDbs).toHaveLength(1);
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in$/);
  expect(await firestoreDbs()).toEqual([]);
  // And the session is gone: protected pages send you back to sign in.
  await page.goto('/today');
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});

test('signing out in one tab signs out the other', async ({ context, page, request, isMobile }) => {
  test.skip(isMobile, 'Sign-out lives in the desktop user menu');
  const account = await createTestAccount(request, { displayName: 'Tab Fictional' });
  await signInThroughUi(page, account);
  await expect(page).toHaveURL(/\/today$/);

  // A second tab shares the sign-in and follows live data (the members list).
  const other = await context.newPage();
  await other.goto('/settings/team');
  await expect(other.getByText('Tab Fictional (you)')).toBeVisible();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in$/);

  await expect(other).toHaveURL(/\/auth\/sign-in$/);
  await expect(other.getByRole('heading', { name: 'Sign in to Materia' })).toBeVisible();
  await expect(
    other.getByRole('region', { name: /Notifications/ }).getByText('You signed out in another tab'),
  ).toBeVisible();
  await expect(other.getByText('Tab Fictional (you)')).toHaveCount(0);
  await expectNoA11yViolations(other);
  await expect
    .poll(() =>
      other.evaluate(async () =>
        (await indexedDB.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('firestore/')),
      ),
    )
    .toEqual([]);
});

test('sign-up without an invite is refused', async ({ page }) => {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Full name').fill('Stranger Person');
  await page.getByLabel('Work email').fill(uniqueEmail('stranger'));
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-up is by invitation only');
});

test('sign up with an invite, confirm the email from the link, and land in onboarding', async ({ page, request }) => {
  const email = uniqueEmail('invited');
  await createInvite(request, email);
  await page.goto(`/auth/sign-up?email=${encodeURIComponent(email)}`);
  await page.getByLabel('Full name').fill('Invited Person');
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/auth\/verify-email$/);
  await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  // Not yet verified: the shell stays closed.
  await page.goto('/today');
  await expect(page).toHaveURL(/\/auth\/verify-email$/);
  const code = await latestOobCode(request, email, 'VERIFY_EMAIL');
  await page.goto(`/auth/action?mode=verifyEmail&oobCode=${code}`);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  // No org yet (FND-17 sets the claim when the invite is accepted).
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('reset a forgotten password from the emailed link', async ({ page, request }) => {
  const account = await createTestAccount(request);
  await page.goto('/auth/forgot-password');
  await page.getByLabel('Work email').fill(account.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText(`If there’s an account for ${account.email}`);
  const code = await latestOobCode(request, account.email, 'PASSWORD_RESET');
  await page.goto(`/auth/action?mode=resetPassword&oobCode=${code}`);
  await page.getByLabel('New password').fill('a brand new passphrase');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await signInThroughUi(page, { email: account.email, password: 'a brand new passphrase' });
  await expect(page).toHaveURL(/\/today$/);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the auth screens have no WCAG 2.2 AA violations (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    for (const [url, heading] of [
      ['/auth/sign-in', 'Sign in to Materia'],
      ['/auth/sign-up', 'Create your account'],
      ['/auth/forgot-password', 'Reset your password'],
      ['/auth/recover', 'Use a recovery code'],
    ] as const) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectNoA11yViolations(page);
    }
    await page.goto('/auth/sign-in');
    await page.getByLabel('Work email').fill('someone@example.test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expectNoA11yViolations(page);
    await page.screenshot({ path: test.info().outputPath(`sign-in-${theme}.png`) });
  });
}
