import { expect, test, type APIRequestContext } from '@playwright/test';

import { addDays, today } from '@materia/domain';
import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRST_CALL,
  FIRST_LOAD,
  FIRESTORE_EMULATOR,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Payments and aged debtors (BILL-08) against the emulators, behind `billing.invoicing`: an issued
 * invoice 16 days overdue; a lawyer records a part payment (the real `billing-recordPayment` makes
 * it part paid), the matter header shows what's still outstanding (`billing-outstandingOnInvoice`),
 * and the aged-debtors report (worked out by `billing-refreshDebtors`) lists the client in the
 * 1–30 days bucket with a 7-day reminder waiting for review, unsent. Fictional data only.
 */

const MATTER = 'm-quill';
const INVOICE = 'inv-quill-1';
const ADMIN = { Authorization: 'Bearer owner' };
const DOCS = `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;

type Fields = Record<string, Record<string, unknown>>;

async function setUp(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: MATTER,
    number: 'M-2026-0812',
    title: 'Estate of Ada Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const now = new Date();
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid, schemaVersion: 1 };
  const todayDate = today('Australia/Melbourne');
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Payments Practice',
        timezone: 'Australia/Melbourne',
        billing: { unitMinutes: 6, gstRegistered: true, invoicePrefix: 'INV-', paymentTermsDays: 14 },
        flags: { 'billing.invoicing': true },
      },
    },
    matter,
    {
      path: `orgs/${orgId}/invoices/${INVOICE}`,
      data: {
        number: 'INV-000042',
        matterId: MATTER,
        matterNumber: 'M-2026-0812',
        matterTitle: 'Estate of Ada Quill',
        grouping: 'itemised',
        excludedTimeEntryIds: [],
        excludedDisbursementIds: [],
        extraLines: [],
        timeEntryIds: [],
        disbursementIds: [],
        notes: '',
        paymentTermsDays: 14,
        issueDate: addDays(todayDate, -30),
        dueDate: addDays(todayDate, -16),
        lines: [
          {
            kind: 'fixed_fee',
            description: 'Grant of probate application',
            quantity: 1,
            amountExGstCents: 100_000,
            gstCents: 10_000,
          },
        ],
        subtotalCents: 100_000,
        gstCents: 10_000,
        totalCents: 110_000,
        gstRegistered: true,
        supplier: { name: 'Fictional Payments Practice' },
        buyer: { name: 'Bram Fictional' },
        status: 'issued',
        issuedAt: now,
        issuedBy: uid,
        pdfStatus: 'failed',
        creditNoteIds: [],
        creditedCents: 0,
        payments: [],
        ...meta,
      },
    },
  ]);
}

async function get(request: APIRequestContext, docPath: string): Promise<Fields> {
  const response = await request.get(`${DOCS}/${docPath}`, { headers: ADMIN });
  return ((await response.json()) as { fields?: Fields }).fields ?? {};
}

test.describe('payments and aged debtors', () => {
  test('record a part payment, see what’s outstanding, view the debtors', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Payments Practice' },
      displayName: 'Jordan Fictional',
    });
    await setUp(request, orgId, account.uid);

    // 1. Record a part payment against the overdue invoice.
    await page.goto(`/billing/invoices/${INVOICE}`);
    await expect(page.getByTestId('invoice-owing')).toHaveText('$1,100.00', FIRST_LOAD);
    await page.getByRole('button', { name: 'Record payment' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'Amount (AUD)' })).toHaveValue('1100.00');
    await dialog.getByRole('textbox', { name: 'Amount (AUD)' }).fill('400');
    await dialog.getByRole('textbox', { name: 'Reference' }).fill('EFT 7781');
    await expect(dialog).toContainText('Afterwards: $700.00 owing.');
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByTestId('invoice-status')).toHaveText('Part paid', FIRST_CALL);
    await expect(page.getByTestId('invoice-owing')).toHaveText('$700.00');
    await expect(page.getByTestId('payments')).toContainText('Ref EFT 7781');
    const invoice = await get(request, `orgs/${orgId}/invoices/${INVOICE}`);
    expect(invoice['status']).toEqual({ stringValue: 'part_paid' });

    // 2. The matter header shows what's still outstanding.
    await page.goto(`/matters/${MATTER}`);
    await expect(page.getByTestId('matter-outstanding')).toHaveText('Outstanding $700.00', FIRST_LOAD);

    // 3. The aged debtors: the client in the 1–30 days bucket, and a reminder waiting, unsent.
    await page.goto('/billing/debtors');
    const table = page.getByTestId('debtors');
    await expect(table).toContainText('Bram Fictional', FIRST_CALL);
    await expect(table).toContainText('M-2026-0812');
    await expect(page.getByTestId('debtors-total')).toHaveText('$700.00');
    const reminders = page.getByTestId('reminders');
    await expect(reminders).toContainText('INV-000042', FIRST_CALL);
    await expect(reminders).toContainText('over 7 days overdue');
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
  });
});
