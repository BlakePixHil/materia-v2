import { expect, test } from '@playwright/test';

test('the health page loads', async ({ page }) => {
  await page.goto('/health');

  await expect(page).toHaveTitle('Health · Materia');
  await expect(page.getByTestId('health-status')).toHaveText('OK');
});
