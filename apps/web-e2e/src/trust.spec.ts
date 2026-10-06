import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Trust balance snapshots (BILL-11, ADR-035) against the emulators: an owner turns trust balances
 * on in Settings → Trust account and names the records, then copies a matter's balance in through
 * the Update dialog (`trust-recordSnapshot`), and updates it with an older as-at date, which shows
 * as out of date. Display only: there is no deposit, withdraw or transfer anywhere. Keyboard only.
 * Fictional data only.
 */

const MATTER = '/matters/m-wren/overview';
const DAY = 86_400_000;

/** A date in Melbourne (the org's time zone), as the dialog shows it (DD/MM/YYYY). */
function entryDate(daysAgo = 0): string {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' })
    .format(new Date(Date.now() - daysAgo * DAY))
    .split('-');
  return `${d}/${m}/${y}`;
}

type TrustSettings = { showOnMatters: boolean; system: string; staleAfterDays: number };

async function seed(request: APIRequestContext, orgId: string, uid: string, trust?: TrustSettings): Promise<void> {
  await seedClient(request, orgId, uid);
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Trust Practice',
        timezone: 'Australia/Melbourne',
        flags: { 'billing.trustDisplay': true },
        ...(trust ? { trust } : {}),
      },
    },
    matterDoc(orgId, uid, {
      id: 'm-wren',
      number: 'M-2026-0611',
      title: 'Estate of Edith Wren',
      responsibleUid: uid,
      daysAgo: 1,
    }),
  ]);
}

async function setUp(page: Page, request: APIRequestContext, trust?: TrustSettings) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'owner', orgName: 'Fictional Trust Practice' },
    displayName: 'Morgan Fictional',
  });
  await seed(request, orgId, account.uid, trust);
  return { orgId, uid: account.uid };
}

const card = (page: Page) => page.getByTestId('matter-trust');

/**
 * Starts the Functions emulator's worker for a callable while the page loads. On a busy runner a
 * cold worker can take longer to start than the save waits (or fail to start in time), so the
 * test pays for it up front. The unauthenticated call is refused once the worker is up.
 */
function warmCallable(request: APIRequestContext, name: string): Promise<unknown> {
  return request
    .post(`http://127.0.0.1:5001/${EMULATOR_PROJECT}/australia-southeast1/${name}`, {
      data: { data: {} },
      timeout: 90_000,
    })
    .catch(() => undefined);
}

/** A save through a callable that may still be starting on a busy runner. */
const SAVED = { timeout: 45_000 };

async function storedTrustSettings(request: APIRequestContext, orgId: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as {
    fields?: { trust?: { mapValue?: { fields?: Record<string, Record<string, unknown>> } } };
  };
  return body.fields?.trust?.mapValue?.fields;
}

async function storedSnapshot(request: APIRequestContext, orgId: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/trustSnapshots/m-wren`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!response.ok()) return undefined;
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields;
}

test.describe('trust balance snapshots', () => {
  test('turns trust balances on and names the records, by keyboard', async ({ page, request }) => {
    test.setTimeout(180_000);
    const warm = warmCallable(request, 'trust-updateSettings');
    const { orgId } = await setUp(page, request);

    // Settings → Trust account: the fixed explanation, the switch, the records.
    await page.goto('/settings/trust');
    await expect(page.getByRole('heading', { level: 1, name: 'Trust account' })).toBeVisible();
    await expect(page.getByTestId('trust-explainer')).toContainText('It is not the trust ledger.');
    await expectNoA11yViolations(page);
    const toggle = page.getByRole('switch', { name: 'Show trust balances on matters' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Your trust records are kept in').selectOption({ label: 'Smokeball' });
    await expect(page.getByLabel('Name of your trust records')).toHaveCount(0);
    await warm;
    await page.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Trust settings saved').first()).toBeVisible(SAVED);
    for (const word of ['Deposit', 'Withdraw', 'Transfer']) {
      await expect(page.getByRole('button', { name: word })).toHaveCount(0);
    }
    await expect
      .poll(() => storedTrustSettings(request, orgId), { timeout: 20_000 })
      .toMatchObject({
        showOnMatters: { booleanValue: true },
        system: { stringValue: 'smokeball' },
        staleAfterDays: { integerValue: '30' },
      });
  });

  test('records and updates a matter’s balance by keyboard, shown out of date once old', async ({ page, request }) => {
    test.setTimeout(180_000);
    const warm = warmCallable(request, 'trust-recordSnapshot');
    const { orgId } = await setUp(page, request, { showOnMatters: true, system: 'smokeball', staleAfterDays: 30 });

    // The empty state, never $0.00.
    await page.goto(MATTER);
    await expect(card(page)).toContainText('No balance recorded yet. Copy it from Smokeball.');
    await expect(card(page)).toContainText('Not the trust ledger');
    await expect(card(page)).not.toContainText('$0.00');
    await expectNoA11yViolations(page);

    // Copy the balance in: As at defaults to today.
    await card(page).getByRole('button', { name: 'Update trust balance' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Update trust balance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Copy the balance from Smokeball.');
    await expect(dialog.getByRole('textbox', { name: 'As at' })).toHaveValue(entryDate());
    await expectNoA11yViolations(page);
    await dialog.getByRole('textbox', { name: 'Amount' }).fill('84,210.00');
    await dialog.getByRole('textbox', { name: 'Note' }).fill('Trust ledger report');
    await warm;
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, SAVED);
    await expect(card(page)).toContainText('$84,210.00');
    await expect(card(page)).toContainText('· from Smokeball');
    await expect(card(page)).not.toContainText('Out of date');

    // Update it with an as-at date older than the 30-day threshold: out of date.
    await card(page).getByRole('button', { name: 'Update trust balance' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Amount' }).fill('79,000');
    await dialog.getByRole('textbox', { name: 'As at' }).fill(entryDate(45));
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0, SAVED);
    await expect(card(page)).toContainText('$79,000.00');
    await expect(card(page)).toContainText('Out of date');

    await expect
      .poll(() => storedSnapshot(request, orgId), { timeout: 20_000 })
      .toMatchObject({
        amountCents: { integerValue: '7900000' },
        source: { stringValue: 'manual' },
        sourceSystemName: { stringValue: 'Smokeball' },
      });
  });

  test('is hidden from a paralegal, though the matter has a balance', async ({ page, request }) => {
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'paralegal', orgName: 'Fictional Trust Practice' },
      displayName: 'Sam Fictional',
    });
    await seed(request, orgId, account.uid);
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}`,
        data: {
          name: 'Fictional Trust Practice',
          timezone: 'Australia/Melbourne',
          flags: { 'billing.trustDisplay': true },
          trust: { showOnMatters: true, system: 'leap', staleAfterDays: 30 },
        },
      },
      {
        path: `orgs/${orgId}/trustSnapshots/m-wren`,
        data: {
          matterId: 'm-wren',
          amountCents: 500_000,
          asAt: '2026-10-01',
          source: 'manual',
          sourceSystemName: 'LEAP',
          recordedBy: account.uid,
          recordedAt: new Date(),
          createdAt: new Date(),
          createdBy: account.uid,
          updatedAt: new Date(),
          updatedBy: account.uid,
          schemaVersion: 1,
        },
      },
    ]);
    await page.goto(MATTER);
    await expect(page.getByRole('heading', { name: 'Estate of Edith Wren' })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByText('Held in trust')).toHaveCount(0);
  });
});
