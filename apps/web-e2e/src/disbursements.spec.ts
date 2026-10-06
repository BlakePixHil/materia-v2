import { readFileSync } from 'node:fs';
import path from 'node:path';

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
 * Disbursements (BILL-04) against the emulators, behind `billing.disbursements` (on for this org):
 * a GST-free death certificate from a preset with its receipt uploaded from the form through the
 * real CORE-12 pipeline, then a taxable courier entered GST-inclusive. `disbursements-onWrite`
 * recomputes each GST and counts the ex-GST amounts into the matter's `disbursementWipCents`.
 * Fictional data only.
 */

const URL = '/matters/m-quill/time';
const FIXTURES = path.resolve(__dirname, '../../../libs/test-utils/fixtures/pdfs');

/** The upload pipeline runs in the Functions emulator (the first upload cold-starts it). */
const PIPELINE = { timeout: 60_000 };

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0520',
    title: 'Estate of Harriet Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Disbursements Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
        flags: { 'billing.disbursements': true },
      },
    },
    matter,
  ]);
}

const section = (page: Page) => page.getByTestId('disbursements');
const form = (page: Page) => page.getByRole('form', { name: 'Record a disbursement' });

/** The stored disbursements of the matter (description → fields). */
async function stored(request: APIRequestContext, orgId: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-quill/disbursements?pageSize=100`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as { documents?: { fields: Record<string, Record<string, unknown>> }[] };
  return new Map((body.documents ?? []).map((doc) => [String(doc.fields['description']?.['stringValue']), doc.fields]));
}

async function disbursementWip(request: APIRequestContext, orgId: string): Promise<unknown> {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-quill`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  return ((await response.json()) as { fields?: Record<string, Record<string, unknown>> }).fields?.[
    'disbursementWipCents'
  ];
}

test.describe('disbursements', () => {
  test('adds a disbursement with an uploaded receipt, and a GST-inclusive one; the trigger counts WIP', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Disbursements Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);
    await page.goto(URL);
    await expect(page.getByRole('heading', { level: 2, name: 'Disbursements' })).toBeVisible();
    await expect(section(page)).toContainText('No disbursements yet');

    // 1. A death certificate from its preset (GST-free, payee filled), with the receipt uploaded here.
    await section(page).getByRole('button', { name: 'Add disbursement' }).click();
    await expect(form(page)).toBeVisible();
    await form(page).getByLabel('Preset').selectOption({ label: 'Death certificate' });
    await expect(form(page).getByLabel('Description')).toHaveValue('Death certificate');
    await expect(form(page).getByLabel('GST').locator('option:checked')).toHaveText('GST-free');
    await form(page).getByLabel('Amount paid (AUD)').fill('35.30');
    await expect(form(page).getByTestId('disbursement-preview')).toHaveText('$35.30, no GST');
    await expectNoA11yViolations(page);
    await form(page)
      .getByTestId('receipt-file')
      .setInputFiles([
        {
          name: 'death-certificate.pdf',
          mimeType: 'application/pdf',
          buffer: readFileSync(path.join(FIXTURES, 'death-certificate.pdf')),
        },
      ]);
    // Picked as soon as the pipeline has made it a document.
    await expect(form(page).getByLabel('Receipt').locator('option:checked')).toHaveText(/death-certificate/, PIPELINE);
    await expect(form(page).getByRole('button', { name: 'Add disbursement' })).toBeEnabled(PIPELINE);
    await form(page).getByRole('button', { name: 'Add disbursement' }).click();
    await expect(form(page)).toHaveCount(0);
    const certificate = section(page).getByRole('row').filter({ hasText: 'Death certificate' });
    await expect(certificate).toContainText('$35.30');
    await expect(certificate.getByRole('link', { name: 'Open the receipt' })).toBeVisible();

    // 2. A courier entered GST-inclusive: $11.05 is $10.05 + $1.00 GST (the cent sits in the GST).
    await section(page).getByRole('button', { name: 'Add disbursement' }).click();
    await form(page).getByLabel('Description').fill('Courier of original will to Geelong');
    await form(page).getByLabel('Category').selectOption({ label: 'Courier and postage' });
    await form(page).getByLabel('GST').selectOption({ label: 'Taxable (10% GST)' });
    await form(page).getByRole('radio', { name: 'Incl. GST' }).click();
    await form(page).getByLabel('Amount paid (AUD)').fill('11.05');
    await expect(form(page).getByTestId('disbursement-preview')).toHaveText('$10.05 + $1.00 GST = $11.05');
    await form(page).getByRole('button', { name: 'Add disbursement' }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(section(page).getByRole('row').filter({ hasText: 'Courier of original will' })).toContainText(
      '$11.05',
    );
    await expect(page.getByTestId('disbursement-totals')).toContainText('2 unbilled');
    await expectNoA11yViolations(page);

    // disbursements-onWrite recomputed the amounts and counted the ex-GST sum: 3530 + 1005.
    await expect
      .poll(async () => (await stored(request, orgId)).get('Death certificate'), { timeout: 30_000 })
      .toMatchObject({
        amountExGstCents: { integerValue: '3530' },
        gstCents: { integerValue: '0' },
        wipCountedCents: { integerValue: '3530' },
        receiptDocumentId: { stringValue: expect.any(String) },
      });
    await expect
      .poll(async () => (await stored(request, orgId)).get('Courier of original will to Geelong'), {
        timeout: 30_000,
      })
      .toMatchObject({ amountExGstCents: { integerValue: '1005' }, gstCents: { integerValue: '100' } });
    await expect.poll(() => disbursementWip(request, orgId), { timeout: 30_000 }).toEqual({ integerValue: '4535' });
  });
});
