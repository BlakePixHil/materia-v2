import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocument, signInAsTestUser } from '@materia/test-utils/e2e';

/**
 * Contacts (CORE-01) against the emulators: create, the duplicate prompt, edit, and the matters a
 * contact is on (a matter and party seeded through the emulator). Each test runs in its own
 * fictional practice so lists start empty. Needs the contacts-* callables and the contacts trigger
 * (search tokens, sortName) from the backend half of CORE-01.
 */

const detail = (page: Page) => page.getByRole('region', { name: 'Contact details' });
const dialog = (page: Page) => page.getByRole('dialog');

function uniqueOrg(): string {
  return `org-contacts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function createPerson(page: Page, given: string, family: string, phone: string): Promise<void> {
  await page.keyboard.press('c');
  await expect(dialog(page).getByRole('heading', { name: 'New contact' })).toBeVisible();
  await dialog(page).getByLabel('Given names').fill(given);
  await dialog(page).getByLabel('Family name').fill(family);
  await dialog(page).getByRole('button', { name: 'Add phone' }).click();
  await dialog(page).getByLabel('Phone', { exact: true }).fill(phone);
  await dialog(page).getByRole('button', { name: 'Create contact' }).click();
}

test.describe('contacts', () => {
  test.skip(({ isMobile }) => isMobile, 'Keyboard shortcuts and the two-pane layout are desktop features');

  test('create a contact, catch a near-duplicate, edit it, and see its matters', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Contacts Practice' },
      displayName: 'Jordan Fictional',
    });

    await page.goto('/contacts');
    await expect(page).toHaveTitle('Contacts · Materia');
    await expect(page.getByText('No contacts yet')).toBeVisible();
    await expectNoA11yViolations(page);

    // Create: the first contact goes straight through (nothing to match).
    await createPerson(page, 'Marlowe', 'Testperson', '0412 555 018');
    await expect(page.getByText('Contact created').first()).toBeVisible();
    await expect(detail(page).getByRole('heading', { level: 1, name: 'Marlowe Testperson' })).toBeVisible();
    await expect(detail(page)).toContainText('0412 555 018');
    const contactId = new URL(page.url()).searchParams.get('contact');
    expect(contactId).toBeTruthy();
    // The list shows it once the trigger has added sortName and the search tokens.
    await expect(page.getByRole('table', { name: 'Contacts' })).toContainText('Marlowe Testperson');
    await expectNoA11yViolations(page);

    // A near-duplicate (one letter off, same mobile) is caught; "Use existing" opens the original.
    await createPerson(page, 'Marlowe', 'Testpersen', '0412555018');
    await expect(dialog(page)).toContainText('This might be someone you already have.');
    await expect(dialog(page)).toContainText('Marlowe Testperson');
    await expectNoA11yViolations(page);
    await dialog(page).getByRole('button', { name: 'Use existing' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('contact')).toBe(contactId);

    // Search finds it.
    await page.keyboard.press('/');
    await page.keyboard.type('testp');
    await expect(page.getByRole('table', { name: 'Contacts' })).toContainText('Marlowe Testperson');

    // Edit: a preferred name changes the display name.
    await detail(page).getByRole('button', { name: 'Edit' }).click();
    await dialog(page).getByLabel('Preferred name').fill('Lowe');
    await dialog(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(detail(page).getByRole('heading', { level: 1, name: 'Lowe Testperson' })).toBeVisible();

    // A matter with this contact as executor (party orgId/matterId written as the server would).
    await setEmulatorDocument(request, `orgs/${orgId}/matters/m-e2e`, {
      number: 'WE-9001',
      title: 'Estate of Fictional Testperson',
      type: 'probate',
      status: 'open',
      privileged: false,
      jurisdiction: 'VIC',
      responsibleUid: account.uid,
      teamUids: [account.uid],
      clientContactIds: [contactId],
      createdAt: new Date(),
      createdBy: account.uid,
      updatedAt: new Date(),
      updatedBy: account.uid,
      schemaVersion: 1,
    });
    await setEmulatorDocument(request, `orgs/${orgId}/matters/m-e2e/parties/p-e2e`, {
      contactId,
      role: 'executor',
      orgId,
      matterId: 'm-e2e',
      addedFrom: 'manual',
      createdAt: new Date(),
      createdBy: account.uid,
      updatedAt: new Date(),
      updatedBy: account.uid,
      schemaVersion: 1,
    });
    const matters = detail(page).getByRole('region', { name: /Matters/ });
    await expect(matters.getByRole('link', { name: 'Estate of Fictional Testperson' })).toBeVisible();
    await expect(matters).toContainText('Executor');
    await expect(detail(page).locator('mt-person-header')).toContainText('WE-9001');
    await expectNoA11yViolations(page);
  });
});
