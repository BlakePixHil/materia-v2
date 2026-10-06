import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, FIRST_LOAD, setEmulatorDocument, signInAsTestUser } from '@materia/test-utils/e2e';

/**
 * List exports and the weekly report opt-in (INS-03) against the emulators: an owner exports the
 * Contacts list as a CSV (a BOM, the formula defused, the mobile kept as text), downloads it again
 * from the `/exports/:jobId` page an `export_ready` notification links to, and opts in to the
 * weekly practice report. Each run is its own fictional practice.
 */

function uniqueOrg(): string {
  return `org-exports-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const contact = (uid: string, givenNames: string, familyName: string, extra: Record<string, unknown> = {}) => ({
  kind: 'person',
  givenNames,
  familyName,
  sortName: `${familyName} ${givenNames}`.toLowerCase(),
  search: [familyName.toLowerCase()],
  emails: [],
  phones: [],
  addresses: [],
  tags: [],
  matterRoles: [],
  createdAt: new Date(),
  createdBy: uid,
  updatedAt: new Date(),
  updatedBy: uid,
  schemaVersion: 1,
  ...extra,
});

test.describe('exports', () => {
  test.skip(({ isMobile }) => isMobile, 'The Contacts table is the desktop layout');

  test('export the contacts list as a CSV, download it again, and opt in to the weekly report', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const account = await signInAsTestUser(page, request, {
      claims: { orgId, role: 'owner', orgName: 'Fictional Exports Practice' },
      displayName: 'Priya Fictional',
    });
    await setEmulatorDocument(
      request,
      `orgs/${orgId}/contacts/c-ada`,
      contact(account.uid, 'Ada', 'Quillfeather', { phones: [{ type: 'mobile', number: '+61412555018' }] }),
    );
    await setEmulatorDocument(request, `orgs/${orgId}/contacts/c-evil`, contact(account.uid, '=HYPERLINK("x")', 'Zed'));

    await page.goto('/contacts');
    await expect(page.getByRole('table', { name: 'Contacts' })).toContainText('Ada Quillfeather', FIRST_LOAD);

    // A small export downloads at once: the browser follows a short-lived link to the CSV.
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Contacts \d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync((await file.path()) as string, 'utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"0412 555 018"');
    expect(lines[2]?.startsWith(`"'=HYPERLINK(""x"") Zed"`)).toBe(true);
    await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Contacts exported')).toBeVisible();
    await expectNoA11yViolations(page);

    // The page an export_ready notification links to fetches a fresh link and downloads again.
    const jobId = decodeURIComponent(new URL(file.url()).pathname).match(/exports\/([^/.]+)\.csv$/)?.[1];
    expect(jobId).toBeTruthy();
    const again = page.waitForEvent('download', { timeout: 30_000 });
    await page.goto(`/exports/${jobId}`);
    expect((await again).suggestedFilename()).toBe(file.suggestedFilename());
    await expect(page.getByRole('status')).toHaveText('Your download has started.');
    await expectNoA11yViolations(page);

    // Owners can opt in to the weekly practice report.
    await page.goto('/settings/preferences');
    const weekly = page.getByRole('switch', { name: 'Weekly practice report' });
    await expect(weekly).toHaveAttribute('aria-checked', 'false', FIRST_LOAD);
    await weekly.click();
    await expect(weekly).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Weekly practice report' })).toHaveAttribute(
      'aria-checked',
      'true',
      FIRST_LOAD,
    );
    await expectNoA11yViolations(page);
  });
});
