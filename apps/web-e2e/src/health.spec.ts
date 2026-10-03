import { expect, test } from '@playwright/test';

import { expectNoA11yViolations } from '@materia/test-utils/e2e';

test('the health page loads', async ({ page }) => {
  await page.goto('/health');

  await expect(page).toHaveTitle('Health · Materia');
  await expect(page.getByTestId('health-status')).toHaveText('OK');
});

test('the health page has no WCAG 2.2 AA violations', async ({ page }) => {
  await page.goto('/health');
  await expect(page.getByTestId('health-status')).toBeVisible();

  await expectNoA11yViolations(page);
});
