import { expect, test } from '@playwright/test';

import { setOrgFlags, signInAsTestUser } from '@materia/test-utils/e2e';

/**
 * Feature flags (FND-23) against the emulators: Disputes is behind `litigation.enabled`, off by
 * default. Each test uses its own org, and the override is written as `flags-setOrgOverride` would.
 */
const orgFor = (title: string) => `org-flags-${title.replace(/\W+/g, '-').slice(0, 20)}-${Date.now().toString(36)}`;

test('a flagged route is hidden and guarded while its flag is off', async ({ page, request, isMobile }) => {
  const orgId = orgFor('off');
  await setOrgFlags(request, orgId, {});
  await signInAsTestUser(page, request, { claims: { orgId, role: 'lawyer', orgName: 'Fictional e2e practice' } });
  if (!isMobile)
    await expect(
      page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'Disputes' }),
    ).toHaveCount(0);
  await page.goto('/disputes');
  await expect(page).toHaveURL(/\/today$/);
});

test('turning the flag on for the org shows the route and its nav item', async ({ page, request, isMobile }) => {
  const orgId = orgFor('on');
  await setOrgFlags(request, orgId, { 'litigation.enabled': true });
  await signInAsTestUser(page, request, { claims: { orgId, role: 'lawyer', orgName: 'Fictional e2e practice' } });
  if (!isMobile)
    await expect(
      page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'Disputes' }),
    ).toBeVisible();
  await page.goto('/disputes');
  await expect(page).toHaveURL(/\/disputes$/);
  await expect(page.getByText('Coming in LIT-02')).toBeVisible();
});
