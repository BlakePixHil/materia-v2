import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { contactSearchTokens } from '@materia/domain';
import {
  expectNoA11yViolations,
  FIRST_LOAD,
  setEmulatorDocuments,
  setOrgFlags,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { seedClient, uniqueOrg } from './support/matters';

/**
 * New matter intake (CORE-05) against the emulators: a probate with a new client and the deceased
 * created inline (the matter opens on its template's first stage with that stage's tasks), a family
 * provision claim with the other side, and a draft picked up again after a reload. Axe runs on every
 * step. Calls the real `contacts-create`, `conflicts-run` and `matters-createMatter` callables.
 * Fictional data only.
 */

const stepHeading = (page: Page) => page.locator('#intake-step-h');
const dialog = (page: Page) => page.getByRole('dialog');
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

function person(orgId: string, uid: string, id: string, givenNames: string, familyName: string, dateOfDeath?: string) {
  return {
    path: `orgs/${orgId}/contacts/${id}`,
    data: {
      kind: 'person',
      givenNames,
      familyName,
      ...(dateOfDeath ? { dateOfDeath } : {}),
      sortName: `${familyName} ${givenNames}`.toLowerCase(),
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
      search: contactSearchTokens({ givenNames, familyName }),
      deletedAt: null,
      ...meta(uid),
    },
  };
}

async function signIn(page: Page, request: APIRequestContext, flags: Record<string, boolean> = {}) {
  const orgId = uniqueOrg();
  if (Object.keys(flags).length) await setOrgFlags(request, orgId, flags);
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Intake Practice' },
    displayName: 'Jordan Fictional',
  });
  return { orgId, uid: account.uid };
}

/** Creates a person with the contacts form the intake opens from `button`. */
async function createContact(page: Page, button: string, given: string, family: string, dateOfDeath?: string) {
  await page.getByRole('button', { name: button }).click();
  await expect(dialog(page).getByRole('heading', { name: 'New contact' })).toBeVisible();
  await dialog(page).getByLabel('Given names').fill(given);
  await dialog(page).getByLabel('Family name').fill(family);
  if (dateOfDeath) await dialog(page).getByLabel('Date of death').fill(dateOfDeath);
  await dialog(page).getByRole('button', { name: 'Create contact' }).click();
  // The contacts form confirms recording someone as deceased.
  if (dateOfDeath) await page.getByRole('button', { name: 'Record date of death' }).click();
  // The first call cold-starts the Functions emulator.
  await expect(dialog(page)).toBeHidden({ timeout: 20_000 });
}

/** Searches a contact picker and picks the person whose name starts the result. */
async function pick(page: Page, search: string, query: string, name: string) {
  await page.getByLabel(search).fill(query);
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

test.describe('new matter intake', () => {
  test('a probate with a new client and the deceased opens on its template', async ({ page, request }) => {
    test.setTimeout(120_000);
    await signIn(page, request, { 'templates.system': true });

    await page.goto('/matters/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New matter' })).toBeVisible();
    await expect(page).toHaveTitle('New matter · Materia');

    // 1. Type: choosing one shows the template it starts from.
    await expect(stepHeading(page)).toContainText('Matter type', { timeout: 20_000 });
    await page.getByRole('radio', { name: 'Probate', exact: true }).click();
    await expect(page.getByTestId('intake-template')).toContainText('Probate');
    await expectNoA11yViolations(page);
    await next(page);

    // 2. Clients: a new contact created inline.
    await expect(stepHeading(page)).toContainText('Clients');
    await createContact(page, 'New client…', 'Avery', 'Quillfeather');
    await expect(page.getByRole('list', { name: 'Clients' })).toContainText('Avery Quillfeather');
    await expectNoA11yViolations(page);
    await next(page);

    // 3. Details: the deceased, created inline with the date of death, and the will.
    await expect(stepHeading(page)).toContainText('Details');
    await createContact(page, 'New contact for the deceased…', 'Rosamund', 'Thistlewood', '14/08/2026');
    await expect(page.getByRole('list', { name: 'Deceased' })).toContainText('Rosamund Thistlewood');
    await expect(page.getByLabel('Date of death')).toHaveValue('14/08/2026');
    await page.getByRole('radio', { name: 'Yes, there is a will', exact: true }).click();
    await expectNoA11yViolations(page);
    await next(page);

    // 4. Parties: the client is prefilled as the executor.
    await expect(stepHeading(page)).toContainText('Parties');
    await expect(page.locator('[data-party^="executor|"]')).toContainText('Avery Quillfeather');
    await expectNoA11yViolations(page);
    await next(page);

    // 5. Fees: a fixed fee, with the costs disclosure it needs under the VIC rules (signed off, BILL-06a).
    // Enter moves on from a field.
    await expect(stepHeading(page)).toContainText('Fees');
    await page.getByRole('radio', { name: 'Fixed fee', exact: true }).click();
    await page.getByRole('textbox', { name: 'Fixed fee' }).fill('4,500');
    const disclosure = page.getByTestId('costs-disclosure');
    await expect(disclosure).toContainText('Full disclosure required (estimate $4,500.00)');
    await expect(disclosure).not.toContainText('Illustrative');
    await expectNoA11yViolations(page);
    await page.getByRole('textbox', { name: 'Fixed fee' }).press('Enter');

    // 6. Conflict check: it runs by itself; the lawyer records Clear.
    await expect(stepHeading(page)).toContainText('Conflict check');
    await expect(page.getByRole('radiogroup', { name: 'Your determination' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('radio', { name: 'Clear', exact: true }).click();
    await expectNoA11yViolations(page);
    await next(page);

    // 7. Review and create.
    await expect(stepHeading(page)).toContainText('Review and create');
    await expect(page.getByLabel('Title')).toHaveValue('Estate of Rosamund Thistlewood');
    await expectNoA11yViolations(page);
    await page.getByRole('button', { name: 'Create matter' }).click();

    // The new matter: on the probate template's first stage, with that stage's tasks.
    await expect(page).toHaveURL(/\/matters\/[^/]+\/overview$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Estate of Rosamund Thistlewood');
    const stepper = page.locator('mt-estate-stepper');
    await expect(stepper.getByRole('button', { name: /^Instructions\s*, current$/ })).toBeVisible();
    const overview = page.locator('mt-matter-overview');
    await expect(overview).toContainText('Take the executor’s instructions');
    await expect(overview).toContainText('Obtain the death certificate');
  });

  test('a family provision claim with the other side', async ({ page, request, isMobile }) => {
    test.setTimeout(120_000);
    const { orgId, uid } = await signIn(page, request);
    await seedClient(request, orgId, uid);
    await setEmulatorDocuments(request, [
      person(orgId, uid, 'c-odile', 'Odile', 'Pemberton', '2026-02-03'),
      person(orgId, uid, 'c-hugo', 'Hugo', 'Pemberton'),
    ]);

    // From the Matters list: `c` on a desktop, the address on a phone.
    await page.goto('/matters');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (isMobile) await page.goto('/matters/new');
    else await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/matters\/new$/);

    await page.getByRole('radio', { name: 'Family provision', exact: true }).click();
    await next(page);
    await pick(page, 'Find a client', 'fictional', 'Bram Fictional');
    await next(page);

    // Details: the deceased (with the recorded date of death), our side and the other side.
    await pick(page, 'Find the deceased', 'odile', 'Odile Pemberton');
    await expect(page.getByLabel('Date of death')).toHaveValue('03/02/2026');
    await next(page);
    await expect(page.getByText('Add at least one party on the other side')).toBeVisible();
    await page.getByRole('radio', { name: 'Plaintiff', exact: true }).click();
    await pick(page, 'Find someone on the other side', 'hugo', 'Hugo Pemberton');
    await expect(page.getByRole('list', { name: 'The other side' })).toContainText('Hugo Pemberton');
    await expectNoA11yViolations(page);
    await next(page);

    // Parties: the other side is listed as the defendant.
    await expect(stepHeading(page)).toContainText('Parties');
    await expect(page.getByRole('list', { name: 'Parties from earlier steps' })).toContainText(
      /Hugo Pemberton\s*Defendant/,
    );
    await next(page);
    await expect(stepHeading(page)).toContainText('Fees');
    await next(page);

    // Conflict: decided later, so the matter is a lead.
    await expect(page.getByRole('radiogroup', { name: 'Your determination' })).toBeVisible({ timeout: 20_000 });
    await next(page);
    await expect(stepHeading(page)).toContainText('Review and create');
    await expect(page.getByLabel('Title')).toHaveValue(/Pemberton/);
    await page.getByRole('button', { name: 'Create matter' }).click();
    await expect(page).toHaveURL(/\/matters\/[^/]+\/overview$/, { timeout: 20_000 });

    const tabs = page.getByRole('navigation', { name: 'Matter sections' });
    await tabs.getByRole('link', { name: 'Parties' }).click();
    const parties = page.locator('mt-matter-parties');
    await expect(parties).toContainText('Bram Fictional');
    await expect(parties).toContainText('Hugo Pemberton');
    await expect(parties).toContainText('Defendant');
  });

  test('a draft is offered again after a reload and resumes where it was', async ({ page, request }) => {
    test.setTimeout(90_000);
    const { orgId, uid } = await signIn(page, request);
    await seedClient(request, orgId, uid);

    await page.goto('/matters/new');
    await page.getByRole('radio', { name: 'Will', exact: true }).click();
    await next(page);
    await pick(page, 'Find a client', 'fictional', 'Bram Fictional');
    await expect(page.getByRole('list', { name: 'Clients' })).toContainText('Bram Fictional');
    // "Saving draft…" until the client pick is written (debounce, then the Firestore write), so the
    // reload below only happens once the draft holds it.
    await expect(page.getByTestId('draft-status')).toHaveText('Draft saved', { timeout: 20_000 });

    await page.reload();
    const offer = page.getByTestId('intake-resume');
    await expect(offer).toContainText('You started a will matter', FIRST_LOAD);
    await expect(offer).toContainText('It was at “Clients”.');
    await expectNoA11yViolations(page);
    await offer.getByRole('button', { name: 'Resume draft' }).click();
    await expect(stepHeading(page)).toContainText('Clients');
    await expect(page.getByRole('list', { name: 'Clients' })).toContainText('Bram Fictional');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('radio', { name: 'Will', exact: true })).toHaveAttribute('aria-checked', 'true');
  });
});
