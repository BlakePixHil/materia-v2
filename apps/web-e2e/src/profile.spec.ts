import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, setEmulatorDocuments, signInAsTestUser } from '@materia/test-utils/e2e';

/**
 * Profile and preferences (CORE-20) against the emulators: a lawyer changes the theme, uploads a
 * photo (cropped and uploaded to Storage) and sets quiet hours, and all three survive a reload.
 * A fictional practice and person only.
 */

const uniqueOrg = () => `org-profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** An 8×6 PNG (solid colour), small enough to inline. */
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGMwyfmDFTEMpAQAfiBNQcue4uUAAAAASUVORK5CYII=',
  'base64',
);

test.describe('profile and preferences', () => {
  test.skip(({ isMobile }) => isMobile, 'The settings sidebar is the desktop layout');

  test('change the theme, upload a photo and set quiet hours', async ({ page, request }) => {
    test.setTimeout(120_000);
    const orgId = uniqueOrg();
    const now = new Date();
    await setEmulatorDocuments(request, [
      {
        path: `orgs/${orgId}`,
        data: {
          name: 'Fictional Profile Legal',
          practiceType: 'wills_estates',
          timezone: 'Australia/Melbourne',
          plan: 'trial',
          security: { mfaRequired: false, sessionIdleMinutes: 60 },
          createdAt: now,
          createdBy: 'e2e',
          updatedAt: now,
          updatedBy: 'e2e',
          schemaVersion: 1,
        },
      },
    ]);
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Profile Legal' },
      displayName: 'Robin Fictional',
    });

    // Profile: the form fills once users/{uid} exists (auth-syncClaims writes it on joining).
    await page.goto('/settings/profile');
    await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Display name')).toHaveValue('Robin Fictional', { timeout: 20_000 });
    await expectNoA11yViolations(page);

    await page.getByLabel('Choose a photo').setInputFiles({ name: 'robin.png', mimeType: 'image/png', buffer: PHOTO });
    const cropper = page.getByRole('dialog', { name: 'Crop your photo' });
    await expect(cropper).toBeVisible();
    await cropper.getByRole('button', { name: 'Use photo' }).click();
    await expect(page.getByText('Photo updated').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Change photo' })).toBeVisible();

    // Preferences: dark theme and quiet hours from 9:30 pm, saved as they change.
    await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('link', { name: 'Preferences' }).click();
    await expect(page).toHaveURL(/\/settings\/preferences$/);
    await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Quiet from').selectOption({ label: '9:30 pm' });
    await expectNoA11yViolations(page);

    // A fresh load (no local theme) takes both from the profile.
    await page.evaluate(() => localStorage.removeItem('mt-theme'));
    await page.reload();
    await expect(page.getByLabel('Quiet from').locator('option:checked')).toHaveText('9:30 pm', { timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: /Account menu for Robin Fictional/ }).locator('img')).toHaveAttribute(
      'src',
      /avatar\.png/,
    );
  });
});
