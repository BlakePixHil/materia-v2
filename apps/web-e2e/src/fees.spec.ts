import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Fee arrangements and budgets (BILL-05) against the emulators: the Overview's fee panel shows the
 * budget Meter that `fees-budgetOnTime` keeps from the matter's time, and revising the fee through
 * "Edit fee arrangement" (the real `fees-update`) moves the Meter and adds a revision to the
 * history. Fictional data only.
 */

const OVERVIEW = '/matters/m-ashby/overview';
/** Callables and triggers cold-start the Functions emulator. */
const SERVER = { timeout: 20_000 };

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Fees Practice' },
    displayName: 'Jordan Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-ashby',
    number: 'M-2026-0618',
    title: 'Estate of Lionel Ashby',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const now = new Date();
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid, schemaVersion: 1 };
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Fees Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
        flags: { 'billing.feeBudgets': true },
      },
    },
    { ...matter, data: { ...matter.data, fee: { arrangement: 'fixed', amountCents: 100_000, history: [] } } },
    // Approved time keeps its amount; the fees trigger counts it into the budget.
    {
      path: `${matter.path}/timeEntries/te-1`,
      data: {
        orgId,
        matterId: 'm-ashby',
        uid,
        date: '2026-09-29',
        minutes: 120,
        units: 20,
        rateCents: 42500,
        amountCents: 85_000,
        narrative: 'Prepared the probate application',
        billable: true,
        status: 'final',
        source: 'manual',
        wipCountedCents: 85_000,
        deletedAt: null,
        ...meta,
      },
    },
  ]);
}

test.describe('Fee arrangements and budgets', () => {
  test('revise the fee and see the budget Meter move', async ({ page, request }) => {
    test.setTimeout(120_000);
    await setUp(page, request);

    await page.goto(OVERVIEW);
    const panel = page.getByRole('region', { name: 'Fees and budget' });
    await expect(panel).toContainText('$850.00 recorded of $1,000.00 fixed fee · 85%', SERVER);
    const meter = panel.getByRole('meter');
    await expect(meter).toHaveAttribute('aria-valuemax', '100000');
    await expectNoA11yViolations(page);

    await panel.getByRole('button', { name: 'Edit fee arrangement' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fee arrangement for M-2026-0618' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Fixed fee' }).fill('1,700');
    await dialog.getByRole('button', { name: 'Save fee' }).click();
    await expect(dialog).toContainText('Say why the fee is changing.');
    await dialog
      .getByRole('textbox', { name: 'Reason for the change' })
      .fill('Caveat lodged; costs disclosure updated');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Save fee' }).click();
    await expect(dialog).toBeHidden(SERVER);

    await expect(panel).toContainText('$850.00 recorded of $1,700.00 fixed fee · 50%', SERVER);
    await expect(meter).toHaveAttribute('aria-valuemax', '170000');
    await panel.getByText('Revision history (1)').click();
    await expect(panel).toContainText('Caveat lodged; costs disclosure updated');
    await expect(panel).toContainText('Fixed fee: $1,000.00 → $1,700.00');
  });
});
