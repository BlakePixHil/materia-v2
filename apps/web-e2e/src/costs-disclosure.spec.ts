import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  expectNoA11yViolations,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Costs disclosure (BILL-06) against the emulators, behind `billing.costsDisclosure`: a matter
 * whose $2,000 fixed fee needs the short-form disclosure (as intake assessed it) has it generated
 * into its documents and recorded as sent; revising the fee to $4,000 moves it into the full band,
 * so the panel says an updated disclosure is needed and why, and the report lists it. Fictional data only.
 */

const OVERVIEW = '/matters/m-quill/overview';

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Disclosure Practice' },
    displayName: 'Jordan Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0644',
    title: 'Estate of Rosamund Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Disclosure Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
        flags: { 'billing.feeBudgets': true, 'billing.costsDisclosure': true },
      },
    },
    {
      ...matter,
      data: {
        ...matter.data,
        jurisdiction: 'VIC',
        fee: { arrangement: 'fixed', amountCents: 200_000, revision: 0, history: [] },
        costsDisclosure: {
          status: 'required',
          requirement: 'short_form',
          bandId: 'standard-form',
          rulesVersion: 'vic-v1',
          basisEstimateCents: 200_000,
          requiredSince: today,
          history: [],
        },
      },
    },
  ]);
}

test.describe('Costs disclosure', () => {
  test('generate, record as sent, then revise the fee and see an update is needed', async ({ page, request }) => {
    test.setTimeout(180_000);
    await setUp(page, request);

    await page.goto(OVERVIEW);
    const panel = page.getByRole('region', { name: 'Costs disclosure' });
    await expect(panel).toContainText('Short-form disclosure required (estimate $2,000.00)', FIRST_LOAD);
    await expect(panel).toContainText('illustrative until a practitioner reviews them');
    await expectNoA11yViolations(page);

    // Generate: the short form is merged into the matter's documents.
    const generated = page.waitForResponse(
      (res) => res.url().endsWith('/costs-generateDisclosure') && res.request().method() === 'POST',
      FIRST_CALL,
    );
    await panel.getByRole('button', { name: 'Generate disclosure' }).click();
    expect((await generated).ok()).toBe(true);
    await expect(page.getByText(/Costs disclosure .* added to Documents/).first()).toBeVisible(FIRST_CALL);
    await expect(panel.getByRole('link', { name: 'Open the latest generated disclosure' })).toBeVisible(FIRST_LOAD);

    // Record it as sent today, by email.
    await panel.getByRole('button', { name: 'Record as sent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Costs disclosure for M-2026-0644' });
    await expect(dialog).toBeVisible();
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Record as sent' }).click();
    await expect(dialog).toBeHidden(FIRST_CALL);
    await expect(panel.getByTestId('disclosure-status')).toHaveText('Sent', FIRST_LOAD);
    await expect(panel).toContainText('by email, on an estimate of $2,000.00');

    // Revise the fee into the full band: an updated disclosure is needed.
    await page
      .getByRole('region', { name: 'Fees and budget' })
      .getByRole('button', { name: 'Edit fee arrangement' })
      .click();
    const fee = page.getByRole('dialog', { name: 'Fee arrangement for M-2026-0644' });
    await fee.getByRole('textbox', { name: 'Fixed fee' }).fill('4,000');
    await fee
      .getByRole('textbox', { name: 'Reason for the change' })
      .fill('Caveat lodged; the application is contested');
    await fee.getByRole('button', { name: 'Save fee' }).click();
    await expect(fee).toBeHidden(FIRST_CALL);
    await expect(panel.getByTestId('disclosure-status')).toHaveText('Update required', FIRST_LOAD);
    await expect(panel).toContainText('the estimate moved to a different disclosure band');
    await expect(panel.getByRole('button', { name: 'Generate updated disclosure' })).toBeVisible();
    await expectNoA11yViolations(page);

    // The report lists it.
    await page.goto('/billing/disclosures');
    const row = page.getByTestId('disclosure-row').filter({ hasText: 'M-2026-0644' });
    await expect(row).toContainText('Full disclosure required (estimate $4,000.00)', FIRST_LOAD);
    await expect(row).toContainText('Update required');
    await expectNoA11yViolations(page);
  });
});
