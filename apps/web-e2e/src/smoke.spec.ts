import { expect, test } from '@playwright/test';

import { watchCspViolations } from '@materia/test-utils/e2e';

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

test('security.txt and the disclosure policy are published @smoke', async ({ request }) => {
  // SEC-02: RFC 9116 at its well-known path, pointing at the vulnerability disclosure policy.
  const txt = await request.get('/.well-known/security.txt');
  expect(txt.ok()).toBe(true);
  expect(txt.headers()['content-type']).toMatch(/^text\/plain/);
  const body = await txt.text();
  expect(body).toMatch(/^Contact: \S+$/m);
  expect(body).toMatch(/^Expires: \S+$/m);
  const policy = await request.get('/SECURITY.md');
  expect(policy.ok()).toBe(true);
  expect(await policy.text()).toContain('# Security policy');
});

test('sign-in runs under the Hosting CSP: Firebase, App Check and the Google popup @smoke', async ({ page }) => {
  // FND-22: on a deployed site this loads the Firebase SDK, App Check's reCAPTCHA and the Google
  // sign-in popup's scripts and auth iframe, which the emulators can't stand in for. Any popup is
  // closed unused, so nobody signs in.
  const csp = watchCspViolations(page);
  page.on('popup', (popup) => void popup.close());
  await page.goto('/auth/sign-in');
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeEnabled();
  await google.click();
  // The attempt ends (the popup closed, or an error shown) and the button is usable again.
  await expect(google).toBeEnabled({ timeout: 20_000 });
  expect(csp(), 'Content Security Policy violations').toEqual([]);
});
