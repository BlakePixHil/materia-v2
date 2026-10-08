import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { suggestionBasis, suggestionBasisParts } from '@materia/domain';
import {
  expectNoA11yViolations,
  setClerkKey,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Clerk drafting (AI-10) against the emulators and the fake model: from the matter's ⋯ menu a
 * lawyer picks a bank balance request to someone typed in, Clerk drafts it on the server and the
 * letter streams into the editor with its `[[TO CONFIRM: …]]` placeholder highlighted and listed;
 * the lawyer edits it and saves it to the documents, where it is labelled "Draft — not sent".
 * Nothing on the way offers to send it. A letter Clerk suggested (AI-10b) opens the start page
 * filled in from its card, and starting it accepts the suggestion. Fictional data only.
 */

const MATTER = 'm-draft';
/** A line of the letter the emulator's fake model writes (FAKE_DRAFT_PARAGRAPHS). */
const DRAFTED = 'Please let us know the balance of each account';
/** Callables, Cloud Tasks and the first reads cold-start the emulators. */
const SERVER = { timeout: 30_000 };

/** A letter Clerk suggested after a chat answer (AI-10b), to someone who isn't a party. */
const SUGGESTED = {
  typeId: 'bank-balance-request',
  recipients: [{ name: 'Fictional Savings Bank' }],
  instructions: 'Ask for the balance at the date of death.',
};

async function setUp(page: Page, request: APIRequestContext, options: { suggested?: boolean } = {}) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, {
    'clerk.enabled': true,
    'clerk.features.drafting': true,
    ...(options.suggested ? { 'clerk.features.suggestions': true } : {}),
  });
  await setClerkKey(request, orgId);
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Drafting Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedClient(request, orgId, account.uid);
  const matter = matterDoc(orgId, account.uid, {
    id: MATTER,
    number: 'M-2026-0150',
    title: 'Estate of Fictional Wren',
    responsibleUid: account.uid,
    daysAgo: 1,
  });
  const data = { ...matter.data, stageId: 'intake' };
  const docs: { path: string; data: Record<string, unknown> }[] = [{ path: matter.path, data }];
  if (options.suggested) {
    // As `proposeSuggestions` writes it, with the basis the server computes from the same matter.
    const { basis, parts } = suggestionBasis(
      suggestionBasisParts({ kind: 'letter', payload: SUGGESTED, citations: [] }, { matter: data, documents: {} }),
    );
    const now = new Date();
    docs.push({
      path: `${matter.path}/suggestions/s-letter`,
      data: {
        kind: 'letter',
        payload: SUGGESTED,
        citations: [],
        rationale: 'The estate’s accounts need valuing at the date of death.',
        status: 'proposed',
        promptId: 'chat-proposals',
        promptVersion: '1.1.0',
        model: 'claude-sonnet-5-5',
        privileged: false,
        basis,
        basisParts: parts,
        dedupeKey: 'letter:bank-balance-request|fictional savings bank',
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
        orgId,
        matterId: MATTER,
        createdAt: now,
        createdBy: 'clerk',
        updatedAt: now,
        updatedBy: 'clerk',
        schemaVersion: 1,
      },
    });
  }
  await setEmulatorDocuments(request, docs);
}

const letter = (page: Page) => page.getByRole('textbox', { name: 'Letter' });

test.describe('Clerk drafting', () => {
  test('drafts a letter from the matter, takes the lawyer’s edits and files it unsent', async ({ page, request }) => {
    test.setTimeout(150_000);
    await setUp(page, request);
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { name: 'Estate of Fictional Wren' })).toBeVisible(SERVER);

    await page.getByRole('button', { name: 'More matter actions' }).click();
    await page.getByRole('menuitem', { name: 'Draft a letter with Clerk…' }).click();
    await expect(page.getByRole('heading', { name: 'Draft a letter with Clerk' })).toBeVisible(SERVER);
    await page.getByRole('radio', { name: 'Bank balance request' }).click();
    await page.getByRole('checkbox', { name: 'Someone else' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fictional Savings Bank');
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Draft letter' }).click();

    await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}/drafts/[^/]+$`), SERVER);
    await expect(letter(page)).toHaveValue(new RegExp(DRAFTED), SERVER);
    await expect(letter(page)).toBeEditable(SERVER);
    // The placeholder is highlighted behind the text and listed beside it.
    await expect(page.locator('mark', { hasText: '[[TO CONFIRM: date of death]]' })).toBeVisible();
    const side = page.getByRole('complementary', { name: 'Checking the draft' });
    await expect(side.getByRole('heading', { name: '1 thing to confirm' })).toBeVisible();
    await expect(side.getByRole('button', { name: 'date of death' })).toBeVisible();
    await expect(page.locator('mt-clerk-draft-page').getByRole('button', { name: /send/i })).toHaveCount(0);
    await expectNoA11yViolations(page);

    await letter(page).press('Control+End');
    await letter(page).pressSequentially('\n\nYours faithfully');
    await expect(page.getByText(/and you wrote [1-9]\d?%/)).toBeVisible(SERVER);

    await page.getByRole('button', { name: 'Save to documents' }).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dialog).toContainText('Save with 1 thing to confirm?');
    await dialog.getByRole('button', { name: 'Save anyway' }).click();
    await expect(page.locator('.mt-toaster')).toContainText('Saved to documents', SERVER);
    await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}/documents/[^/]+$`), SERVER);

    await page.goto(`/matters/${MATTER}/documents`);
    await expect(page.getByText('Draft — not sent').first()).toBeVisible(SERVER);
  });

  test('drafts a letter Clerk suggested: the card opens it filled in, and starting it accepts the suggestion', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await setUp(page, request, { suggested: true });
    await page.goto(`/matters/${MATTER}/overview`);
    const card = page
      .getByRole('region', { name: 'Clerk suggests…' })
      .getByRole('group', { name: /^Clerk suggestion: Bank balance request/ });
    await expect(card).toContainText('Fictional Savings Bank', SERVER);
    // The letter is checked on the start page, not edited on the card.
    await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Draft letter' }).click();

    await expect(page.getByRole('heading', { name: 'Draft a letter with Clerk' })).toBeVisible(SERVER);
    await expect(page.getByText('Clerk suggested this letter.')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Bank balance request' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Someone else' })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Fictional Savings Bank');
    await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(SUGGESTED.instructions);
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Draft letter' }).click();

    await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}/drafts/[^/]+$`), SERVER);
    await expect(letter(page)).toHaveValue(new RegExp(DRAFTED), SERVER);
    // Accepted with the draft: the card has left the Overview.
    await page.goto(`/matters/${MATTER}/overview`);
    await expect(page.getByRole('heading', { name: 'Estate of Fictional Wren' })).toBeVisible(SERVER);
    await expect(page.getByRole('group', { name: /^Clerk suggestion: Bank balance request/ })).toHaveCount(0, SERVER);
  });
});
