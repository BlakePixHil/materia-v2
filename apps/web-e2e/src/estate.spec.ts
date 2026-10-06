import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { contactSearchTokens, partyDocId } from '@materia/domain';
import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The estate register (CORE-16) against the emulators: add assets and a liability from the
 * quick-entry rows (Tab moves across the cells, Enter adds the row), see the summary and the
 * matter's totals kept by `estate-onWrite`, record a distribution to the beneficiary, download the
 * inventory CSV and start the PDF export (`estate-exportInventory`; the emulator's job runner only
 * queues it). Fictional data only.
 */

const ESTATE = '/matters/m-rowe/estate';
/** Callables and triggers cold-start the Functions emulator. */
const SERVER = { timeout: 20_000 };

const meta = (uid: string) => ({
  createdAt: new Date(),
  createdBy: uid,
  updatedAt: new Date(),
  updatedBy: uid,
  schemaVersion: 1,
});

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Estates Practice' },
    displayName: 'Jordan Fictional',
  });
  await setOrgFlags(request, orgId, { 'estate.register': true });
  await seedClient(request, orgId, account.uid);
  const matter = matterDoc(orgId, account.uid, {
    id: 'm-rowe',
    number: 'M-2026-0420',
    title: 'Estate of Hazel Rowe',
    responsibleUid: account.uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    {
      ...matter,
      data: {
        ...matter.data,
        stageId: 'intake',
        deceased: { contactId: 'c-hazel', dateOfDeath: '2026-08-14', domicile: 'VIC', lastAddress: '' },
        estate: { grantType: 'probate' },
      },
    },
    {
      path: `orgs/${orgId}/contacts/c-heir`,
      data: {
        kind: 'person',
        givenNames: 'Ivy',
        familyName: 'Rowe',
        sortName: 'rowe ivy',
        emails: [],
        phones: [],
        addresses: [],
        tags: [],
        isReferrer: false,
        search: contactSearchTokens({ givenNames: 'Ivy', familyName: 'Rowe' }),
        deletedAt: null,
        ...meta(account.uid),
      },
    },
    {
      path: `orgs/${orgId}/matters/m-rowe/parties/${partyDocId('beneficiary', 'c-heir')}`,
      data: {
        orgId,
        matterId: 'm-rowe',
        contactId: 'c-heir',
        role: 'beneficiary',
        addedFrom: 'manual',
        deletedAt: null,
        ...meta(account.uid),
      },
    },
  ]);
  return { orgId, uid: account.uid };
}

type Fields = Record<string, Record<string, unknown>>;

/** A document's fields, read through the emulator's admin access. */
async function fieldsOf(request: APIRequestContext, path: string): Promise<Fields> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  return response.ok() ? (((await response.json()) as { fields?: Fields }).fields ?? {}) : {};
}

const integer = (fields: Fields | undefined, key: string) => Number(fields?.[key]?.['integerValue'] ?? NaN);

test.describe('estate register', () => {
  test('add assets and a liability, record a distribution, export CSV and PDF', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { orgId } = await setUp(page, request);

    await page.goto(ESTATE);
    await expect(page.getByRole('heading', { level: 2, name: 'Estate' })).toBeVisible();
    await expect(page.getByText('No assets yet')).toBeVisible();
    await expectNoA11yViolations(page);

    // Quick entry: Tab across the cells, Enter adds the row and returns to the description.
    const assetRow = page.getByRole('form', { name: 'Add an asset' });
    await assetRow.getByLabel('New asset class').selectOption({ label: 'Real property' });
    const description = assetRow.getByLabel('New asset description');
    await description.fill('House, 3 Fictional Road, Ocean Grove');
    await description.press('Tab');
    await expect(assetRow.getByLabel('New asset value at date of death')).toBeFocused();
    await page.keyboard.type('850,000');
    await page.keyboard.press('Enter');
    const assets = page.getByRole('table', { name: 'Assets' });
    await expect(assets).toContainText('House, 3 Fictional Road, Ocean Grove', SERVER);
    await expect(description).toBeFocused();
    await expect(description).toHaveValue('');

    await assetRow.getByLabel('New asset class').selectOption({ label: 'Bank accounts' });
    await description.fill('Everyday account');
    await assetRow.getByLabel('New asset value at date of death').fill('24500.50');
    await assetRow.getByLabel('New asset value at date of death').press('Enter');
    await expect(assets).toContainText('Everyday account', SERVER);

    const liabilityRow = page.getByRole('form', { name: 'Add a liability' });
    await liabilityRow.getByLabel('New liability class').selectOption({ label: 'Funeral expenses' });
    await liabilityRow.getByLabel('New liability creditor').fill('Fictional Funerals');
    await liabilityRow.getByLabel('New liability amount').fill('9850');
    await liabilityRow.getByLabel('New liability amount').press('Enter');
    await expect(page.getByRole('table', { name: 'Liabilities' })).toContainText('Fictional Funerals', SERVER);

    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary).toContainText('$874,500.50');
    await expect(summary).toContainText('$864,650.50');

    // estate-onWrite keeps the matter's totals and the gross and net key facts.
    await expect
      .poll(async () => {
        const matter = await fieldsOf(request, `orgs/${orgId}/matters/m-rowe`);
        const estate = (matter['estate']?.['mapValue'] as { fields?: Fields } | undefined)?.fields;
        return [integer(estate, 'grossValueCents'), integer(estate, 'netValueCents')];
      }, SERVER)
      .toEqual([87_450_050, 86_465_050]);
    await expectNoA11yViolations(page);

    // A pecuniary gift to the beneficiary; the residue is shown after it.
    await page.getByRole('button', { name: 'Record distribution…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record a distribution' });
    await expect(dialog.getByLabel('Beneficiary')).toContainText('Ivy Rowe');
    await dialog.getByLabel('Amount').fill('20000');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Record distribution' }).click();
    await expect(dialog).toBeHidden(SERVER);
    const distributions = page.getByRole('list', { name: 'Distributions' });
    await expect(distributions).toContainText('Ivy Rowe');
    await expect(distributions).toContainText('Pecuniary gift · $20,000.00 · Planned');
    await expect(page.getByLabel('Residue calculation')).toContainText('$844,650.50');

    // The inventory as CSV, grouped by class with totals.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('Schedule of assets and liabilities (working draft) - M-2026-0420.csv');
    const csv = readFileSync((await download.path()) as string, 'utf8').split('\r\n');
    expect(csv).toContain(
      'Assets,Real property,"House, 3 Fictional Road, Ocean Grove",,850000.00,850000.00,,No,Valued,,,,,',
    );
    expect(csv).toContain('Assets,Real property,Total,,,850000.00,,,,,,,,');
    expect(csv).toContain('Summary,,Net estate,,,864650.50,,,,,,,,');

    // The PDF goes through estate-exportInventory and pdf.render (only queued under the emulators).
    await page.getByRole('button', { name: 'Export PDF' }).click();
    await expect(page.locator('mt-job-progress')).toContainText('Waiting to start', SERVER);
    await expectNoA11yViolations(page);
  });
});
