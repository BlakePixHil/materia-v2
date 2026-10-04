import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations } from '@materia/test-utils/e2e';

// Canvas colours from the tokens: slate-50 (light) and slate-975 (dark).
const LIGHT_CANVAS = 'rgb(247, 248, 250)';
const DARK_CANVAS = 'rgb(11, 12, 15)';

const storePreference = (page: Page, value: string) =>
  page.addInitScript((pref) => localStorage.setItem('mt-theme', pref), value);

const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const canvas = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('theme boot (no flash)', () => {
  test('a stored dark preference applies before any app JavaScript runs', async ({ page }) => {
    await storePreference(page, 'dark');
    // Block every script file: only the inline boot script in index.html can set the theme.
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/health');
    expect(await theme(page)).toBe('dark');
    expect(await canvas(page)).toBe(DARK_CANVAS);
    await page.screenshot({ path: test.info().outputPath('dark-before-app-boot.png') });
  });

  test('system dark applies before the app boots when nothing is stored', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/health');
    expect(await theme(page)).toBe('dark');
  });

  test('an explicit light choice beats a dark OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await storePreference(page, 'light');
    await page.goto('/health');
    await expect(page.getByTestId('health-status')).toBeVisible();
    expect(await theme(page)).toBe('light');
    expect(await canvas(page)).toBe(LIGHT_CANVAS);
  });

  test('a stored theme stays put through boot and reload', async ({ page }) => {
    await storePreference(page, 'dark');
    const seen: (string | null)[] = [];
    await page.exposeFunction('recordTheme', (value: string | null) => seen.push(value));
    await page.addInitScript(() => {
      // Observe the document (documentElement may not exist yet) for every data-theme write on <html>.
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.target !== document.documentElement) continue;
          (window as unknown as { recordTheme: (v: string | null) => void }).recordTheme(
            document.documentElement.getAttribute('data-theme'),
          );
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
    });
    await page.goto('/health');
    await expect(page.getByTestId('health-status')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('health-status')).toBeVisible();
    // Two loads, each writing data-theme at least once (boot script, then ThemeService), never light.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set(['dark']));
  });

  test('on system, the app follows an OS theme change live', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/health');
    await expect(page.getByTestId('health-status')).toBeVisible();
    expect(await theme(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    expect(await canvas(page)).toBe(DARK_CANVAS);
  });

  test('the health page has no WCAG 2.2 AA violations in dark mode', async ({ page }) => {
    await storePreference(page, 'dark');
    await page.goto('/health');
    await expect(page.getByTestId('health-status')).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe('fonts', () => {
  test('Geist is self-hosted, preloaded and causes no layout shift', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Layout Instability API is Chromium-only');
    const external: string[] = [];
    page.on('request', (req) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) external.push(req.url());
    });
    await page.addInitScript(() => {
      (window as unknown as { cls: number }).cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!entry.hadRecentInput) (window as unknown as { cls: number }).cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const font = page.waitForResponse((res) => res.url().endsWith('/fonts/Geist-Variable.woff2'));
    await page.goto('/health');
    expect((await font).status()).toBe(200);
    await expect(page.locator('link[rel="preload"][as="font"][href="/fonts/Geist-Variable.woff2"]')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('14px Geist'))).toBe(true);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { cls: number }).cls)).toBeLessThan(0.01);
    expect(external).toEqual([]);
  });
});
