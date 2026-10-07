import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  createTestAccount,
  expectNoA11yViolations,
  FIRST_LOAD,
  latestInviteLink,
  signInThroughUi,
  uniqueEmail,
  type TestAccount,
} from '@materia/test-utils/e2e';

/**
 * Organisations, invites and the org switcher (FND-17) against the emulators. The invite email is
 * read from the emulator outbox. Every person and practice is fictional.
 */

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

/**
 * A round trip through an orgs-* callable and the token refresh after it. The default 5 s isn't
 * enough when the other worker keeps the Functions emulator busy.
 */
const SERVER = { timeout: 20_000 };

/** A verified account without an org, signed in on its own page (its own browser context). */
async function personPage(browser: Browser, request: Parameters<typeof createTestAccount>[0], name: string) {
  const account = await createTestAccount(request, { claims: {}, displayName: name, email: uniqueEmail('org') });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInThroughUi(page, account);
  await expect(page).toHaveURL(/\/onboarding$/, SERVER);
  return { account, page };
}

async function createPractice(page: Page, name: string) {
  await page.getByLabel('Practice name').fill(name);
  // The owner accepts the terms for the practice as it's created (SEC-01).
  await page.getByRole('checkbox', { name: /I accept the terms of service/ }).click();
  await page.getByRole('button', { name: 'Create practice' }).click();
  await expect(page).toHaveURL(/\/today$/, SERVER);
  await expect(sidebar(page).getByRole('button', { name: 'Switch organisation' })).toContainText(name);
}

async function invite(page: Page, invitee: TestAccount, role: string) {
  await page.goto('/settings/team');
  await page.getByLabel('Email').fill(invitee.email);
  await page.getByLabel('Role', { exact: true }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invite' }).click();
  // The team page's first callables (the invite, and members' MFA status) can be cold starts in the
  // emulator, which take longer than the default wait while other specs keep it busy.
  await expect(page.getByText(`Invite sent to ${invitee.email}`).first()).toBeVisible(SERVER);
}

test.describe('organisations', () => {
  test.skip(({ isMobile }) => isMobile, 'The org switcher lives in the desktop sidebar');

  test('create a practice, invite a colleague who accepts, and change their role without a sign-out', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const owner = await personPage(browser, request, 'Priya Fictional');
    await expectNoA11yViolations(owner.page);
    await createPractice(owner.page, 'Fictional Bayside Legal');

    const colleague = await personPage(browser, request, 'Daniel Fictional');
    await invite(owner.page, colleague.account, 'Paralegal');
    await expectNoA11yViolations(owner.page);
    await expect(owner.page.getByText('Pending invites')).toBeVisible();

    // The colleague opens the emailed link and accepts.
    const link = new URL(await latestInviteLink(request, colleague.account.email));
    await colleague.page.goto(`${link.pathname}${link.search}`);
    await expect(colleague.page.getByRole('heading', { name: 'Join your practice on Materia' })).toBeVisible();
    await expectNoA11yViolations(colleague.page);
    await colleague.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(colleague.page).toHaveURL(/\/today$/, SERVER);
    await expect(sidebar(colleague.page).getByRole('button', { name: 'Switch organisation' })).toContainText(
      'Fictional Bayside Legal',
    );

    // Both see the practice and each other.
    await colleague.page.goto('/settings/team');
    await expect(colleague.page.getByText('Priya Fictional')).toBeVisible(FIRST_LOAD);
    await expect(colleague.page.getByText('Invite someone')).toHaveCount(0);
    await owner.page.reload();
    await expect(owner.page.getByText(`${colleague.account.email} · Paralegal`)).toBeVisible(FIRST_LOAD);

    // The owner makes them an admin; their open page picks it up within a minute, no sign-out.
    await owner.page.getByLabel('Role for Daniel Fictional').selectOption({ label: 'Admin' });
    await expect(owner.page.getByText('Daniel Fictional is now Admin').first()).toBeVisible(SERVER);
    await expect(colleague.page.getByText('Invite someone')).toBeVisible({ timeout: 60_000 });
    await expect(colleague.page).toHaveURL(/\/settings\/team$/);
  });

  test('switching practices shows only the new practice’s data', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const alpha = await personPage(browser, request, 'Alex Fictional');
    await createPractice(alpha.page, 'Fictional Alpha Partners');
    const beta = await personPage(browser, request, 'Bea Fictional');
    await createPractice(beta.page, 'Fictional Beta Lawyers');

    await invite(beta.page, alpha.account, 'Lawyer');
    const link = new URL(await latestInviteLink(request, alpha.account.email));
    await alpha.page.goto(`${link.pathname}${link.search}`);
    await alpha.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(alpha.page).toHaveURL(/\/today$/, SERVER);

    // Now in Beta: its team includes Bea.
    await alpha.page.goto('/settings/team');
    await expect(alpha.page.getByText('Bea Fictional')).toBeVisible(FIRST_LOAD);

    // Switch back to Alpha from the sidebar.
    await sidebar(alpha.page).getByRole('button', { name: 'Switch organisation' }).click();
    await expect(alpha.page.getByRole('menuitem', { name: 'Fictional Beta Lawyers' })).toBeVisible();
    await alpha.page.getByRole('menuitem', { name: 'Fictional Alpha Partners' }).click();
    await expect(alpha.page).toHaveURL(/\/today$/, SERVER);
    await expect(sidebar(alpha.page).getByRole('button', { name: 'Switch organisation' })).toContainText(
      'Fictional Alpha Partners',
    );
    await alpha.page.goto('/settings/team');
    await expect(alpha.page.getByText('Alex Fictional (you)')).toBeVisible(FIRST_LOAD);
    await expect(alpha.page.getByText('Bea Fictional')).toHaveCount(0);
  });
});
