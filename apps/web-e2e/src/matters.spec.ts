import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { contactSearchTokens, matterSearchTokens } from '@materia/domain';
import {
  createTestAccount,
  expectNoA11yViolations,
  setEmulatorDocument,
  setEmulatorDocuments,
  signInAsTestUser,
} from '@materia/test-utils/e2e';

/**
 * The Matters list (CORE-03) against the emulators: filter, save a view (it survives a reload),
 * bulk assign, open a matter from the keyboard, and the first paint with 500 matters. Matters are
 * seeded through the emulator as the server keeps them (`deletedAt: null`, search tokens and last
 * activity from matters-denormalise), each test in its own fictional practice. No callables are
 * called: bulk assign is a client update.
 */

const table = (page: Page) => page.getByRole('table', { name: 'Matters' });
const bar = (page: Page) => page.getByRole('group', { name: 'View and filters' });
const dialog = (page: Page) => page.getByRole('dialog');
const toasts = (page: Page) => page.getByRole('region', { name: /Notifications/ });

function uniqueOrg(): string {
  return `org-matters-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const DAY = 86_400_000;

interface SeedMatter {
  id: string;
  number: string;
  title: string;
  type?: string;
  status?: string;
  responsibleUid: string;
  jurisdiction?: string;
  labels?: string[];
  daysAgo: number;
}

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** A stored matter as the server keeps it. */
function matterDoc(orgId: string, uid: string, matter: SeedMatter, client = 'Bram Fictional') {
  return {
    path: `orgs/${orgId}/matters/${matter.id}`,
    data: {
      number: matter.number,
      title: matter.title,
      type: matter.type ?? 'probate',
      status: matter.status ?? 'open',
      jurisdiction: matter.jurisdiction ?? 'VIC',
      responsibleUid: matter.responsibleUid,
      teamUids: [matter.responsibleUid],
      clientContactIds: ['c-client'],
      privileged: false,
      priority: 'none',
      labels: matter.labels ?? [],
      relatedMatterIds: [],
      openTaskCount: 0,
      wipCents: 120_000,
      recomputeVersion: 0,
      fee: { arrangement: 'hourly', history: [] },
      costsDisclosure: { status: 'sent' },
      conflictCheck: { status: 'clear' },
      search: matterSearchTokens({ number: matter.number, title: matter.title, clientNames: [client] }),
      lastActivityAt: new Date(Date.now() - matter.daysAgo * DAY),
      deletedAt: null,
      ...meta(uid),
    },
  };
}

async function seedClient(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await setEmulatorDocument(request, `orgs/${orgId}/contacts/c-client`, {
    kind: 'person',
    givenNames: 'Bram',
    familyName: 'Fictional',
    sortName: 'fictional bram',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames: 'Bram', familyName: 'Fictional' }),
    deletedAt: null,
    ...meta(uid),
  });
}

/** Picks an item from a filter chip's menu. */
async function pick(page: Page, chip: string | RegExp, item: string): Promise<void> {
  await bar(page).getByRole('button', { name: chip }).click();
  const menu = page.getByRole('menu');
  await menu.getByRole(/^Status$|^Type$/.test(String(chip)) ? 'menuitemcheckbox' : 'menuitem', { name: item }).click();
  if (await menu.isVisible()) await page.keyboard.press('Escape');
}

test.describe('matters', () => {
  test.skip(({ isMobile }) => isMobile, 'Keyboard shortcuts, bulk actions and the dense list are desktop features');

  test('filter, save a view, bulk assign and open a matter from the keyboard', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    const claims = { orgId, role: 'lawyer', orgName: 'Fictional Matters Practice' };
    const priya = await createTestAccount(request, { claims, displayName: 'Priya Fictional' });
    const jordan = await signInAsTestUser(page, request, { claims, displayName: 'Jordan Fictional' });

    await seedClient(request, orgId, jordan.uid);
    await setEmulatorDocuments(
      request,
      [
        {
          id: 'm-quill',
          number: 'M-2026-0001',
          title: 'Estate of Ada Quillfeather',
          responsibleUid: jordan.uid,
          labels: ['grant-pending'],
          daysAgo: 1,
        },
        {
          id: 'm-marsh',
          number: 'M-2026-0002',
          title: 'Will for Ottilie Marsh',
          type: 'will',
          jurisdiction: 'NSW',
          responsibleUid: jordan.uid,
          daysAgo: 2,
        },
        { id: 'm-vale', number: 'M-2026-0003', title: 'Estate of Rupert Vale', responsibleUid: priya.uid, daysAgo: 3 },
        {
          id: 'm-hartigan',
          number: 'M-2026-0004',
          title: 'Hartigan family enquiry',
          type: 'will',
          status: 'lead',
          responsibleUid: jordan.uid,
          daysAgo: 4,
        },
        {
          id: 'm-pemble',
          number: 'M-2026-0005',
          title: 'Estate of Cyrus Pemble',
          status: 'on_hold',
          responsibleUid: jordan.uid,
          daysAgo: 5,
        },
      ].map((matter) => matterDoc(orgId, jordan.uid, matter)),
    );

    await page.locator('nav a[href="/matters"]').first().click();
    await expect(page).toHaveTitle('Matters · Materia');
    // "My open matters": open, mine, most recently active first.
    await expect(bar(page).getByRole('button', { name: 'My open matters' })).toBeVisible();
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');
    await expect(table(page)).toContainText('Will for Ottilie Marsh');
    await expect(table(page)).toContainText('Bram Fictional');
    await expect(table(page)).not.toContainText('Estate of Rupert Vale');
    await expect(table(page)).not.toContainText('Hartigan family enquiry');
    await expectNoA11yViolations(page);

    // Filter: anyone's open probate matters.
    await pick(page, 'Mine', 'Anyone');
    await expect(table(page)).toContainText('Estate of Rupert Vale');
    await pick(page, 'Type', 'Probate');
    await expect(table(page)).not.toContainText('Will for Ottilie Marsh');
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(2);
    await expect(bar(page).getByRole('button', { name: 'My open matters (edited)' })).toBeVisible();

    // Save it as a view; it's there after a reload.
    await bar(page).getByRole('button', { name: 'Save view' }).click();
    await dialog(page).getByLabel('View name').fill('Open probate');
    await dialog(page).getByRole('button', { name: 'Save view' }).click();
    await expect(toasts(page).getByText('View saved')).toBeVisible();
    await expect(page).toHaveURL(/\/matters\?view=/);
    await page.reload();
    await expect(bar(page).getByRole('button', { name: 'Open probate', exact: true })).toBeVisible();
    await expect(table(page)).toContainText('Estate of Rupert Vale');
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');
    await expect(table(page)).not.toContainText('Will for Ottilie Marsh');
    await expectNoA11yViolations(page);

    // Bulk assign: both of these to Priya.
    // Click, then wait for the state: the checkbox re-renders on the next change detection, which
    // under load can land after locator.check()'s immediate re-read.
    for (const name of ['M-2026-0001 Estate of Ada Quillfeather', 'M-2026-0003 Estate of Rupert Vale']) {
      const checkbox = table(page).getByRole('checkbox', { name: `Select ${name}` });
      await checkbox.click();
      await expect(checkbox).toBeChecked();
    }
    const bulk = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bulk).toContainText('2 selected');
    await expectNoA11yViolations(page);
    await bulk.getByRole('button', { name: 'Assign' }).click();
    await page.getByRole('menu', { name: 'Assign to' }).getByRole('menuitem', { name: 'Priya Fictional' }).click();
    await expect(toasts(page).getByText('Assigned 2 matters to Priya Fictional')).toBeVisible();
    await expect(bulk).toHaveCount(0);
    // Priya's open probate matters are now both.
    await pick(page, 'Anyone', 'Priya Fictional');
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(2);
    await expect(table(page)).toContainText('Estate of Ada Quillfeather');

    // Keyboard: back to My open matters, j to the first row, Enter opens it.
    await bar(page)
      .getByRole('button', { name: /^Open probate/ })
      .click();
    await page.getByRole('menu', { name: 'Views' }).getByRole('menuitem', { name: 'My open matters' }).click();
    await expect(page).toHaveURL(/\/matters$/);
    await expect(table(page).locator('tbody tr[data-index]')).toHaveCount(1);
    await expect(table(page)).toContainText('Will for Ottilie Marsh');
    await page.keyboard.press('j');
    // The row takes focus after the next render; Enter goes to whatever has focus.
    await expect(table(page).locator('tbody tr[data-index="0"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/matters\/m-marsh(\/|$)/);
  });

  test('with 500 matters the first rows paint within a second, and scrolling loads more', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Busy Practice' },
      displayName: 'Jordan Fictional',
    });
    await seedClient(request, orgId, account.uid);
    const surnames = ['Abernathy', 'Blackwood', 'Corrigan', 'Delacroix', 'Ellery', 'Fairweather', 'Galloway', 'Hollis'];
    await setEmulatorDocuments(
      request,
      Array.from({ length: 500 }, (_, i) =>
        matterDoc(orgId, account.uid, {
          id: `m-${String(i + 1).padStart(4, '0')}`,
          number: `M-2026-${String(i + 1).padStart(4, '0')}`,
          title: `Estate of ${surnames[i % surnames.length]} ${i + 1}`,
          type: i % 3 === 0 ? 'will' : 'probate',
          responsibleUid: account.uid,
          daysAgo: i / 10,
        }),
      ),
    );

    // Warm-up visit (loads the route's code once, as a returning user would have it cached).
    await page.goto('/matters');
    await expect(table(page).locator('tbody tr[data-index]').first()).toBeVisible();
    await page.goto('/today');
    await expect(page).toHaveURL(/\/today$/);

    // From the click on Matters to the first painted row.
    const firstPaint = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let start = 0;
          document.addEventListener('click', () => (start = performance.now()), { capture: true, once: true });
          const observer = new MutationObserver(() => {
            if (!start || !document.querySelector('mt-table tbody tr[data-index]')) return;
            observer.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - start));
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }),
    );
    await page.locator('nav a[href="/matters"]').first().click();
    const elapsed = await firstPaint;
    test.info().annotations.push({ type: 'first rows painted (ms)', description: elapsed.toFixed(0) });
    expect(elapsed).toBeLessThan(1000);

    // The first page is 50 rows, most recently active first; scrolling to the end loads the next.
    const rows = table(page).locator('tbody tr[data-index]');
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText('M-2026-0001');
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(100);
  });
});
