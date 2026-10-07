import { expect, test, type Page } from '@playwright/test';

import { contactSearchTokens, MIGRATION_REVIEW_CODES } from '@materia/domain';
import {
  createTestAccount,
  expectNoA11yViolations,
  FIRST_CALL,
  FIRST_LOAD,
  setEmulatorDocuments,
  signInThroughUi,
} from '@materia/test-utils/e2e';

import { matterDoc } from './support/matters';

/**
 * The in-app migration review (MIG-08) against the emulators: a practice the legacy migration
 * imported, with records it flagged for a person to check. The owner finds the import on Today,
 * names an untitled matter and an unnamed referrer in the queue, confirms the practice's name in
 * Settings → Practice (which clears its code), marks a member's budgets as looking right, marks
 * two matters reviewed together and the missing file with "Mark all", until the import counts as
 * reviewed. A fictional practice and people only.
 */

const uniqueOrg = () => `org-migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const PRACTICE = 'Fictional Imported Practice';

/** The progress line on the queue ("12% reviewed · 7 to check"). */
const progress = (page: Page) => page.locator('[data-section="progress"] [data-progress]');

/** One record in the queue. */
const record = (page: Page, path: string) => page.locator(`li[data-record="${path}"]`);

test.describe('migration review', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings sidebar is the desktop layout');

  test('review an imported practice until nothing is left to check', async ({ page, request }) => {
    test.setTimeout(180_000);
    const orgId = uniqueOrg();
    const now = new Date();
    const loadedAt = new Date(now.getTime() - 3_600_000);
    const meta = (uid: string) => ({
      createdAt: loadedAt,
      createdBy: uid,
      updatedAt: loadedAt,
      updatedBy: uid,
      schemaVersion: 1,
    });
    const migration = (legacyPath: string) => ({ runId: 'run-e2e', legacyPath, loadedAt });

    const account = await createTestAccount(request, {
      claims: { orgId, role: 'owner', orgName: PRACTICE },
      displayName: 'Tess Fictional',
    });
    const uid = account.uid;
    const O = `orgs/${orgId}`;

    // What the load wrote: every record stamped with the run, the ones to check with their codes.
    const untitled = matterDoc(orgId, uid, {
      id: 'm-untitled',
      number: 'M-2025-0001',
      title: 'Untitled matter (imported)',
      responsibleUid: uid,
      daysAgo: 3,
    });
    const stage = matterDoc(orgId, uid, {
      id: 'm-stage',
      number: 'M-2025-0002',
      title: 'Estate of Fictional Plover',
      responsibleUid: uid,
      daysAgo: 5,
    });
    await setEmulatorDocuments(request, [
      {
        path: O,
        data: {
          name: PRACTICE,
          practiceType: 'wills_estates',
          jurisdictions: ['VIC'],
          primaryJurisdiction: 'VIC',
          timezone: 'Australia/Melbourne',
          holidayLocality: 'VIC_MELBOURNE',
          retentionYears: 7,
          billing: {
            unitMinutes: 6,
            rounding: 'up',
            gstRegistered: true,
            defaultRateCents: 42000,
            invoicePrefix: 'FI-',
            paymentTermsDays: 14,
          },
          matterNumberFormat: 'M-{YYYY}-{seq:4}',
          fy: { startMonth: 7 },
          plan: 'trial',
          security: { mfaRequired: false, sessionIdleMinutes: 60 },
          needsReview: ['org_name_unconfirmed'],
          ...meta('migration'),
        },
      },
      {
        path: `${O}/members/${uid}`,
        data: {
          role: 'owner',
          status: 'active',
          email: account.email,
          displayName: 'Tess Fictional',
          needsReview: ['budgets_imported'],
          migration: migration('users/u1'),
        },
      },
      {
        path: untitled.path,
        data: {
          ...untitled.data,
          needsReview: ['title_missing', 'client_from_title'],
          migration: migration('workflows/w1/cards/c1'),
        },
      },
      {
        path: stage.path,
        data: {
          ...stage.data,
          needsReview: ['swimlane_unknown', 'fee_type_missing'],
          migration: migration('workflows/w1/cards/c2'),
        },
      },
      {
        path: `${O}/contacts/c-client`,
        data: {
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
          migration: migration('workflows/w1/cards/c1#client'),
          ...meta(uid),
        },
      },
      {
        path: `${O}/contacts/c-referrer`,
        data: {
          kind: 'organisation',
          orgName: 'Unnamed referrer (imported)',
          sortName: 'unnamed referrer (imported)',
          emails: [],
          phones: [],
          addresses: [],
          tags: [],
          isReferrer: true,
          search: contactSearchTokens({ orgName: 'Unnamed referrer (imported)' }),
          deletedAt: null,
          needsReview: ['referrer_unnamed'],
          migration: migration('referrers/r1'),
          ...meta(uid),
        },
      },
      {
        path: `${untitled.path}/documents/d-will`,
        data: {
          orgId,
          matterId: 'm-untitled',
          name: 'Fictional will.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 0,
          status: 'active',
          privileged: false,
          deletedAt: null,
          needsReview: ['MIG_W_ATTACHMENT_OBJECT_MISSING'],
          migration: migration('workflows/w1/cards/c1/attachments/a1'),
          ...meta(uid),
        },
      },
      {
        path: `${O}/migrations/run-e2e`,
        data: {
          runId: 'run-e2e',
          mode: 'cutover',
          status: 'succeeded',
          startedAt: loadedAt,
          finishedAt: loadedAt,
          counts: { matters: 2, contacts: 2, documents: 1, members: 1 },
          warnings: [{ code: 'MIG_C_NUMBER_TAKEN', path: 'workflows/w1/cards/c3', message: 'Number already used' }],
          ...meta('migration'),
        },
      },
    ]);

    await signInThroughUi(page, account);
    await expect(page).toHaveURL(/\/today$/, { timeout: 20_000 });

    // Today: the import is waiting on the owner.
    const card = page.locator('[data-section="import"]');
    await expect(card.getByRole('heading', { name: 'Check your import' })).toBeVisible(FIRST_CALL);
    await expect(card.getByText('0% reviewed · 8 to check')).toBeVisible();
    await card.getByRole('link', { name: 'Review 8 items' }).click();
    await expect(page).toHaveURL(/\/settings\/migration\/review$/);
    await expect(page.getByRole('heading', { name: 'Review imported records', level: 1 })).toBeVisible();
    await expect(progress(page)).toHaveText('0% reviewed · 8 to check', FIRST_CALL);

    // An untitled matter, named in the queue.
    const matter = record(page, untitled.path);
    await matter.getByLabel('Matter title').fill('Estate of Fictional Finch');
    await matter.getByRole('button', { name: 'Save title' }).click();
    await expect(page.getByText('Title saved').first()).toBeVisible(FIRST_CALL);
    await expect(progress(page)).toHaveText('12% reviewed · 7 to check');
    await expect(matter.locator('[data-code="title_missing"]')).toHaveCount(0);
    await expect(matter.getByText('Estate of Fictional Finch', { exact: true })).toBeVisible();

    // An unnamed referrer, named in the queue.
    const referrer = record(page, `${O}/contacts/c-referrer`);
    await referrer.getByLabel(/Referrer.s name/).fill('Fictional Referral Partners');
    await referrer.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByText('Name saved').first()).toBeVisible(FIRST_CALL);
    await expect(progress(page)).toHaveText('25% reviewed · 6 to check');
    await expect(referrer).toHaveCount(0);

    // The practice's name, confirmed where it always changes: Settings → Practice.
    const practice = record(page, O);
    await expect(practice.getByRole('link', { name: 'Change in Practice' })).toHaveAttribute(
      'href',
      '/settings/practice',
    );
    await practice.getByRole('link', { name: 'Change in Practice' }).click();
    await expect(page).toHaveURL(/\/settings\/practice$/);
    await expect(page.getByLabel('Practice name')).toHaveValue(PRACTICE, FIRST_LOAD);
    await page.getByLabel('Practice name').fill('Fictional Finch Legal');
    const saved = page.waitForResponse(
      (res) => res.url().endsWith('/orgs-updateSettings') && res.request().method() === 'POST',
      FIRST_CALL,
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved;
    await expect(page.getByText('Practice settings saved').first()).toBeVisible();

    // Back through Settings → Import from materia: what came across, and the way back to the queue.
    await page
      .getByRole('navigation', { name: 'Settings pages' })
      .getByRole('link', { name: 'Import from materia' })
      .click();
    await expect(page).toHaveURL(/\/settings\/migration$/);
    await expect(page.getByRole('heading', { name: 'Bring in your matters', level: 1 })).toBeVisible();
    await expect(page.locator('[data-section="came-across"] [data-file="matters"]')).toBeVisible(FIRST_CALL);
    await expect(page.locator('[data-warning="MIG_C_NUMBER_TAKEN"]')).toBeVisible();
    await page.getByRole('link', { name: 'Review 5 items' }).click();
    await expect(progress(page)).toHaveText('37% reviewed · 5 to check', FIRST_CALL);
    await expect(record(page, O)).toHaveCount(0);

    // The budgets the old materia kept look right as they are.
    const member = record(page, `${O}/members/${uid}`);
    await expect(member.getByRole('link', { name: 'Open team' })).toHaveAttribute('href', '/settings/team');
    await member.locator('[data-code="budgets_imported"]').getByRole('button', { name: 'Looks right' }).click();
    await expect(page.getByText('Marked reviewed').first()).toBeVisible(FIRST_CALL);
    await expect(progress(page)).toHaveText('50% reviewed · 4 to check');

    // Two matters marked reviewed together (their stage and fee can still change on the matter).
    const plover = record(page, stage.path);
    await expect(
      plover.locator('[data-code="swimlane_unknown"]').getByRole('link', { name: 'Open matter' }),
    ).toHaveAttribute('href', '/matters/m-stage/overview');
    await page.getByRole('checkbox', { name: 'Select Estate of Fictional Finch' }).click();
    await page.getByRole('checkbox', { name: 'Select Estate of Fictional Plover' }).click();
    await page.getByRole('button', { name: 'Mark 3 items reviewed' }).click();
    await expect(page.getByText('3 items marked reviewed').first()).toBeVisible(FIRST_CALL);
    await expect(progress(page)).toHaveText('87% reviewed · 1 to check');

    // The missing file, by reason: "Mark all".
    const missing = MIGRATION_REVIEW_CODES.MIG_W_ATTACHMENT_OBJECT_MISSING.label;
    await page.getByLabel('Show').selectOption({ label: `${missing} (1)` });
    await expect(page).toHaveURL(/code=MIG_W_ATTACHMENT_OBJECT_MISSING/);
    await expect(page.locator('[data-code-help]')).toBeVisible();
    await expect(record(page, `${untitled.path}/documents/d-will`)).toBeVisible(FIRST_CALL);
    await page.getByRole('button', { name: 'Mark all 1 reviewed' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await confirm.getByRole('button', { name: 'Mark 1 reviewed' }).click();
    await expect(page.getByText('1 item marked reviewed').first()).toBeVisible(FIRST_CALL);
    await expect(progress(page)).toHaveText('All reviewed');
    await expect(page.getByText('Everything’s reviewed')).toBeVisible();

    // The import counts as reviewed: its summary says so, in both themes, and Today lets it go.
    await page.goto('/settings/migration');
    await expect(page.getByRole('heading', { name: 'Bring in your matters', level: 1 })).toBeVisible(FIRST_LOAD);
    await expect(page.getByText('All reviewed').first()).toBeVisible(FIRST_CALL);
    await expectNoA11yViolations(page);
    await page.evaluate(() => localStorage.setItem('mt-theme', 'dark'));
    await page.reload();
    await expect(page.getByText('All reviewed').first()).toBeVisible(FIRST_CALL);
    await expectNoA11yViolations(page);

    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Tess$/ })).toBeVisible(
      FIRST_LOAD,
    );
    await expect(page.locator('[data-section="import"]')).toHaveCount(0);
  });
});
