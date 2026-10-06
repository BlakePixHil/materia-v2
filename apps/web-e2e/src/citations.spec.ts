import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { suggestionBasis, suggestionBasisParts } from '@materia/domain';
import { expectNoA11yViolations, setEmulatorDocuments, setOrgFlags, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Citations (AI-05) against the emulators: a Clerk suggestion on the matter Overview cites the
 * fictional will fixture, and so does a key fact accepted from Clerk (CORE-06a). Opening a chip
 * opens the citation viewer at the cited page with the quote highlighted from PDF.js's text layer
 * (the bytes come from `documents-getDownloadUrl`, the PDF from the Storage emulator); `]` and `[`
 * step through the sources, Esc closes. A deleted source reads "Removed document" with its quote;
 * a privileged one reads "Restricted source" to a paralegal. Fictional data only.
 */

const MATTER = 'm-ledger';
const OVERVIEW = `/matters/${MATTER}/overview`;
const BUCKET = 'demo-materia.appspot.com';
const STORAGE = 'http://127.0.0.1:9199';
const WILL_PDF = readFileSync(path.resolve(__dirname, '../../../libs/test-utils/fixtures/pdfs/will.pdf'));
/** Callables and the first reads cold-start the emulators. */
const SERVER = { timeout: 20_000 };
const DAY = 86_400_000;

/** Puts bytes in the Storage emulator, as the pipeline stores a version. */
async function putFile(request: APIRequestContext, storagePath: string, bytes: Buffer): Promise<void> {
  const response = await request.post(
    `${STORAGE}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`,
    { headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/pdf' }, data: bytes },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function setUp(page: Page, request: APIRequestContext, role: 'lawyer' | 'paralegal') {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'clerk.features.suggestions': true });
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role, orgName: 'Fictional Citations Practice' },
    displayName: 'Jordan Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const seeded = matterDoc(orgId, uid, {
    id: MATTER,
    number: 'M-2026-0420',
    title: 'Estate of Margaret Ledger',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const matter = { ...seeded.data, stageId: 'intake' };
  const base = seeded.path;
  const now = new Date();
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid, schemaVersion: 1 };
  const document = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    const storagePath = `${base}/documents/${id}/v1`;
    const version = {
      version: 1,
      storagePath,
      fileName: name,
      mime: 'application/pdf',
      sizeBytes: WILL_PDF.length,
      sha256: 'ab'.repeat(32),
      uploadedAt: now,
      uploadedBy: uid,
      pageCount: 2,
    };
    return {
      orgId,
      matterId: MATTER,
      name,
      category: 'will',
      privileged: false,
      accessRestricted: false,
      tags: [],
      storagePath,
      mime: 'application/pdf',
      sizeBytes: WILL_PDF.length,
      sha256: version.sha256,
      version: 1,
      versionSeq: 1,
      versions: [version],
      scan: { status: 'clean', at: now },
      ingest: { status: 'done' },
      source: 'upload',
      encrypted: false,
      search: [],
      deletedAt: null,
      ...meta,
      ...extra,
    };
  };
  const documents = {
    'd-will': document('d-will', 'Will of Margaret Ledger (fictional).pdf'),
    'd-advice': document('d-advice', 'Advice on the will (fictional).pdf', { privileged: true }),
    'd-note': document('d-note', 'File note (fictional).pdf', { deletedAt: now, deletedBy: uid }),
  };
  const cite = (documentId: string, page: number, quote: string) => ({
    kind: 'document',
    documentId,
    docVersion: 1,
    page,
    quote,
  });
  const citations = [
    cite('d-will', 1, 'I give the residue of my estate to my daughter Catherine Doyle absolutely.'),
    cite('d-will', 2, 'I direct that my executors pay my funeral expenses and debts from my estate.'),
    cite('d-note', 1, 'Thomas asked for a copy of the will.'),
    cite('d-advice', 1, 'The risk of a claim is low.'),
  ];
  const payload = { title: 'Confirm the residuary beneficiary', priority: 'medium' };
  const { basis, parts } = suggestionBasis(
    suggestionBasisParts({ kind: 'task', payload, citations }, { matter, documents }),
  );
  // A key fact Clerk read from the will's attestation clause (CORE-06a).
  const fact = { field: 'willDate', value: '2019-05-03' };
  const factCitations = [cite('d-will', 2, 'Signed by the will-maker in our presence on 3 May 2019 (fictional).')];
  const factBasis = suggestionBasis(
    suggestionBasisParts({ kind: 'key_fact', payload: fact, citations: factCitations }, { matter, documents }),
  );
  const proposed = {
    status: 'proposed',
    promptId: 'suggest-matter',
    promptVersion: '1.0.0',
    model: 'claude-sonnet-5-5',
    privileged: false,
    expiresAt: new Date(Date.now() + 14 * DAY),
    orgId,
    matterId: MATTER,
    ...meta,
    createdBy: 'clerk',
    updatedBy: 'clerk',
  };
  await setEmulatorDocuments(request, [
    { path: base, data: matter },
    ...Object.entries(documents).map(([id, data]) => ({ path: `${base}/documents/${id}`, data })),
    {
      path: `${base}/suggestions/s-residue`,
      data: {
        kind: 'task',
        payload,
        citations,
        rationale: 'The will leaves the residue to one daughter.',
        basis,
        basisParts: parts,
        dedupeKey: `task:${JSON.stringify(payload)}`,
        ...proposed,
      },
    },
    {
      path: `${base}/suggestions/s-will-date`,
      data: {
        kind: 'key_fact',
        payload: fact,
        citations: factCitations,
        rationale: 'The attestation clause dates the will.',
        basis: factBasis.basis,
        basisParts: factBasis.parts,
        dedupeKey: `key_fact:${fact.field}|${fact.value}`,
        ...proposed,
      },
    },
  ]);
  await putFile(request, documents['d-will'].storagePath, WILL_PDF);
}

const card = (page: Page) =>
  page
    .getByRole('region', { name: 'Clerk suggests…' })
    .getByRole('group', { name: 'Clerk suggestion: Confirm the residuary beneficiary' });
const chip = (page: Page, n: number) => card(page).getByRole('button', { name: new RegExp(`^Source ${n}:`) });
const viewer = (page: Page) => page.locator('mt-citation-viewer');

test.describe('Citations', () => {
  test('opens a cited passage at its page with the quote highlighted, steps through sources and closes', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await setUp(page, request, 'lawyer');
    await page.goto(OVERVIEW);

    await expect(chip(page, 1)).toHaveAccessibleName('Source 1: Will of Margaret Ledger (fictional).pdf p 1', SERVER);
    // A deleted source keeps its quote, and doesn't open.
    await expect(chip(page, 3)).toHaveAccessibleName(
      'Source 3: Removed document: “Thomas asked for a copy of the will.”',
    );
    await expect(chip(page, 3)).toHaveAttribute('aria-disabled', 'true');

    await chip(page, 1).click();
    const dialog = page.getByRole('dialog', { name: 'Will of Margaret Ledger (fictional).pdf, p 1' });
    await expect(dialog).toBeVisible(SERVER);
    await expect(dialog.getByLabel('Quoted passage')).toHaveText(
      'I give the residue of my estate to my daughter Catherine Doyle absolutely.',
    );
    await expect(viewer(page).locator('[data-page="1"] mark[data-highlight]').first()).toBeVisible(SERVER);
    await expect(viewer(page)).toHaveAttribute('data-highlighted', '');
    await expect(dialog.getByRole('link', { name: 'Open full document' })).toHaveAttribute(
      'href',
      `/matters/${MATTER}/documents/d-will?page=1`,
    );
    await expectNoA11yViolations(page);

    // ] moves to the next source: page 2, highlighted there.
    await page.keyboard.press(']');
    await expect(page.getByRole('dialog', { name: 'Will of Margaret Ledger (fictional).pdf, p 2' })).toBeVisible();
    await expect(viewer(page).locator('[data-page="2"] mark[data-highlight]').first()).toBeVisible(SERVER);
    await page.keyboard.press('[');
    await expect(page.getByRole('dialog', { name: 'Will of Margaret Ledger (fictional).pdf, p 1' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await expect(chip(page, 1)).toBeFocused();
  });

  test('a key fact accepted from Clerk keeps its source, until a person edits it (CORE-06a)', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await setUp(page, request, 'lawyer');
    await page.goto(OVERVIEW);

    const facts = page.getByRole('region', { name: 'Key facts' });
    const suggestion = page
      .getByRole('region', { name: 'Clerk suggests…' })
      .getByRole('group', { name: 'Clerk suggestion: Will date: 2019-05-03' });
    await suggestion.getByRole('button', { name: 'Save fact' }).click(SERVER);
    const source = facts.getByRole('button', { name: 'Source: Will of Margaret Ledger (fictional).pdf p 2' });
    await expect(source).toBeVisible(SERVER);

    await source.click();
    const dialog = page.getByRole('dialog', { name: 'Will of Margaret Ledger (fictional).pdf, p 2' });
    await expect(dialog).toBeVisible(SERVER);
    await expect(dialog.getByLabel('Quoted passage')).toHaveText(
      'Signed by the will-maker in our presence on 3 May 2019 (fictional).',
    );
    await expect(viewer(page).locator('[data-page="2"] mark[data-highlight]').first()).toBeVisible(SERVER);
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await expect(source).toBeFocused();

    // A person's edit drops the source.
    await facts.getByRole('button', { name: 'Edit Will date' }).click();
    await facts.getByRole('textbox', { name: 'Will date' }).fill('04/05/2019');
    await facts.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(facts.getByRole('button', { name: /^Source:/ })).toHaveCount(0, SERVER);
  });

  test('a privileged source is restricted for a paralegal and never opens', async ({ page, request }) => {
    test.setTimeout(90_000);
    await setUp(page, request, 'paralegal');
    await page.goto(OVERVIEW);

    await expect(chip(page, 4)).toHaveAccessibleName('Source 4: Restricted source', SERVER);
    await expect(card(page)).not.toContainText('Advice on the will');
    await expect(card(page)).not.toContainText('The risk of a claim is low.');
    await expect(chip(page, 4)).toHaveAttribute('aria-disabled', 'true');
    await chip(page, 4).focus();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});
