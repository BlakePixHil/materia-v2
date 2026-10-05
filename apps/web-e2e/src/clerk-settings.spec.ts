import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, signInAsTestUser } from '@materia/test-utils/e2e';

import { uniqueOrg } from './support/matters';

/**
 * Settings → Clerk (AI-02a) against the emulators: an admin saves the firm's own Anthropic key
 * (validated by the fake model), sees only its last four characters, switches the model and removes
 * the key; a lawyer can't open the page. Fictional keys only.
 */

const KEY = 'sk-ant-api03-fictional-e2e-key-000000004321';

test.describe('Settings → Clerk', () => {
  test('save a key, see last4, switch the model and remove it', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'admin', orgName: 'Fictional Clerk Practice' },
      displayName: 'Priya Fictional',
    });

    await page.goto('/settings/clerk');
    await expect(page.getByRole('heading', { level: 1, name: 'Clerk' })).toBeVisible();
    // The first call cold-starts the Functions emulator.
    await expect(page.locator('[data-key-status]')).toContainText('No key saved', { timeout: 20_000 });
    await expect(page.locator('[data-disclosure]')).toContainText('your firm’s own Anthropic account and terms');
    await expectNoA11yViolations(page);

    // A value that isn't an Anthropic key is caught before anything is sent.
    const field = page.getByLabel('API key', { exact: true });
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await field.fill('not-a-key');
    await expect(page.getByText('This doesn’t look like an Anthropic API key')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save key' })).toBeDisabled();

    // Paste with stray whitespace: trimmed, validated, saved, cleared, and only last4 is shown.
    await field.fill(`  ${KEY}\n`);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText('Key ending 4321 saved').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-key-status]')).toContainText('Key ending 4321');
    await expect(page.getByLabel('Replace the key', { exact: true })).toHaveValue('');
    await expect(page.locator('body')).not.toContainText(KEY);
    await expectNoA11yViolations(page);

    // Sonnet 5.5 is the default; switch to Opus 5.5 and it sticks after a reload.
    await expect(page.getByRole('radio', { name: 'Claude Sonnet 5.5 (default)' })).toBeChecked();
    await page.getByRole('radio', { name: 'Claude Opus 5.5' }).click();
    await expect(page.getByText('Clerk now uses Opus 5.5').first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Claude Opus 5.5' })).toBeChecked({ timeout: 20_000 });

    // Remove the key: Clerk is off again.
    await page.getByRole('button', { name: 'Remove key' }).click();
    await expect(page.locator('[data-key-status]')).toContainText('No key saved');
  });

  test('a lawyer can’t open it', async ({ page, request }) => {
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Clerk Practice' },
      displayName: 'Jordan Fictional',
    });
    await page.goto('/settings/clerk');
    await expect(page).toHaveURL(/\/no-access/);
  });
});
