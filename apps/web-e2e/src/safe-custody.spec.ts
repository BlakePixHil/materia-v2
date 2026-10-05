import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { partyDocId } from '@materia/domain';
import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The will safe custody register (CORE-17) against the emulators: receive a will through the real
 * `safeCustody-receive` callable (numbered SC-000001), take it out, return it, and release it to
 * the executor on a signed authority from the testator's will matter through
 * `safeCustody-recordMovement`. The chain of custody lists every step. Fictional data only.
 */

/** Callables cold-start the Functions emulator. */
const SERVER = { timeout: 30_000 };

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

async function setUp(page: Page, request: APIRequestContext) {
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Custody Practice' },
    displayName: 'Jordan Fictional',
  });
  const uid = account.uid;
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-will',
    number: 'M-2026-0510',
    title: 'Will of Bram Fictional',
    type: 'will',
    responsibleUid: uid,
    daysAgo: 1,
  });
  const storagePath = `orgs/${orgId}/matters/m-will/documents/d-authority/v1`;
  const sha256 = 'cd'.repeat(32);
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake' } },
    {
      path: `orgs/${orgId}/matters/m-will/parties/${partyDocId('client', 'c-client')}`,
      data: {
        contactId: 'c-client',
        role: 'client',
        orgId,
        matterId: 'm-will',
        addedFrom: 'manual',
        deletedAt: null,
        ...meta(uid),
      },
    },
    {
      path: `orgs/${orgId}/matters/m-will/documents/d-authority`,
      data: {
        orgId,
        matterId: 'm-will',
        name: 'Signed authority to release.pdf',
        category: 'correspondence',
        privileged: false,
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
            fileName: 'Signed authority to release.pdf',
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
    },
  ]);
}

const dialog = (page: Page) => page.getByRole('dialog');
const history = (page: Page) => page.getByRole('region', { name: 'Chain of custody' }).getByRole('listitem');

test.describe('safe custody', () => {
  test('receive a will, take it out, return it and release it with an authority', async ({ page, request }) => {
    test.setTimeout(150_000);
    await setUp(page, request);

    await page.goto('/safe-custody');
    await expect(page.getByText('No wills in safe custody yet')).toBeVisible();
    await expectNoA11yViolations(page);

    // Receive the will.
    await page.getByRole('button', { name: 'Receive a will' }).first().click();
    await dialog(page).getByLabel('Testator').fill('Bram');
    await dialog(page)
      .getByRole('button', { name: /Bram Fictional/ })
      .click();
    await dialog(page).getByLabel('Dated').fill('14/02/2025');
    await dialog(page).getByLabel('Site').fill('Geelong');
    await dialog(page).getByLabel('Safe or cabinet').fill('Safe A');
    await dialog(page).getByLabel('Slot or envelope').fill('2');
    await dialog(page).getByLabel('Will matter').selectOption({ label: 'M-2026-0510 · Will of Bram Fictional' });
    await expectNoA11yViolations(page);
    await dialog(page).getByRole('button', { name: 'Receive', exact: true }).click();

    await expect(page).toHaveURL(/\/safe-custody\/[^/]+$/, SERVER);
    await expect(page.getByText('SC-000001', { exact: true })).toBeVisible();
    await expect(page.getByTestId('packet-status')).toHaveText('Held');
    await expectNoA11yViolations(page);

    // Out and back.
    await page.getByRole('button', { name: 'Take out' }).click();
    await dialog(page).getByLabel('Who has it').fill('Jordan Fictional');
    await dialog(page).getByLabel('Why it’s out').fill('Signing a codicil');
    await dialog(page).getByRole('button', { name: 'Record taken out' }).click();
    await expect(page.getByTestId('packet-status')).toHaveText('Out', SERVER);

    await page.getByRole('button', { name: 'Return to the safe' }).click();
    await dialog(page).getByLabel('Note').fill('Codicil signed');
    await dialog(page).getByRole('button', { name: 'Record returned' }).click();
    await expect(page.getByTestId('packet-status')).toHaveText('Held', SERVER);

    // Release on the signed authority.
    await page.getByRole('button', { name: 'Release' }).click();
    await dialog(page).getByLabel('Or name them').fill('Avery Fictional, executor');
    await dialog(page).getByLabel('Why it’s released').fill('Executor’s request after death');
    await dialog(page).getByLabel('Matter').selectOption({ label: 'M-2026-0510 · Will of Bram Fictional' });
    await dialog(page).getByLabel('Document').selectOption({ label: 'Signed authority to release.pdf' });
    await expectNoA11yViolations(page);
    await dialog(page).getByRole('button', { name: 'Release', exact: true }).click();
    await expect(page.getByTestId('packet-status')).toHaveText('Released', SERVER);

    await expect(history(page)).toHaveCount(4);
    await expect(history(page).first()).toContainText('Released');
    await expect(history(page).first()).toContainText('To Avery Fictional, executor');
    await expect(history(page).first().getByRole('link', { name: 'Authority' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take out' })).toHaveCount(0);
    await expectNoA11yViolations(page);

    // The register shows it released; the testator's contact links to it.
    await page.goto('/safe-custody');
    await expect(page.getByRole('table', { name: 'Safe custody register' })).toContainText('Released');
    await page.goto('/contacts?contact=c-client');
    await expect(page.getByRole('link', { name: 'No longer held' })).toBeVisible();
  });
});
