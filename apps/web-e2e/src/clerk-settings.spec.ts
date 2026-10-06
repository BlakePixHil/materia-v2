import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, signInAsTestUser } from '@materia/test-utils/e2e';

import { uniqueOrg } from './support/matters';

/**
 * Settings → Clerk and AI (AI-02a, AI-13) against the emulators: an admin acknowledges the data-use
 * disclosure, turns a feature off and sets the limits; saves the firm's own Anthropic key
 * (validated by the fake model), sees only its last four characters, switches the model and removes
 * the key. A lawyer sees the page read-only. Fictional keys only.
 */

const KEY = 'sk-ant-api03-fictional-e2e-key-000000004321';

test.describe('Settings → Clerk and AI', () => {
  test('save a key, see last4, switch the model and remove it', async ({ page, request }) => {
    test.setTimeout(90_000);
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'admin', orgName: 'Fictional Clerk Practice' },
      displayName: 'Priya Fictional',
    });

    await page.goto('/settings/clerk');
    await expect(page.getByRole('heading', { level: 1, name: 'Clerk and AI' })).toBeVisible();
    // The first call cold-starts the Functions emulator.
    await expect(page.locator('[data-key-status]')).toContainText('No key saved', { timeout: 20_000 });
    await expect(page.locator('[data-disclosure]')).toContainText("your firm's own Anthropic API account");
    await expectNoA11yViolations(page);

    // The disclosure gate (AI-13): acknowledged once, with who and when.
    await expect(page.locator('[data-ack-needed]')).toBeVisible();
    await page.getByRole('button', { name: 'I’ve read this, turn Clerk on' }).click();
    await expect(page.locator('[data-acknowledged]')).toContainText('Acknowledged by Priya Fictional', {
      timeout: 20_000,
    });

    // A feature off, saved at once; and the limits.
    const drafting = page.getByRole('switch', { name: 'Draft documents' });
    await expect(drafting).toBeChecked();
    await drafting.click();
    await expect(drafting).not.toBeChecked();
    await page.getByLabel('Monthly spend limit').fill('250');
    await page.getByLabel('Requests per person per day').fill('150');
    await page.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText('Limits saved').first()).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByLabel('Monthly spend limit')).toHaveValue('250.00', { timeout: 20_000 });
    await expect(page.getByRole('switch', { name: 'Draft documents' })).not.toBeChecked();
    await expect(page.locator('[data-budget-meter]')).toBeVisible();
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

  test('a lawyer sees what is on, read-only, and how Clerk works', async ({ page, request }) => {
    const orgId = uniqueOrg();
    await signInAsTestUser(page, request, {
      claims: { orgId, role: 'lawyer', orgName: 'Fictional Clerk Practice' },
      displayName: 'Jordan Fictional',
    });
    await page.goto('/settings/clerk');
    await expect(page.getByRole('heading', { level: 1, name: 'Clerk and AI' })).toBeVisible();
    await expect(page.locator('[data-ack-needed]')).toContainText('until an owner or admin');
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByText('Anthropic API key')).toHaveCount(0);
    await expectNoA11yViolations(page);

    await page.getByRole('link', { name: 'How Clerk works' }).first().click();
    await expect(page).toHaveURL(/\/help\/clerk$/);
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(7);
    await expectNoA11yViolations(page);
  });
});
