import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { today } from '@materia/domain';
import { FIRST_LOAD, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

import { matterDoc, seedClient, uniqueOrg } from './support/matters';

/**
 * The installable app (MOB-01) on a service-worker build: CI's Hosting emulator serves
 * `build --configuration=e2e`. Chromium's own installability checks pass; after one visit Today
 * starts with no connection, from the service worker and Firestore's cache; and a deploy while the
 * app is open offers a reload. Chromium only (the installability check is its DevTools protocol).
 * `ng serve` has no service worker, so locally these skip unless BASE_URL points at a built app.
 * Fictional data only.
 */

// The rest of the suite blocks service workers (playwright.config.mts); these tests need one.
test.use({ serviceWorkers: 'allow', timezoneId: 'Australia/Melbourne' });
// One worker at a time: the update test rewrites the built app's ngsw.json.
test.describe.configure({ mode: 'serial' });

const DIST = path.resolve(__dirname, '../../../dist/apps/web/browser');
const TASK = 'Sign the fictional affidavit of executor';

test.beforeEach(async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'The installability checks are Chromium’s');
  const manifest = await request.get('/ngsw.json');
  const built = manifest.ok() && (manifest.headers()['content-type'] ?? '').includes('json');
  test.skip(!built, 'No service worker in this build (ng serve)');
});

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** A matter of mine with a task due today. */
async function seedTask(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await seedClient(request, orgId, uid);
  const matter = matterDoc(orgId, uid, {
    id: 'm-pwa',
    number: 'M-2026-0701',
    title: 'Estate of Ada Fictional',
    responsibleUid: uid,
    daysAgo: 1,
  });
  await setEmulatorDocuments(request, [
    { ...matter, data: { ...matter.data, stageId: 'intake', openTaskCount: 1 } },
    {
      path: `orgs/${orgId}/matters/m-pwa/tasks/t-pwa`,
      data: {
        orgId,
        matterId: 'm-pwa',
        title: TASK,
        dueDate: today('Australia/Melbourne'),
        status: 'todo',
        priority: 'high',
        checklist: [],
        order: 1024,
        source: 'manual',
        countedOpen: true,
        assigneeUid: uid,
        deletedAt: null,
        ...meta(uid),
      },
    },
  ]);
}

/**
 * Waits for the service worker to control the page and hold every script, style and font the page
 * has loaded: what an offline start needs. The worker registers once the page settles (30 s at most).
 */
async function waitUntilCached(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 45_000 });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const loaded = performance
            .getEntriesByType('resource')
            .map((entry) => new URL(entry.name))
            .filter((url) => url.origin === location.origin && /\.(?:js|css|woff2)$/.test(url.pathname))
            .map((url) => url.pathname);
          const cached = new Set<string>();
          for (const name of await caches.keys()) {
            for (const request of await (await caches.open(name)).keys()) cached.add(new URL(request.url).pathname);
          }
          return [...new Set(loaded)].filter((file) => !cached.has(file));
        }),
      { timeout: 30_000, message: 'files the page loaded that the service worker has not cached' },
    )
    .toEqual([]);
}

/** Angular's service worker state page (`/ngsw/state`), read through the worker. */
const workerState = (page: Page) => page.evaluate(() => fetch('/ngsw/state').then((response) => response.text()));

const latestVersion = (state: string) => /Latest manifest hash: (\w+)/.exec(state)?.[1] ?? '';

/** The clients a version serves, as the state page lists them ("" for none). */
function clientsOf(state: string, hash: string): string {
  const match = new RegExp(`=== Version ${hash} ===\\s+Clients: ([^\\n]*)`).exec(state);
  return match?.[1]?.trim() ?? '';
}

test('Chromium can install it: manifest, icons and service worker', async ({ page, context }) => {
  await page.goto('/auth/sign-in');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 45_000 });
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  // Every Playwright context is an incognito window, which Chrome never installs from: a fact
  // about the test browser, not the app.
  expect(installabilityErrors.map((error) => error.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);
  const { errors } = (await cdp.send('Page.getAppManifest')) as { errors: { message: string }[] };
  expect(errors).toEqual([]);
  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
    name: string;
    display: string;
    icons: { sizes: string; purpose: string }[];
    shortcuts: { name: string; url: string }[];
  };
  expect(manifest).toMatchObject({ name: 'Materia', display: 'standalone' });
  expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(
    expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']),
  );
  expect(manifest.shortcuts.map((shortcut) => shortcut.name)).toEqual(['Today', 'New time entry', 'Record']);
});

test('after one visit, Today starts with no connection', async ({ page, request, context }) => {
  test.setTimeout(120_000);
  const orgId = uniqueOrg();
  const account = await signInAsTestUser(page, request, {
    claims: { orgId, role: 'lawyer', orgName: 'Fictional Offline Practice' },
    displayName: 'Jordan Fictional',
  });
  await seedTask(request, orgId, account.uid);
  await page.reload();
  await expect(page.getByRole('region', { name: 'My tasks' })).toContainText(TASK, FIRST_LOAD);
  await waitUntilCached(page);

  await context.setOffline(true);
  const response = await page.reload();
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('region', { name: 'My tasks' })).toContainText(TASK, FIRST_LOAD);
  // The start page (the manifest's start_url) loads offline too.
  const start = await page.goto('/');
  expect(start?.status()).toBe(200);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('region', { name: 'My tasks' })).toContainText(TASK, FIRST_LOAD);
  await expect(page.locator('[data-offline]')).toBeVisible();
  await context.setOffline(false);
});

test('a deploy while the app is open offers a reload to the new version', async ({ page }) => {
  test.setTimeout(120_000);
  const file = path.join(DIST, 'ngsw.json');
  const v1 = readFileSync(file, 'utf8');
  try {
    await page.goto('/auth/sign-in');
    await waitUntilCached(page);
    const v1Hash = latestVersion(await workerState(page));

    // Deploy "v2": a new manifest, as every build writes one.
    const manifest = JSON.parse(v1) as { appData?: Record<string, unknown> };
    writeFileSync(file, JSON.stringify({ ...manifest, appData: { e2e: `v2-${Date.now()}` } }));
    // The worker looks for a new version on each navigation.
    await page.reload();
    const toast = page.locator('.mt-toast').filter({ hasText: 'New version available' });
    await expect(toast).toBeVisible({ timeout: 45_000 });

    await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Reload' }).click()]);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible(FIRST_LOAD);
    // The reloaded page runs the new version.
    const state = await workerState(page);
    expect(state).toContain('Driver state: NORMAL');
    const v2Hash = latestVersion(state);
    expect(v2Hash).not.toBe(v1Hash);
    expect(clientsOf(state, v2Hash)).not.toBe('');
    await expect(toast).toHaveCount(0);
  } finally {
    writeFileSync(file, v1);
  }
});
