import { expect, test, type APIRequestContext } from '@playwright/test';

import { contactSearchTokens } from '@materia/domain';
import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Referrers (CORE-18) against the emulators: flag a contact as a referrer with an industry, find
 * them with the Referrers filter and its industry facet, record them on a matter from its header,
 * and see the matter in their referral history. Fictional data only.
 */

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  await setEmulatorDocuments(request, [
    matterDoc(orgId, uid, {
      id: 'm-quill',
      number: 'M-2026-0310',
      title: 'Will of Rosalind Quill',
      type: 'will',
      responsibleUid: uid,
      daysAgo: 1,
    }),
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

test.describe('referrers', () => {
  test.skip(({ isMobile }) => isMobile, 'The two-pane contacts layout is a desktop feature');

  test('flag a referrer, link them to a matter, and see the referral history', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Referrals Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);
    const detail = page.getByRole('region', { name: 'Contact details' });
    const dialog = page.getByRole('dialog');

    // Flag Tamsin as a referrer, a financial planner.
    await page.goto('/contacts?contact=c-tamsin');
    await expect(detail.getByRole('heading', { level: 1, name: 'Tamsin Larkwood' })).toBeVisible(FIRST_LOAD);
    await detail.getByRole('button', { name: 'Edit' }).click();
    // Click, then wait for the state: the checkbox re-renders on the next change detection.
    const referrer = dialog.getByLabel('Refers clients to the practice');
    await referrer.click();
    await expect(referrer).toBeChecked();
    await dialog.getByLabel('Referrer company').fill('Larkwood Fictional Wealth');
    await dialog.getByLabel('Industry').selectOption({ label: 'Financial planner' });
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(detail).toContainText('Financial planner · Larkwood Fictional Wealth');
    const referrals = detail.getByRole('region', { name: /Referrals/ });
    await expect(referrals).toContainText('No referred matters yet.');

    // The Referrers filter and its industry facet find her.
    const list = page.getByRole('table', { name: 'Contacts' });
    await page.getByRole('button', { name: 'Referrers' }).click();
    await expect(list).toContainText('Tamsin Larkwood');
    await expect(list).not.toContainText('Bram Fictional');
    await page.getByLabel('Industry').selectOption({ label: 'Accountant' });
    await expect(list).not.toContainText('Tamsin Larkwood');
    await page.getByLabel('Industry').selectOption({ label: 'Financial planner' });
    await expect(list).toContainText('Tamsin Larkwood');
    await expectNoA11yViolations(page);

    // Record her on the matter from its header: referrers are listed before anything is typed.
    await page.goto('/matters/m-quill/overview');
    const referral = page.getByTestId('matter-referral');
    await expect(referral).toContainText('Not recorded', FIRST_LOAD);
    await referral.getByRole('button', { name: 'Change referral' }).click();
    await expect(dialog.getByRole('heading', { name: 'Referral for M-2026-0310' })).toBeVisible();
    await expectNoA11yViolations(page);
    await dialog
      .getByRole('list', { name: 'Referrers' })
      .getByRole('button', { name: /Tamsin Larkwood/ })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(referral).toContainText('Tamsin Larkwood');
    await page.reload();
    await expect(page.getByTestId('matter-referral')).toContainText('Tamsin Larkwood', FIRST_LOAD);

    // Her page lists the matter she referred, with the totals.
    await page.getByTestId('matter-referral').getByRole('link', { name: 'Tamsin Larkwood' }).click();
    await expect(page).toHaveURL(/\/contacts\?contact=c-tamsin$/);
    await expect(referrals).toContainText('M-2026-0310');
    await expect(referrals).toContainText('Will of Rosalind Quill');
    await expect(referrals).toContainText('Will · Open');
    await expect(referrals).toContainText('1 matter referred · 1 active');
    await expectNoA11yViolations(page);
  });
});
