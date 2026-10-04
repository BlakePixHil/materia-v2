import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations, signInAsTestUser } from '@materia/test-utils/e2e';

/** App shell (FND-12): sidebar, ⌘K palette, shortcuts and the phone TabBar. */

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

test.describe('desktop shell', () => {
  test.skip(({ isMobile }) => isMobile, 'The sidebar and keyboard shortcuts are desktop features');
  test.beforeEach(async ({ page, request }) => {
    await signInAsTestUser(page, request);
  });

  test('opens Today in the shell with the main navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/today$/);
    await expect(page).toHaveTitle('Today · Materia');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    const nav = sidebar(page).getByRole('navigation', { name: 'Main' });
    // Disputes is behind the litigation flag, off by default (FND-23).
    await expect(nav.getByRole('link')).toHaveText([
      'Today',
      'Inbox',
      'My tasks',
      'Matters',
      'Deadlines',
      'Contacts',
      'Time & billing',
      'Insights',
    ]);
    await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  test('navigates with ⌘K', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('deadl');
    await expect(page.getByRole('option').first()).toContainText('Go to Deadlines');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/deadlines$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Deadlines' })).toBeVisible();
    await expect(input).toHaveCount(0);

    // The command is now recent.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.mt-menu-label').first()).toHaveText('Recent');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox')).toHaveCount(0);
  });

  test('collapses the sidebar with [ and keeps it collapsed after a reload', async ({ page }) => {
    await page.goto('/today');
    const shell = page.locator('.mt-app');
    await expect(sidebar(page).getByText('Workspace')).toBeVisible();
    await page.keyboard.press('[');
    await expect(shell).toHaveAttribute('data-collapsed', '');
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBeLessThan(80);
    await expect(sidebar(page).getByRole('link', { name: 'Matters' })).toBeVisible();
    await page.reload();
    await expect(shell).toHaveAttribute('data-collapsed', '');
    await sidebar(page).getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(shell).not.toHaveAttribute('data-collapsed', '');
  });

  test('navigates with g then a key, and ? lists every shortcut', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page).toHaveURL(/\/matters$/);
    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toContainText('Open the command palette');
    await expect(sheet).toContainText('Go to Settings');
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('a deep link to an unknown matter tab lands on the overview', async ({ page }) => {
    await page.goto('/matters/M-2026-0142/bogus');
    await expect(page).toHaveURL(/\/matters\/M-2026-0142\/overview$/);
    await expect(page).toHaveTitle('Matter · M-2026-0142 · Materia');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('M-2026-0142');
  });

  test('keyboard-only: skip link, sidebar and palette are reachable', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Switch organisation' })).toBeFocused();
    await page.getByRole('button', { name: 'Search' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('button', { name: 'Search' })).toBeFocused();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the shell has no WCAG 2.2 AA violations (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/today');
      await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
      await expectNoA11yViolations(page);
      await page.screenshot({ path: test.info().outputPath(`shell-${theme}.png`) });
      await page.keyboard.press('ControlOrMeta+j');
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('combobox')).toBeFocused();
      await expectNoA11yViolations(page);
    });
  }
});

test.describe('phone shell', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page, request }) => {
    await signInAsTestUser(page, request);
  });

  test('shows the TabBar instead of the sidebar', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);
    const tabs = page.locator('.mt-tabbar');
    await expect(tabs).toBeVisible();
    await tabs.getByRole('link', { name: 'Matters' }).click();
    await expect(page).toHaveURL(/\/matters$/);
    await expect(tabs.getByRole('link', { name: 'Matters' })).toHaveAttribute('aria-current', 'page');
    await expectNoA11yViolations(page);
  });
});
