import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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
 * Nothing on the way offers to send it. Fictional data only.
 */

const MATTER = 'm-draft';
/** A line of the letter the emulator's fake model writes (FAKE_DRAFT_PARAGRAPHS). */
const DRAFTED = 'Please let us know the balance of each account';
/** Callables, Cloud Tasks and the first reads cold-start the emulators. */
const SERVER = { timeout: 30_000 };

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  await setOrgFlags(request, orgId, { 'clerk.enabled': true, 'clerk.features.drafting': true });
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
  await setEmulatorDocuments(request, [{ path: matter.path, data: { ...matter.data, stageId: 'intake' } }]);
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
});
