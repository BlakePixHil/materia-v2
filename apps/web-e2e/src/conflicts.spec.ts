import { expect, test, type APIRequestContext } from '@playwright/test';

import { contactSearchTokens } from '@materia/domain';
import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, table, uniqueOrg } from './support/matters';

/**
 * The conflict check (CORE-02) against the emulators. The ticket's flow is "the intake step with a
 * hit, then a waiver, then the matter opens"; intake (CORE-05) isn't built yet, so the lead is
 * seeded and its check opened from the Matters list: the client matches a contact who is a party on
 * another matter, a lawyer waives it as a potential conflict with a reason, and the lead opens.
 * Calls the real `conflicts-run`, `conflicts-determine` and `matters-changeStatus` callables.
 */

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

function person(orgId: string, uid: string, id: string, givenNames: string, familyName: string, dob?: string) {
  return {
    path: `orgs/${orgId}/contacts/${id}`,
    data: {
      kind: 'person',
      givenNames,
      familyName,
      ...(dob ? { dateOfBirth: dob } : {}),
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

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  const dispute = matterDoc(orgId, uid, {
    id: 'm-dispute',
    number: 'M-2025-0090',
    title: 'Ellis v Ferrand',
    type: 'contest',
    responsibleUid: uid,
    daysAgo: 30,
  });
  const lead = matterDoc(orgId, uid, {
    id: 'm-lead',
    number: 'M-2026-0400',
    title: 'Will for Margot Ellis',
    type: 'will',
    status: 'lead',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    // The new client, and a near-duplicate of her who is the defendant on another matter.
    person(orgId, uid, 'c-margot', 'Margot', 'Ellis', '1961-03-14'),
    person(orgId, uid, 'c-margot-old', 'Margot', 'Ellis', '1961-03-14'),
    person(orgId, uid, 'c-ferrand', 'Lionel', 'Ferrand'),
    { ...dispute, data: { ...dispute.data, clientContactIds: ['c-ferrand'] } },
    {
      path: `orgs/${orgId}/matters/m-dispute/parties/p-defendant`,
      data: {
        contactId: 'c-margot-old',
        role: 'defendant',
        orgId,
        matterId: 'm-dispute',
        addedFrom: 'manual',
        deletedAt: null,
        ...meta(uid),
      },
    },
    { ...lead, data: { ...lead.data, clientContactIds: ['c-margot'], conflictCheck: { status: 'pending' } } },
  ]);
}

test.describe('conflict check', () => {
  test.skip(({ isMobile }) => isMobile, 'Bulk actions and the dense Matters list are desktop features');

  test('run the check on a lead, see the hit, waive it as a potential conflict, then open the matter', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Conflicts Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);

    // From the Matters list: one lead selected → Run conflict check.
    await page.goto('/matters?view=leads');
    await expect(table(page)).toContainText('Will for Margot Ellis');
    const checkbox = table(page).getByRole('checkbox', { name: 'Select M-2026-0400 Will for Margot Ellis' });
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    const bulk = page.getByRole('region', { name: 'Bulk actions' });
    await bulk.getByRole('button', { name: 'Run conflict check' }).click();
    await expect(page).toHaveURL(/\/matters\/m-lead\/conflicts$/);
    await expect(page).toHaveTitle(/Conflict check/);

    // The client is prefilled; the check finds her near-duplicate on the other matter.
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Margot Ellis');
    await expect(page.getByRole('region', { name: 'Determination' })).toContainText('Not determined');
    await page.getByRole('button', { name: 'Run conflict check' }).click();
    const matches = page.getByRole('region', { name: 'Matches for Margot Ellis' });
    // The first call cold-starts the Functions emulator.
    await expect(matches).toContainText('Ellis v Ferrand', { timeout: 20_000 });
    await expect(matches).toContainText('M-2025-0090');
    await expect(matches).toContainText('Defendant');
    await expect(matches).toContainText(/\d+% match/);
    await expect(matches).toContainText('Name, date of birth');
    await expectNoA11yViolations(page);

    // A lawyer waives it as a potential conflict; the reason is required.
    const determination = page.getByRole('region', { name: 'Determination' });
    await determination.getByRole('radio', { name: /Potential conflict/ }).click();
    await determination.getByRole('button', { name: 'Record determination' }).click();
    await expect(determination).toContainText('Say why the potential conflict is waived.');
    await determination.getByLabel('Reason').fill('Former matter closed; both clients gave informed consent.');
    await determination.getByRole('button', { name: 'Record determination' }).click();
    // conflicts-determine's first call cold-starts it in the Functions emulator.
    await expect(determination.getByText('Potential conflict, waived')).toBeVisible({ timeout: 20_000 });
    await expect(determination).toContainText('Jordan Fictional');
    await expect(determination).toContainText('both clients gave informed consent');
    await expect(page.locator('mt-matter-layout mt-badge').first()).toHaveText('Potential conflict waived');
    await expectNoA11yViolations(page);

    // Now the lead opens: bulk change status → Open.
    await page.goto('/matters?view=leads');
    await table(page).getByRole('checkbox', { name: 'Select M-2026-0400 Will for Margot Ellis' }).click();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Change status' }).click();
    await page.getByRole('menu', { name: 'Change status to' }).getByRole('menuitem', { name: 'Open' }).click();
    await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Moved 1 matter to Open')).toBeVisible();
    await page.goto('/matters?view=all-open');
    await expect(table(page)).toContainText('Will for Margot Ellis');
  });
});
