import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  EMULATOR_PROJECT,
  expectNoA11yViolations,
  FIRESTORE_EMULATOR,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInAsTestUser,
  watchCspViolations,
} from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';
import { phone, smallTargets } from './support/phone';

/**
 * Scan a document (MOB-05) on a phone, against the emulators: photos of a paper document become
 * one PDF in the order chosen, uploaded to the matter as a camera scan and ingested by the real
 * pipeline (`documents-onUpload` counts its pages). The photos are drawn here at test time (a
 * fictional page on a dark desk), so finding and straightening the page runs on real pixels.
 * Offline, the scan waits on the phone and uploads when the connection is back.
 */

const ZONE = 'Australia/Melbourne';

/** The pipeline runs in the Functions emulator (the first upload cold-starts it). */
const PIPELINE = { timeout: 60_000 };

async function seed(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-larch',
    number: 'M-2026-0721',
    title: 'Estate of Winifred Larch',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [{ ...matter, data: { ...matter.data, stageId: 'intake' } }]);
}

/**
 * Photos of a fictional page lying a little skewed on a dark desk, as a phone's camera app saves
 * them (JPEG): "Page n" in large type, then lines of "text".
 */
async function photos(page: Page, count: number) {
  const encoded = await page.evaluate((n) => {
    const out: string[] = [];
    for (let i = 1; i <= n; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1600;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      context.fillStyle = '#3b3029';
      context.fillRect(0, 0, 1200, 1600);
      context.translate(600, 800);
      context.rotate((i - 2) * 0.05);
      context.fillStyle = '#f4f1ea';
      context.fillRect(-420, -560, 840, 1120);
      context.fillStyle = '#26221f';
      context.font = 'bold 72px sans-serif';
      context.fillText(`Page ${i}`, -360, -440);
      for (let line = 0; line < 16; line++) context.fillRect(-360, -340 + line * 52, 560 + ((line * 37) % 120), 10);
      out.push(canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? '');
    }
    return out;
  }, count);
  return encoded.map((data, i) => ({
    name: `IMG_20${String(i + 1).padStart(2, '0')}.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(data, 'base64'),
  }));
}

/** The stored scan's fields, by its name. */
async function storedDocument(request: APIRequestContext, orgId: string, name: string) {
  const response = await request.get(
    `${FIRESTORE_EMULATOR}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/orgs/${orgId}/matters/m-larch/documents?pageSize=50`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await response.json()) as { documents?: { fields: Record<string, Record<string, unknown>> }[] };
  return body.documents?.find((doc) => doc.fields['name']?.['stringValue'] === name)?.fields;
}

const rows = (page: Page) => page.locator('mt-scan-page [data-page-row]');

/** Chooses photos, and waits until each has been made a page. */
async function addPhotos(page: Page, count: number): Promise<void> {
  await page.getByTestId('scan-files').setInputFiles(await photos(page, count));
  await expect(rows(page)).toHaveCount(count);
  for (let i = 0; i < count; i++) await expect(rows(page).nth(i).locator('.ts')).toHaveText('Straightened');
}

async function check(page: Page, screen: string): Promise<void> {
  const path = test.info().outputPath(`${screen}.png`);
  await page.screenshot({ path });
  await test.info().attach(screen, { path, contentType: 'image/png' });
  await expectNoA11yViolations(page);
  expect.soft(await smallTargets(page), `controls under 44px on ${screen}`).toEqual([]);
}

test.describe('scan a document on a phone', () => {
  test.use({ ...phone('iPhone 12'), timezoneId: ZONE });

  test('three photos, reordered and black and white, become one readable PDF in the matter', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const csp = watchCspViolations(page);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Scanning Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);

    await page.goto('/record/scan?matter=m-larch');
    await expect(page.getByRole('heading', { name: 'Photograph each page' })).toBeVisible(FIRST_LOAD);
    await check(page, 'scan-empty');

    // Three photos: each page is found on the desk and straightened.
    await addPhotos(page, 3);
    await expect(page.getByTestId('scan-matter')).toContainText('M-2026-0721', FIRST_LOAD);

    // The last page dragged to the top by its handle.
    const before = await rows(page)
      .locator('img')
      .evaluateAll((images) => images.map((img) => img.getAttribute('src')));
    const handle = rows(page).nth(2).locator('.grip');
    const from = await handle.boundingBox();
    const to = await rows(page).nth(0).boundingBox();
    if (!from || !to) throw new Error('The rows aren’t on screen');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + 8, { steps: 12 });
    await page.mouse.up();
    await expect(rows(page).nth(0).locator('img')).toHaveAttribute('src', before[2] ?? '');
    await expect(rows(page).nth(1).locator('img')).toHaveAttribute('src', before[0] ?? '');

    await page.locator('mt-scan-page .mt-seg-item', { hasText: 'Black and white' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Grant of probate – Larch');
    await page.getByLabel('Category').selectOption({ label: 'Grant' });
    await check(page, 'scan-pages');

    await page.getByRole('button', { name: 'Add to matter' }).click();
    await expect(page).toHaveURL(/\/matters\/m-larch\/documents$/);

    // Ingested: a three-page PDF, stored as a camera scan. The Uploads tray links to it too while
    // it's open, so the link is the Documents table's.
    const link = page.getByRole('table', { name: 'Documents' }).getByRole('link', { name: /Grant of probate – Larch/ });
    await expect(link).toBeVisible(PIPELINE);
    await expect
      .poll(async () => (await storedDocument(request, orgId, 'Grant of probate – Larch.pdf'))?.['source'], PIPELINE)
      .toEqual({ stringValue: 'camera' });
    const stored = await storedDocument(request, orgId, 'Grant of probate – Larch.pdf');
    expect(stored?.['category']).toEqual({ stringValue: 'grant' });

    // Readable: the viewer renders its three pages.
    await link.click();
    const viewer = page.locator('mt-pdf-viewer');
    await expect(viewer).toContainText('of 3', PIPELINE);
    await expect(viewer.locator('[data-page="1"][data-rendered] canvas')).toBeVisible(PIPELINE);
    await expect(page.getByText(/· 3 pages/)).toBeVisible();
    expect(csp()).toEqual([]);
  });

  test('a scan saved offline waits on the phone and uploads when the connection is back', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(240_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Scanning Practice' },
      displayName: 'Jordan Fictional',
    });
    await seed(request, orgId, account.uid);

    // The matter, then Record's Photo document tile with it chosen.
    await page.goto('/matters/m-larch/overview');
    await expect(page.getByRole('heading', { name: /Estate of Winifred Larch/ }).first()).toBeVisible(FIRST_LOAD);
    await page.locator('.mt-tabbar').getByRole('link', { name: 'Record' }).click();
    await page.locator('.mt-record .chips .mt-chip', { hasText: 'M-2026-0721' }).click(FIRST_LOAD);
    await page.locator('[data-record="scan"]').click();
    await expect(page).toHaveURL(/\/record\/scan\?matter=m-larch$/);
    await addPhotos(page, 2);
    await expect(page.getByTestId('scan-matter')).toContainText('M-2026-0721', FIRST_LOAD);
    await page.getByLabel('Name', { exact: true }).fill('Will – Larch');

    await context.setOffline(true);
    await page.getByRole('button', { name: 'Add to matter' }).click();
    // A save that fails shows its problem under the pages in place of the toast, so a failure here
    // names it. Fails on Playwright's WebKit: its offline mode refuses even the page's reads of its
    // own photos (NotReadableError), so the PDF can't be built. Those reads never touch the network,
    // so a phone that's really offline makes them.
    const saved = page.locator('.mt-toaster').getByText('Scan saved on this phone', { exact: true });
    const problem = page.getByTestId('scan-problem');
    await expect(saved.or(problem)).toBeVisible();
    await expect(problem).toBeHidden();
    await expect(saved).toBeVisible();
    await expect(page).toHaveURL(/\/record$/);
    const waiting = page.getByTestId('scans-waiting');
    await expect(waiting).toContainText('Will – Larch.pdf');
    await expect(waiting).toContainText('Waiting for a connection');
    await check(page, 'record-waiting');

    await context.setOffline(false);
    await expect(waiting).toBeHidden(PIPELINE);
    await expect
      .poll(async () => (await storedDocument(request, orgId, 'Will – Larch.pdf'))?.['source'], PIPELINE)
      .toEqual({ stringValue: 'camera' });
  });
});
