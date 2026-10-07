import { expect, test, type APIRequestContext } from '@playwright/test';

import { addDays, today } from '@materia/domain';
import {
  EMULATOR_PROJECT,
  FIRESTORE_EMULATOR,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * Push notifications on this device (MOB-04) against the emulators, where the browser's FCM token
 * is `emulator-{deviceId}` and pushes land in the emulator's push outbox: Settings turns push on,
 * lists this device, sends it a test and turns it off; a critical deadline offers alerts; and a
 * tapped notification opens its link. Chromium only: Playwright grants notification permission
 * there. Fictional data only.
 */

// Playwright's default headless Chromium (the headless shell) reports `Notification.permission` as
// denied whatever is granted; full Chromium in headless mode reports the grant, as a browser does.
test.use({ channel: 'chromium', permissions: ['notifications'] });

const DOCS = `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;
const ADMIN = { Authorization: 'Bearer owner' };

type Fields = Record<string, { stringValue?: string }>;

/** The emulator's push outbox: what was pushed for an org. */
async function pushOutbox(request: APIRequestContext, orgId: string): Promise<Fields[]> {
  const response = await request.post(`${DOCS}:runQuery`, {
    headers: ADMIN,
    data: {
      structuredQuery: {
        from: [{ collectionId: 'emulatorPushOutbox' }],
        where: { fieldFilter: { field: { fieldPath: 'orgId' }, op: 'EQUAL', value: { stringValue: orgId } } },
      },
    },
  });
  const rows = (await response.json()) as { document?: { fields: Fields } }[];
  return rows.flatMap((row) => (row.document ? [row.document.fields] : []));
}

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

test.describe('push notifications', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Playwright grants notification permission in Chromium');

  test('turns push on for this device, sends it a test and turns it off', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Push Practice' },
      displayName: 'Jordan Fictional',
    });
    await page.goto('/settings/preferences');
    const thisDevice = page.locator('[data-this-device]');
    await expect(thisDevice).toHaveAttribute('data-push', 'off', FIRST_LOAD);
    await expect(page.getByText('No devices get push notifications yet.')).toBeVisible();

    await thisDevice.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('Deadline alerts are on for this device', { exact: true })).toBeVisible(FIRST_LOAD);
    await expect(thisDevice).toHaveAttribute('data-push', 'on');
    const device = page.locator('[data-device][data-this]');
    await expect(device).toContainText('(this device)');

    await device.getByRole('button', { name: 'Send a test' }).click();
    await expect(page.getByText('Test sent', { exact: true })).toBeVisible(FIRST_CALL);
    const sent = await pushOutbox(request, orgId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['title']?.stringValue).toBe('Test from Materia');
    expect(sent[0]?.['link']?.stringValue).toBe('/settings/preferences');
    expect(sent[0]?.['token']?.stringValue).toMatch(/^emulator-/);

    await thisDevice.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByText('This device won’t get push notifications', { exact: true })).toBeVisible(FIRST_LOAD);
    await expect(thisDevice).toHaveAttribute('data-push', 'off');
    await expect(page.locator('[data-device]')).toHaveCount(0);
  });

  test('offers alerts on a critical deadline and turns them on from there', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const { uid } = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Push Practice' },
      displayName: 'Jordan Fictional',
    });
    await seedClient(request, orgId, uid);
    const matter = matterDoc(orgId, uid, {
      id: 'm-push',
      number: 'M-2026-0731',
      title: 'Estate of Fictional Quill',
      responsibleUid: uid,
      daysAgo: 1,
    });
    await setEmulatorDocuments(request, [
      { ...matter, data: { ...matter.data, stageId: 'intake' } },
      {
        path: `orgs/${orgId}/matters/m-push/deadlines/d-caveat`,
        data: {
          orgId,
          matterId: 'm-push',
          title: 'File the caveat',
          dueDate: addDays(today('Australia/Melbourne'), 5),
          kind: 'internal',
          critical: true,
          status: 'upcoming',
          assigneeUid: uid,
          reminders: [],
          pastOnCreation: false,
          deletedAt: null,
          ...meta(uid),
        },
      },
    ]);

    await page.goto('/matters/m-push/deadlines');
    const offer = page.locator('[data-push-offer]');
    await expect(offer).toContainText('Get deadline alerts on this device', FIRST_LOAD);
    await expect(offer).toHaveAttribute('data-state', 'off');
    await offer.getByRole('button', { name: 'Turn on alerts' }).click();
    await expect(page.getByText('Deadline alerts are on for this device', { exact: true })).toBeVisible(FIRST_LOAD);
    await expect(offer).toHaveCount(0);

    // Answered: it doesn't come back.
    await page.reload();
    await expect(page.locator('[data-deadline="d-caveat"]')).toContainText('File the caveat', FIRST_LOAD);
    await expect(offer).toHaveCount(0);
  });

  test('a tapped notification opens its link, and only links inside Materia', async ({ page, request }) => {
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Push Practice' },
      displayName: 'Jordan Fictional',
    });
    await page.goto(`/open?to=${encodeURIComponent('/settings/preferences')}&org=${orgId}`);
    await expect(page).toHaveURL(/\/settings\/preferences$/, FIRST_LOAD);

    await page.goto(`/open?to=${encodeURIComponent('//example.test/phish')}&org=${orgId}`);
    await expect(page).toHaveURL(/\/today$/, FIRST_LOAD);
  });
});
