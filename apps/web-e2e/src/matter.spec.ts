import { expect, test, type APIRequestContext } from '@playwright/test';

import { contactSearchTokens, partyDocId } from '@materia/domain';
import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The matter screen (CORE-06) against the emulators: open a matter, record a key fact, add a party
 * through the real `matters-upsertParty` callable, move between tabs, deep-link to one and come
 * back with the browser's back button. Fictional data only.
 */

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-quill',
    number: 'M-2026-0310',
    title: 'Estate of Rosalind Quill',
    responsibleUid: uid,
    daysAgo: 2,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake', estate: { grantType: 'probate' } } },
    {
      path: `orgs/${orgId}/matters/m-quill/parties/${partyDocId('client', 'c-client')}`,
      data: {
        contactId: 'c-client',
        role: 'client',
        orgId,
        matterId: 'm-quill',
        addedFrom: 'manual',
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/contacts/c-tamsin`,
      data: {
        kind: 'person',
        givenNames: 'Tamsin',
        familyName: 'Larkwood',
        sortName: 'larkwood tamsin',
        emails: [],
        phones: [],
        addresses: [],
        tags: [],
        isReferrer: false,
        search: contactSearchTokens({ givenNames: 'Tamsin', familyName: 'Larkwood' }),
        deletedAt: null,
        ...meta(uid),
      },
    },
  ]);
}

test.describe('matter screen', () => {
  test('edit a key fact, add a party, switch and deep-link tabs, and go back', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Matter Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);

    // Open the matter: it lands on the Overview.
    await page.goto('/matters/m-quill');
    await expect(page).toHaveURL(/\/matters\/m-quill\/overview$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Rosalind Quill', FIRST_LOAD);
    await expect(page).toHaveTitle(/M-2026-0310/);
    const facts = page.locator('mt-key-facts');
    await expect(facts).toContainText('Grant number');
    await expectNoA11yViolations(page);

    // Record a key fact inline; it is written to the matter and shown.
    await page.getByRole('button', { name: 'Edit Grant number' }).click();
    await page.getByLabel('Grant number').fill('SP-2026-04417');
    await facts.getByRole('button', { name: 'Save' }).click();
    await expect(facts).toContainText('SP-2026-04417');
    await page.reload();
    await expect(page.locator('mt-key-facts')).toContainText('SP-2026-04417', FIRST_LOAD);

    // Switch to Parties from the tabs.
    const tabs = page.getByRole('navigation', { name: 'Matter sections' });
    await tabs.getByRole('link', { name: 'Parties' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/parties$/);
    const parties = page.locator('mt-matter-parties');
    await expect(parties).toContainText('Bram Fictional');

    // Add a beneficiary found by search, with a share (the real callable).
    await page.getByRole('button', { name: 'Add party' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add a party' })).toBeVisible();
    await dialog.getByLabel('Find a contact').fill('larkwood');
    await dialog.getByRole('button', { name: /Tamsin Larkwood/ }).click();
    await dialog.getByLabel('Share').fill('Residue, equally');
    await dialog.getByRole('button', { name: 'Add party' }).click();
    // The first call cold-starts the Functions emulator.
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(parties).toContainText('Tamsin Larkwood');
    await expect(parties).toContainText('Residue, equally');
    await expectNoA11yViolations(page);

    // Another tab, then a deep link straight to one, then back.
    await tabs.getByRole('link', { name: 'Notes' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/notes$/);
    await expect(page).toHaveTitle(/Notes/);

    await page.goto('/matters/m-quill/parties');
    await expect(parties).toContainText('Tamsin Larkwood', FIRST_LOAD);
    await tabs.getByRole('link', { name: 'Overview' }).click();
    await expect(page).toHaveURL(/\/matters\/m-quill\/overview$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/matters\/m-quill\/parties$/);
    await expect(parties).toContainText('Tamsin Larkwood');
  });
});
