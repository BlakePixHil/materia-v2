import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { createTestAccount, FIRST_LOAD, signInThroughUi } from '@materia/test-utils/e2e';

import {
  Audit,
  discardTimer,
  DISPUTE,
  MATTER,
  MATTER_NUMBER,
  MATTER_TITLE,
  PACKET,
  PHONE,
  settled,
  signInToAuditPractice,
  ZONE,
} from './support/audit';

/**
 * The WCAG 2.2 AA audit (SEC-06, docs/accessibility/audit-2026-10-07.md): axe with the WCAG 2.0,
 * 2.1 and 2.2 A and AA rules over every route in app.routes.ts, every matter tab, the settings pages
 * for an owner and for a read-only member, the signed-out pages, and the dialogs and panels of the
 * key flows, each in the light and the dark theme, plus a phone-width pass. Each test lists every
 * violation it found across its pages before failing.
 *
 * Tagged @audit: it is long, so CI runs it in the morning run only (PRs run --grep-invert @audit);
 * the faster checks in a11y.spec.ts run on every PR. Fictional data only.
 */

test.use({ timezoneId: ZONE });

const FIXTURES = path.resolve(__dirname, '../../../libs/test-utils/fixtures/pdfs');
const SERVER = { timeout: 45_000 };

test.describe('accessibility audit @audit', () => {
  test.skip(({ isMobile }) => isMobile, 'The phone pass below sets its own viewport');

  test('signed-out pages', async ({ page, request }) => {
    test.setTimeout(180_000);
    const audit = new Audit(page);
    for (const url of [
      '/auth/sign-in',
      '/auth/sign-up',
      '/auth/forgot-password',
      '/auth/recover',
      '/auth/mfa',
      '/auth/signed-out?reason=idle',
      '/auth/signed-out?reason=revoked',
      '/auth/action',
      '/invite/inv-fictional',
      '/health',
      '/no-such-page',
    ]) {
      await audit.visit(url);
    }
    // The password step of sign-in, with a wrong password's error.
    const account = await createTestAccount(request);
    await page.goto('/auth/sign-in');
    await page.getByLabel('Work email').fill(account.email);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(SERVER);
    await audit.scan('sign-in password step with an error');
    // An unconfirmed email: verify-email.
    const unverified = await createTestAccount(request, { emailVerified: false });
    await signInThroughUi(page, unverified);
    await expect(page).toHaveURL(/\/auth\/verify-email$/, SERVER);
    await settled(page);
    await audit.scan('/auth/verify-email');
    audit.expectClean();
  });

  test('account set-up pages', async ({ page, request }) => {
    test.setTimeout(120_000);
    const audit = new Audit(page);
    // Someone signed in without a practice yet: onboarding, and two-step sign-in set-up.
    const account = await createTestAccount(request, { claims: {} });
    await signInThroughUi(page, account);
    await expect(page).toHaveURL(/\/onboarding$/, SERVER);
    await settled(page);
    await audit.scan('/onboarding');
    await audit.visit('/auth/mfa/enrol');
    audit.expectClean();
  });

  test('workspace pages', async ({ page, request }) => {
    test.setTimeout(300_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'owner');
    for (const url of [
      '/today',
      '/inbox',
      '/tasks',
      '/matters',
      '/matters/board',
      '/matters/destruction',
      '/deadlines',
      '/disputes',
      '/contacts',
      '/safe-custody',
      '/safe-custody/stocktake',
      '/billing',
      '/billing/invoices',
      '/billing/debtors',
      '/billing/disclosures',
      '/insights',
      '/help/clerk',
      '/no-access',
      '/no-such-page',
    ]) {
      await audit.visit(url);
    }
    audit.expectClean();
  });

  test('matter tabs', async ({ page, request }) => {
    test.setTimeout(300_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'owner');
    for (const tab of [
      'overview',
      'tasks',
      'deadlines',
      'documents',
      'time',
      'parties',
      'estate',
      'notes',
      'activity',
      'conflicts',
    ]) {
      await audit.visit(`/matters/${MATTER}/${tab}`);
    }
    await audit.visit(`/matters/${DISPUTE}/litigation`);
    audit.expectClean();
  });

  test('settings for an owner', async ({ page, request }) => {
    test.setTimeout(300_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'owner');
    for (const url of [
      'profile',
      'preferences',
      'practice',
      'team',
      'billing',
      'trust',
      'integrations',
      'numbering',
      'templates',
      'document-templates',
      'clerk',
      'audit',
      'migration',
      'migration/review',
      'security',
    ]) {
      await audit.visit(`/settings/${url}`);
    }
    audit.expectClean();
  });

  test('settings and a matter for a read-only member', async ({ page, request }) => {
    test.setTimeout(180_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'readonly');
    for (const url of [
      '/today',
      '/settings/team',
      '/settings/profile',
      '/settings/preferences',
      '/settings/clerk',
      '/settings/security',
      '/settings/practice',
      `/matters/${MATTER}/overview`,
      `/matters/${MATTER}/tasks`,
      `/matters/${MATTER}/documents`,
    ]) {
      await audit.visit(url);
    }
    audit.expectClean();
  });

  test('pages opened from a record', async ({ page, request }) => {
    test.setTimeout(240_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'owner');
    // A will in safe custody.
    await audit.visit(`/safe-custody/${PACKET}`);
    // A matter's pre-bill (an invoice page; issued invoices are scanned in both themes by invoices.spec.ts).
    await page.goto(`/matters/${MATTER}/time`);
    await settled(page);
    await page.getByTestId('matter-bills').getByRole('button', { name: 'New pre-bill' }).click();
    await expect(page).toHaveURL(/\/billing\/invoices\/[^/]+$/, SERVER);
    await settled(page);
    await audit.scan('/billing/invoices/:id (pre-bill)');
    // A practice's own copy of a system matter template, in the template editor.
    await page.goto('/settings/templates');
    await settled(page);
    await page.getByRole('button', { name: 'Customise Will', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/templates\/[^/]+$/, SERVER);
    await expect(page.getByRole('heading', { level: 1, name: 'Will (customised)' })).toBeVisible(SERVER);
    await settled(page);
    await audit.scan('/settings/templates/:id');
    // Clerk drafting (AI-10): the start page, then a letter in the editor (the emulator's fake model).
    await audit.visit(`/matters/${MATTER}/drafts/new`);
    await page.getByRole('radio', { name: 'Bank balance request' }).click();
    await page.getByRole('checkbox', { name: 'Someone else' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fictional Savings Bank');
    await page.getByRole('button', { name: 'Draft letter' }).click();
    await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}/drafts/[^/]+$`), SERVER);
    await expect(page.getByRole('textbox', { name: 'Letter' })).toBeEditable(SERVER);
    await audit.scan('/matters/:id/drafts/:draftId');
    // Where an export_ready notification and an OAuth provider lead, here with links gone stale.
    await audit.visit('/exports/export-fictional', '/exports/:jobId (expired)');
    await audit.visit('/integrations/callback/xero', '/integrations/callback/:provider (no code)');
    audit.expectClean();
  });

  test('dialogs and panels of the key flows', async ({ page, request }) => {
    test.setTimeout(360_000);
    const audit = new Audit(page);
    const { uid } = await signInToAuditPractice(page, request, 'owner');
    const dialog = page.getByRole('dialog');

    // Create a matter (intake): the type step, the clients step and its new-contact dialog.
    await audit.visit('/matters/new');
    await page.getByRole('radio', { name: 'Probate', exact: true }).click();
    await expect(page.getByTestId('intake-template')).toContainText('Probate');
    await audit.scan('intake: type step');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const newClient = page.getByRole('button', { name: 'New client…' });
    await expect(newClient).toBeVisible();
    await audit.scan('intake: clients step');
    await newClient.click();
    await expect(dialog.getByRole('heading', { name: 'New contact' })).toBeVisible();
    await audit.scan('intake: new contact dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The Deadlines screen's month calendar (today's date is marked in the brand blue).
    await page.goto('/deadlines');
    await settled(page);
    await page.getByRole('group', { name: 'Deadlines view' }).getByText('Calendar').click();
    await expect(page.locator('mt-deadline-calendar')).toBeVisible();
    await audit.scan('deadlines: month calendar');
    await page.getByRole('group', { name: 'Deadlines view' }).getByText('List').click();

    // The matter: add a task (quick add), add a deadline, log time, run the timer.
    await page.goto(`/matters/${MATTER}/tasks`);
    await settled(page);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByRole('textbox', { name: 'New task' })).toBeFocused();
    await audit.scan('matter tasks: quick add');
    await page.keyboard.press('Escape');

    await page.goto(`/matters/${MATTER}/deadlines`);
    await settled(page);
    await page.getByRole('button', { name: 'Add deadline' }).click();
    await expect(dialog).toBeVisible();
    await audit.scan('matter deadlines: add deadline dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(MATTER_TITLE, FIRST_LOAD);
    await settled(page);
    await page.keyboard.press('t');
    await expect(page.getByRole('dialog', { name: 'Log time' })).toBeVisible();
    await audit.scan('log time dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page
      .locator('mt-matter-header')
      .getByRole('button', { name: /^Start timer/ })
      .click();
    await expect(page.locator('mt-timer-widget').getByTestId('timer-matter')).toHaveText(MATTER_NUMBER, SERVER);
    await audit.scan('timer running');
    // The worker's other tests sign in as this owner too: no timer left running in their top bar.
    await discardTimer(request, uid);
    await expect(page.locator('mt-timer-widget').getByTestId('timer-matter')).toBeHidden(SERVER);

    // The command palette, the shortcut sheet and the account menu.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('combobox').first()).toBeFocused();
    await audit.scan('command palette');
    await page.keyboard.type('audit');
    await expect(page.getByRole('option').first()).toBeVisible(SERVER);
    await audit.scan('command palette with results');
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(dialog).toBeVisible();
    await audit.scan('keyboard shortcuts');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Account menu/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await audit.scan('account menu');
    await page.keyboard.press('Escape');

    // The bell's popover.
    await page.locator('[data-bell]').click();
    await expect(page.locator('mt-notifications-popover')).toBeVisible();
    await audit.scan('notifications popover');
    await page.keyboard.press('Escape');

    // Clerk: the panel, a streamed answer with a suggestion (the emulator's fake model).
    await page.keyboard.press('Control+j');
    const panel = page.getByRole('complementary', { name: 'Clerk' });
    await expect(panel.getByText(`Asking about ${MATTER_NUMBER}`)).toBeVisible(SERVER);
    await audit.scan('Clerk panel');
    const composer = panel.getByRole('textbox', { name: 'Ask Clerk' });
    await composer.fill('[fake:tools] [fake:propose] Who is the executor?');
    await composer.press('Control+Enter');
    await expect(panel.getByRole('article', { name: 'Clerk' }).last()).toContainText(
      'Fake Clerk reply after checking the matter.',
      SERVER,
    );
    await expect(panel.getByText('Request certified copies of the death certificate')).toBeVisible(SERVER);
    await audit.scan('Clerk panel with an answer and a suggestion');
    await page.keyboard.press('Control+j');

    // Upload a document and preview it (the real pipeline in the emulators).
    await page.goto(`/matters/${MATTER}/documents`);
    await settled(page);
    await page.getByTestId('document-upload-input').setInputFiles([
      {
        name: 'will.pdf',
        mimeType: 'application/pdf',
        buffer: readFileSync(path.join(FIXTURES, 'will.pdf')),
      },
    ]);
    await expect(
      page.getByRole('region', { name: 'Uploads' }).getByRole('listitem').filter({ hasText: 'will.pdf' }),
    ).toContainText('Ready', { timeout: 60_000 });
    await audit.scan('documents: upload finished');
    await page.getByRole('table', { name: 'Documents' }).getByRole('link', { name: 'will.pdf' }).click();
    await expect(page.locator('mt-pdf-viewer [data-rendered] canvas').first()).toBeVisible({ timeout: 60_000 });
    await audit.scan('document preview');

    // The board's Move menu (the keyboard alternative to dragging).
    await page.goto('/matters/board');
    await settled(page);
    await page.locator('.card').getByRole('button', { name: MATTER_TITLE }).focus();
    await page.keyboard.press('m');
    await expect(page.getByRole('menu', { name: `Move ${MATTER_NUMBER} to` })).toBeVisible();
    await audit.scan('board: move menu');
    await page.keyboard.press('Escape');
    audit.expectClean();
  });
});

test.describe('accessibility audit at phone width @audit', () => {
  // The iPhone 13 profile in Chromium (phone bugs reproduce with it; WebKit runs it in the morning run).
  test.use(PHONE);

  test('Today, Record and the main destinations', async ({ page, request }) => {
    test.setTimeout(240_000);
    const audit = new Audit(page);
    await signInToAuditPractice(page, request, 'lawyer');
    // The TabBar's destinations (MOB-02), then the pages a phone reaches from them.
    for (const url of [
      '/today',
      '/record',
      '/more',
      '/billing',
      '/matters',
      `/matters/${MATTER}/overview`,
      `/matters/${MATTER}/tasks`,
      '/deadlines',
      '/inbox',
      '/settings/profile',
    ]) {
      await audit.visit(url);
    }
    audit.expectClean();
  });
});
