import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  expectNoA11yViolations,
  setEmulatorDocuments,
  signInAsTestUser,
  watchCspViolations,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Matter documents (CORE-12) against the emulators, through the real pipeline: files go to the
 * pending area in the Storage emulator, `documents-onUpload` checks, scans (the fake scanner flags
 * EICAR) and stores them, and every byte the viewer shows comes from `documents-getDownloadUrl`.
 * Fictional data only; the EICAR test string is assembled here, never committed as a file.
 */

const FIXTURES = path.resolve(__dirname, '../../../libs/test-utils/fixtures/pdfs');
const pdf = (name: string) => readFileSync(path.join(FIXTURES, name));

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const EML = [
  'From: Avery Quill <avery@example.test>',
  'To: Jordan Fictional <jordan@example.test>',
  'Subject: Fictional schedule of assets',
  'Date: Mon, 5 Oct 2026 09:00:00 +1000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="fictional-boundary"',
  '',
  '--fictional-boundary',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please find the fictional schedule attached.',
  '--fictional-boundary',
  'Content-Type: text/plain; name="schedule.txt"',
  'Content-Disposition: attachment; filename="schedule.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Fictional schedule: one house in Geelong, one bank account.\n').toString('base64'),
  '--fictional-boundary--',
  '',
].join('\r\n');

/** The anti-virus test string (harmless; every scanner flags it), built at test time. */
const eicar = () => ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function seedMatter(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0410',
    title: 'Estate of Rosalind Quill',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [{ ...matter, data: { ...matter.data, stageId: 'intake' } }]);
}

/** A document as the pipeline stores it (no bytes: for list and access checks only). */
function storedDocument(orgId: string, uid: string, id: string, name: string, privileged: boolean) {
  const sha256 = id
    .padEnd(64, '0')
    .replace(/[^0-9a-f]/g, 'a')
    .slice(0, 64);
  const storagePath = `orgs/${orgId}/matters/m-quill/documents/${id}/v1`;
  return {
    path: `orgs/${orgId}/matters/m-quill/documents/${id}`,
    data: {
      orgId,
      matterId: 'm-quill',
      name,
      category: 'correspondence',
      privileged,
      accessRestricted: false,
      tags: [],
      storagePath,
      mime: 'application/pdf',
      sizeBytes: 1200,
      sha256,
      version: 1,
      versionSeq: 1,
      versions: [
        {
          version: 1,
          storagePath,
          fileName: name,
          mime: 'application/pdf',
          sizeBytes: 1200,
          sha256,
          uploadedAt: new Date(),
          uploadedBy: uid,
        },
      ],
      scan: { status: 'clean', at: new Date() },
      ingest: { status: 'pending' },
      source: 'upload',
      encrypted: false,
      deletedAt: null,
      ...meta(uid),
    },
  };
}

const uploads = (page: Page) => page.getByRole('region', { name: 'Uploads' });
const uploadRow = (page: Page, fileName: string): Locator =>
  uploads(page).getByRole('listitem').filter({ hasText: fileName });
const documentsTable = (page: Page) => page.getByRole('table', { name: 'Documents' });

/** The pipeline runs in the Functions emulator (the first upload cold-starts it). */
const PIPELINE = { timeout: 60_000 };

test.describe('matter documents', () => {
  test('upload several files, quarantine EICAR, preview, rename, privilege, version, restore and download', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    // Uploads, PDF.js (worker, WebAssembly, fonts), signed-URL images and previews, under the CSP.
    const csp = watchCspViolations(page);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Documents Practice' },
      displayName: 'Jordan Fictional',
    });
    await seedMatter(request, orgId, account.uid);

    // An empty Documents tab.
    await page.goto('/matters/m-quill/documents');
    await expect(page.getByRole('heading', { name: 'No documents yet' })).toBeVisible({ timeout: 20_000 });
    await expectNoA11yViolations(page);

    // Four files at once: each is sent, scanned and stored.
    await page.getByTestId('document-upload-input').setInputFiles([
      { name: 'will.pdf', mimeType: 'application/pdf', buffer: pdf('will.pdf') },
      { name: 'garden.png', mimeType: 'image/png', buffer: PNG },
      {
        name: 'file-note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fictional file note: called the executor.\n'),
      },
      { name: 'schedule-letter.eml', mimeType: 'message/rfc822', buffer: Buffer.from(EML) },
    ]);
    for (const name of ['will.pdf', 'garden.png', 'file-note.txt', 'schedule-letter.eml']) {
      await expect(uploadRow(page, name)).toContainText('Ready', PIPELINE);
    }
    await expect(documentsTable(page).getByRole('row')).toHaveCount(5);
    await expectNoA11yViolations(page);

    // The EICAR test file is quarantined: deleted, and the person is told.
    await page
      .getByTestId('document-upload-input')
      .setInputFiles([{ name: 'eicar-test.txt', mimeType: 'text/plain', buffer: Buffer.from(eicar()) }]);
    await expect(uploadRow(page, 'eicar-test.txt')).toContainText('Quarantined', PIPELINE);

    // The same file twice is a possible duplicate: discard the copy.
    await page.getByTestId('document-upload-input').setInputFiles([
      {
        name: 'file-note-copy.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fictional file note: called the executor.\n'),
      },
    ]);
    const copy = uploadRow(page, 'file-note-copy.txt');
    await expect(copy).toContainText('Duplicate of file-note.txt', PIPELINE);
    await copy.getByRole('button', { name: 'Discard' }).click();
    await expect(copy).toContainText('Discarded', PIPELINE);

    // From here the test moves between the list and a document inside the app, as a person does.
    // A full reload straight after this much upload and listener traffic intermittently never
    // showed the list again on WebKit (CI: the will.pdf link missing for 3+ minutes); the deep link
    // below is the one deliberate page load.
    // Preview the will at its second page (a citation link): PDF.js renders it from a signed URL.
    await documentsTable(page).getByRole('link', { name: 'will.pdf' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/documents\/[\w-]+$/);
    const docUrl = page.url();
    await page.goto(`${docUrl}?page=2`);
    const viewer = page.locator('mt-pdf-viewer');
    await expect(viewer).toContainText('Page 2 of 2', PIPELINE);
    await expect(viewer.locator('[data-page="2"][data-rendered] canvas')).toBeVisible();
    await expectNoA11yViolations(page);

    // Rename it.
    await page.getByLabel('Name', { exact: true }).fill('Will of Rosalind Quill (fictional).pdf');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Will of Rosalind Quill (fictional).pdf' })).toBeVisible();

    // Flag it privileged.
    await page.locator('mt-document-details').getByRole('switch', { name: 'Privileged' }).click();
    await expect(page.locator('.head mt-badge', { hasText: 'Privileged' })).toBeVisible();

    // A new version, then restore the first: history only grows.
    await page
      .getByTestId('version-upload-input')
      .setInputFiles([{ name: 'will-signed.pdf', mimeType: 'application/pdf', buffer: pdf('court-order.pdf') }]);
    await expect(uploadRow(page, 'will-signed.pdf')).toContainText('Added as version 2', PIPELINE);
    const versions = page.getByRole('region', { name: 'Versions' });
    await expect(versions).toContainText('Version 2 (current)');
    await versions.getByRole('button', { name: 'Restore version 1' }).click();
    await expect(versions).toContainText('Version 3 (current)', PIPELINE);
    await expect(versions).toContainText('restored from version 1');

    // Download: a short-lived signed URL, served as an attachment.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const file = await download;
    expect(file.url()).toContain('X-Goog-Expires=');
    expect(file.url()).toContain('response-content-disposition=attachment');
    expect(file.url()).not.toContain('firebasestorage.googleapis.com');

    // The email previews as headers, body and attachments; an attachment can be saved to the matter.
    await page.getByRole('link', { name: 'All documents' }).click();
    await documentsTable(page).getByRole('link', { name: 'schedule-letter.eml' }).click();
    const message = page.locator('mt-message-preview');
    await expect(message).toContainText('Fictional schedule of assets', PIPELINE);
    await expect(message).toContainText('Please find the fictional schedule attached.');
    await expectNoA11yViolations(page);
    await message.getByRole('button', { name: 'Save schedule.txt to the matter' }).click();
    await expect(page.getByText('schedule.txt saved to the matter', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'All documents' }).click();
    await expect(documentsTable(page).getByRole('link', { name: 'schedule.txt' })).toBeVisible(PIPELINE);
    expect(csp(), 'Content Security Policy violations').toEqual([]);
  });

  test('a read-only member never sees privileged documents', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'readonly', orgName: 'Fictional Documents Practice' },
      displayName: 'Sam Fictional',
    });
    await seedMatter(request, orgId, account.uid);
    await setEmulatorDocuments(request, [
      storedDocument(orgId, account.uid, 'd-letter', 'Letter to the executor (fictional).pdf', false),
      storedDocument(orgId, account.uid, 'd-advice', 'Advice on the claim (fictional).pdf', true),
    ]);

    await page.goto('/matters/m-quill/documents');
    const table = documentsTable(page);
    // The emulators are shared with other workers: the first read can take a while.
    await expect(table.getByRole('link', { name: 'Letter to the executor (fictional).pdf' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Advice on the claim (fictional).pdf')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload' })).toHaveCount(0);
    await expectNoA11yViolations(page);

    // A direct link to the privileged one says only that it isn't available.
    await page.goto('/matters/m-quill/documents/d-advice');
    await expect(page.getByRole('heading', { name: 'Document not available' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Advice on the claim')).toHaveCount(0);
  });
});
