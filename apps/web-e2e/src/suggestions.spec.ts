import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { suggestionBasis, suggestionBasisParts, type SuggestionKind } from '@materia/domain';
import { expectNoA11yViolations, setEmulatorDocuments, setOrgFlags, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Clerk suggestions on the matter Overview (AI-07) against the emulators: accept a suggested task
 * (it shows under Open tasks), edit a suggested note before accepting it (the edited text is what
 * gets pinned), and dismiss one with a reason, each through the real `suggestions-*` callables.
 * The suggestions are stored as `proposeSuggestions` writes them, with the basis the server
 * computes from the same matter and document. Fictional data only.
 */

const OVERVIEW = '/matters/m-marlow/overview';
/** Callables cold-start the Functions emulator. */
const SERVER = { timeout: 20_000 };
const DAY = 86_400_000;

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'clerk.features.suggestions': true });
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Suggestions Practice' },
    displayName: 'Jordan Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const seeded = matterDoc(orgId, uid, {
    id: 'm-marlow',
    number: 'M-2026-0412',
    title: 'Estate of Edwin Marlow',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const matter = { ...seeded.data, stageId: 'intake' };
  const base = seeded.path;
  const now = new Date();
  const meta = { createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid, schemaVersion: 1 };
  const document = {
    orgId,
    matterId: 'm-marlow',
    name: 'Will of Edwin Marlow',
    category: 'will',
    privileged: false,
    tags: [],
    version: 1,
    versions: [],
    scan: { status: 'clean' },
    ingest: { status: 'done' },
    source: 'upload',
    encrypted: false,
    accessRestricted: false,
    search: [],
    deletedAt: null,
    ...meta,
  };
  const citations = [{ documentId: 'd-will', page: 2, quote: 'my house at 9 Fictional Lane' }];
  const suggestion = (kind: SuggestionKind, payload: Record<string, unknown>, rationale: string) => {
    const { basis, parts } = suggestionBasis(
      suggestionBasisParts({ kind, payload, citations }, { matter, documents: { 'd-will': document } }),
    );
    return {
      kind,
      payload,
      citations,
      rationale,
      status: 'proposed',
      promptId: 'suggest-matter',
      promptVersion: '1.0.0',
      model: 'claude-sonnet-5-5',
      privileged: false,
      basis,
      basisParts: parts,
      dedupeKey: `${kind}:${JSON.stringify(payload)}`,
      expiresAt: new Date(Date.now() + 14 * DAY),
      orgId,
      matterId: 'm-marlow',
      ...meta,
      createdBy: 'clerk',
      updatedBy: 'clerk',
    };
  };
  await setEmulatorDocuments(request, [
    { path: base, data: matter },
    { path: `${base}/documents/d-will`, data: document },
    {
      path: `${base}/suggestions/s-valuation`,
      data: suggestion(
        'task',
        { title: 'Order a valuation of 9 Fictional Lane', priority: 'medium' },
        'The will leaves the house to the residuary beneficiaries.',
      ),
    },
    {
      path: `${base}/suggestions/s-note`,
      data: suggestion(
        'note',
        { bodyMd: 'The house goes to the residuary beneficiaries.', pinned: true },
        'Worth keeping on the file.',
      ),
    },
    {
      path: `${base}/suggestions/s-bank`,
      data: suggestion('task', { title: 'Write to the bank', priority: 'none' }, 'The will mentions a bank account.'),
    },
  ]);
  return { orgId, uid };
}

const region = (page: Page) => page.getByRole('region', { name: 'Clerk suggests…' });
const card = (page: Page, title: string) => region(page).getByRole('group', { name: `Clerk suggestion: ${title}` });

test.describe('Clerk suggestions', () => {
  test('accept, edit then accept, and dismiss on the matter Overview', async ({ page, request }) => {
    test.setTimeout(120_000);
    await setUp(page, request);

    await page.goto(OVERVIEW);
    await expect(region(page)).toBeVisible(SERVER);
    // The chip names the cited document once it's read (AI-05).
    await expect(card(page, 'Order a valuation of 9 Fictional Lane')).toContainText('Will of Edwin Marlow p 2');
    await expect(region(page).getByRole('button', { name: 'Accept all 2 tasks' })).toBeVisible();
    await expectNoA11yViolations(page);

    // Accept: the task is created and the suggestion leaves the list.
    const valuation = card(page, 'Order a valuation of 9 Fictional Lane');
    await valuation.getByRole('button', { name: 'Add task' }).click();
    await expect(valuation).toBeHidden(SERVER);
    await expect(page.locator('.mt-toaster')).toContainText('Suggestion accepted');
    await expect(page.getByRole('region', { name: 'Open tasks' })).toContainText(
      'Order a valuation of 9 Fictional Lane',
      SERVER,
    );

    // Edit, then accept: the edited text is what's pinned.
    const note = card(page, 'The house goes to the residuary beneficiaries.');
    await note.getByRole('button', { name: 'Edit' }).click();
    const editor = note.getByRole('form', { name: 'Edit note' });
    const body = editor.getByRole('textbox', { name: 'Note' });
    await body.fill('');
    await editor.getByRole('button', { name: 'Accept edited' }).click();
    await expect(editor).toContainText('Note can’t be empty');
    await body.fill('The house at 9 Fictional Lane goes to the residuary beneficiaries; confirm the title.');
    await expectNoA11yViolations(page);
    await editor.getByRole('button', { name: 'Accept edited' }).click();
    await expect(note).toBeHidden(SERVER);
    await expect(page.locator('.mt-toaster')).toContainText('Accepted with your changes');
    await expect(page.getByRole('region', { name: 'Pinned notes' })).toContainText('confirm the title.', SERVER);

    // Dismiss with a reason.
    const bank = card(page, 'Write to the bank');
    await bank.getByRole('button', { name: 'Dismiss' }).click();
    const dismiss = bank.getByRole('form', { name: 'Dismiss suggestion' });
    await dismiss.getByLabel('Why dismiss it?').selectOption({ label: 'Already done' });
    await expectNoA11yViolations(page);
    await dismiss.getByRole('button', { name: 'Dismiss' }).click();
    await expect(bank).toBeHidden(SERVER);
    await expect(region(page)).toContainText('No suggestions right now.');
  });
});
