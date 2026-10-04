import { expect, test } from '@playwright/test';

/**
 * Smoke tests (FND-05), read-only so they are safe against prod. The deploy workflows run
 * `--grep @smoke` against the deployed site with EXPECTED_SHA and FUNCTIONS_URL; CI runs them
 * against the emulators.
 */
const expectedSha = process.env['EXPECTED_SHA'];
const functionsUrl = process.env['FUNCTIONS_URL'] ?? 'http://127.0.0.1:5001/demo-materia/australia-southeast1';

test('the health page reports the deployed release @smoke', async ({ page }) => {
  await page.goto('/health');
  await expect(page.getByTestId('health-status')).toHaveText('OK');
  const sha = page.getByTestId('health-sha');
  await expect(sha).toHaveText(/^[0-9a-f]{7,40}$/);
  if (expectedSha) await expect(sha).toHaveText(expectedSha);
});

test('the system-ping callable answers with its release @smoke', async ({ request }) => {
  const response = await request.post(`${functionsUrl}/system-ping`, { data: { data: {} } });
  expect(response.ok()).toBe(true);
  const { result } = (await response.json()) as { result: { ok: boolean; region: string; sha: string } };
  expect(result).toMatchObject({ ok: true, region: 'australia-southeast1' });
  if (expectedSha) expect(result.sha).toBe(expectedSha);
});
