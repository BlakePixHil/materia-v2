import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

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
 * Invoicing (BILL-07) against the emulators, behind `billing.invoicing` (on for this org): a
 * lawyer starts a pre-bill from the matter's Time tab, leaves an entry out and adds a fixed fee in
 * the live preview, issues it (the real `billing-issueInvoice` numbers it INV-000001 and marks the
 * work billed), the PDF render finishes (the emulator's job runner doesn't run Cloud Run, so the
 * test lands the job's output as the jobs service would), and the invoice is emailed with the PDF
 * attached through the emulator's fake mail. In light and dark. Fictional data only.
 */

const MATTER = 'm-hollis';
const TIME = `/matters/${MATTER}/time`;
const BUCKET = 'demo-materia.appspot.com';
const STORAGE = 'http://127.0.0.1:9199';
const PDF = readFileSync(path.resolve(__dirname, '../../../libs/test-utils/fixtures/pdfs/will.pdf'));
const ADMIN = { Authorization: 'Bearer owner' };
const DOCS = `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;

type Fields = Record<string, Record<string, unknown>>;

async function setUp(request: APIRequestContext, orgId: string, uid: string): Promise<string> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: MATTER,
    number: 'M-2026-0731',
    title: 'Estate of Edith Hollis',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const now = new Date();
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid, schemaVersion: 1 };
  const entry = (id: string, date: string, units: number, narrative: string) => ({
    path: `${matter.path}/timeEntries/${id}`,
    data: {
      orgId,
      matterId: MATTER,
      uid,
      date,
      minutes: units * 6,
      units,
      rateCents: 44_000,
      amountCents: units * 4_400,
      narrative,
      billable: true,
      status: 'final',
      source: 'manual',
      wipCountedCents: units * 4_400,
      deletedAt: null,
      ...meta,
    },
  });
  await setEmulatorDocuments(request, [
    {
      path: `orgs/${orgId}`,
      data: {
        name: 'Fictional Invoicing Practice',
        abn: '51824753556',
        timezone: 'Australia/Melbourne',
        billing: {
          unitMinutes: 6,
          rounding: 'up',
          defaultRateCents: 44_000,
          gstRegistered: true,
          invoicePrefix: 'INV-',
          paymentTermsDays: 14,
        },
        flags: { 'billing.invoicing': true },
      },
    },
    {
      path: `orgs/${orgId}/contacts/c-client`,
      data: {
        kind: 'person',
        givenNames: 'Bram',
        familyName: 'Fictional',
        sortName: 'fictional bram',
        emails: [{ type: 'personal', address: 'bram.fictional@example.com' }],
        phones: [],
        addresses: [{ type: 'postal', line1: '1 Fictional St', suburb: 'Geelong', state: 'VIC', postcode: '3220' }],
        tags: [],
        isReferrer: false,
        search: [],
        deletedAt: null,
        ...meta,
      },
    },
    matter,
    entry('te-1', '2026-09-28', 10, 'Perused the will and death certificate'),
    entry('te-2', '2026-09-29', 5, 'Letter to the executor'),
    entry('te-3', '2026-09-30', 3, 'Call with the bank'),
  ]);
  return matter.path;
}

async function get(request: APIRequestContext, docPath: string): Promise<Fields> {
  const response = await request.get(`${DOCS}/${docPath}`, { headers: ADMIN });
  return ((await response.json()) as { fields?: Fields }).fields ?? {};
}

/** Lands a finished PDF render as the jobs service does: the file, its matter document, the job's output. */
async function finishPdfJob(request: APIRequestContext, orgId: string, matterPath: string, jobId: string) {
  const documentId = `job-${jobId}`;
  const storagePath = `${matterPath}/documents/${documentId}/v1`;
  const upload = await request.post(
    `${STORAGE}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`,
    { headers: { ...ADMIN, 'Content-Type': 'application/pdf' }, data: PDF },
  );
  expect(upload.ok(), await upload.text()).toBe(true);
  const now = new Date();
  const version = {
    version: 1,
    storagePath,
    fileName: 'Tax invoice INV-000001.pdf',
    mime: 'application/pdf',
    sizeBytes: PDF.length,
    sha256: 'ab'.repeat(32),
    uploadedAt: now,
    uploadedBy: 'system',
    pageCount: 2,
  };
  await setEmulatorDocuments(request, [
    {
      path: `${matterPath}/documents/${documentId}`,
      data: {
        orgId,
        matterId: MATTER,
        name: 'Tax invoice INV-000001.pdf',
        category: 'financial',
        privileged: false,
        accessRestricted: false,
        tags: [],
        storagePath,
        mime: 'application/pdf',
        sizeBytes: PDF.length,
        sha256: version.sha256,
        version: 1,
        versionSeq: 1,
        versions: [version],
        scan: { status: 'clean', at: now },
        ingest: { status: 'done' },
        source: 'generated',
        encrypted: false,
        search: [],
        deletedAt: null,
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        updatedBy: 'system',
        schemaVersion: 1,
      },
    },
  ]);
  // Only the job's status and output change, as the runner writes them (`billing-onPdfJob` reacts).
  const response = await request.patch(
    `${DOCS}/orgs/${orgId}/jobs/${jobId}?updateMask.fieldPaths=status&updateMask.fieldPaths=output`,
    {
      headers: ADMIN,
      data: {
        fields: {
          status: { stringValue: 'succeeded' },
          output: {
            mapValue: {
              fields: {
                storagePath: { stringValue: storagePath },
                sizeBytes: { integerValue: String(PDF.length) },
                documentId: { stringValue: documentId },
                pages: { integerValue: '2' },
              },
            },
          },
        },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/** The emulator's fake mail: what was sent to an address. */
async function outbox(request: APIRequestContext, to: string): Promise<Fields[]> {
  const response = await request.post(`${DOCS}:runQuery`, {
    headers: ADMIN,
    data: {
      structuredQuery: {
        from: [{ collectionId: 'emulatorOutbox' }],
        where: { fieldFilter: { field: { fieldPath: 'to' }, op: 'EQUAL', value: { stringValue: to } } },
      },
    },
  });
  const rows = (await response.json()) as { document?: { fields: Fields } }[];
  return rows.flatMap((row) => (row.document ? [row.document.fields] : []));
}

test.describe('invoicing', () => {
  test('pre-bill → issue → PDF → email, in light and dark', async ({ page, request }) => {
    test.setTimeout(180_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Invoicing Practice' },
      displayName: 'Jordan Fictional',
    });
    const matterPath = await setUp(request, orgId, account.uid);

    // 1. Start a pre-bill from the matter's bills: every approved, unbilled entry is on it.
    await page.goto(TIME);
    const bills = page.getByTestId('matter-bills');
    await expect(bills).toContainText('No bills yet', FIRST_LOAD);
    await bills.getByRole('button', { name: 'New pre-bill' }).click();
    await expect(page).toHaveURL(/\/billing\/invoices\/[^/]+$/, FIRST_CALL);
    const preview = page.getByTestId('pre-bill-preview');
    // $440 + $220 + $132 ex GST, plus 10% GST on each line.
    await expect(page.getByTestId('pre-bill-total')).toHaveText('$871.20', FIRST_LOAD);

    // 2. Leave the call out and add a fixed fee: the preview follows.
    await page
      .getByTestId('pre-bill-time')
      .getByRole('checkbox', { name: /Call with the bank/ })
      .click();
    await page.getByRole('button', { name: 'Add fixed fee' }).click();
    await page.getByRole('textbox', { name: 'Fixed fee' }).fill('Grant of probate application');
    await page.getByRole('textbox', { name: 'Amount ex GST' }).fill('1100');
    await expect(preview).toContainText('Grant of probate application');
    await expect(page.getByTestId('pre-bill-total')).toHaveText('$1,936.00');
    await expectNoA11yViolations(page);

    // 3. Issue it: it saves the choices, takes INV-000001 and becomes the invoice.
    await page.getByRole('button', { name: 'Issue invoice' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('$1,936.00 on M-2026-0731');
    await confirm.getByRole('button', { name: 'Issue invoice' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tax invoice INV-000001' })).toBeVisible(FIRST_CALL);
    await expect(page.getByTestId('invoice-pdf-pending')).toBeVisible();
    const invoiceId = page.url().split('/').pop() as string;
    const invoice = await get(request, `orgs/${orgId}/invoices/${invoiceId}`);
    expect(invoice['number']).toEqual({ stringValue: 'INV-000001' });
    expect(invoice['totalCents']).toEqual({ integerValue: '193600' });
    // The included work is billed with the invoice; the left-out entry isn't.
    expect((await get(request, `${matterPath}/timeEntries/te-1`))['status']).toEqual({ stringValue: 'billed' });
    expect((await get(request, `${matterPath}/timeEntries/te-3`))['status']).toEqual({ stringValue: 'final' });

    // 4. The PDF render finishes: the invoice shows it.
    const jobId = String(invoice['pdfJobId']?.['stringValue']);
    await finishPdfJob(request, orgId, matterPath, jobId);
    await expect(page.getByLabel('PDF').locator('mt-pdf-viewer')).toBeVisible(FIRST_CALL);
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });

    // 5. Email it to the client (the default "To"), with the PDF attached.
    await page.getByRole('button', { name: 'Email invoice' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'To' })).toHaveValue('bram.fictional@example.com');
    await dialog.getByRole('textbox', { name: 'Message' }).fill('Thank you for your instructions.');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('invoice-sent')).toContainText('to 1 address', FIRST_CALL);
    const sent = await outbox(request, 'bram.fictional@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['template']).toEqual({ stringValue: 'invoice' });
    expect(JSON.stringify(sent[0]?.['attachments'])).toContain('Tax invoice INV-000001.pdf');

    // 6. It's listed with what's owing.
    await page.goto('/billing/invoices');
    await expect(page.getByTestId('invoices')).toContainText('INV-000001', FIRST_LOAD);
    await expect(page.getByTestId('invoices-summary')).toHaveText('$1,936.00 owing on 1 issued');
  });
});
