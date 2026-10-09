import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA (Agent handbook, Non-negotiables). */
export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** Both themes are first-class (docs/03): the accessibility audit (SEC-06) scans every page in each. */
export type A11yTheme = 'light' | 'dark';
export const A11Y_THEMES: readonly A11yTheme[] = ['light', 'dark'];

export interface A11yOptions {
  /** CSS selectors to leave out of the scan, for third-party widgets only. Document each one. */
  exclude?: string[];
  /** axe rule tags to run instead of {@link A11Y_TAGS}, such as `best-practice` for an advisory pass. */
  tags?: readonly string[];
}

/**
 * Waits for finite CSS transitions and animations to finish, so axe measures the settled UI. WebKit
 * animates a freshly rendered button's background from transparent, and a contrast check taken
 * mid-transition reads white text on near-white. Infinite animations (spinners, shimmer) are skipped.
 *
 * It first waits two frames: ng-primitives sets a dialog's `data-enter` (and so starts its fade-in
 * from opacity 0) on the next animation frame, which on a busy WebKit runner could come after the
 * dialog's text was already asserted, so the scan read the dialog mid-fade (CI: color-contrast on
 * the Note history dialog).
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/**
 * Every axe violation on the page, one line each: `rule (impact): help → targets`.
 *
 * The scan runs with reduced motion emulated, so the app's reduced-motion rule (libs/ui base.css)
 * makes every animation instant. Settling first isn't enough on its own: something that appears
 * while axe runs, such as a toast from a server write, would otherwise be measured mid fade-in
 * (CI: color-contrast on a deadlines toast's description and action at a fraction of its opacity).
 */
export async function a11yViolations(page: Page, options: A11yOptions = {}): Promise<string[]> {
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags([...(options.tags ?? A11Y_TAGS)]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  let violations;
  try {
    ({ violations } = await builder.analyze());
  } finally {
    if (!reduced) await page.emulateMedia({ reducedMotion: null });
  }
  return violations.map(
    (v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

/** Fails the test with a readable list if axe finds any WCAG 2.2 AA violation on the page. */
export async function expectNoA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  expect(await a11yViolations(page, options), 'axe WCAG 2.2 AA violations').toEqual([]);
}

/** The theme the app shows (`data-theme` on `<html>`, set by ThemeService and the boot script). */
export function shownTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/**
 * Switches the app to a theme through the operating system's preference: with no explicit choice
 * stored (a fresh account), ThemeService follows `prefers-color-scheme` live, as a person's OS
 * switching to dark at sunset would. Waits until the app shows it.
 */
export async function useTheme(page: Page, theme: A11yTheme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect.poll(() => shownTheme(page), { message: `the app shows the ${theme} theme` }).toBe(theme);
}

/**
 * Every axe violation on the page in each theme, as {@link a11yViolations} lines prefixed with the
 * theme. The page is left in the last theme scanned.
 */
export async function a11yViolationsInThemes(
  page: Page,
  options: A11yOptions & { themes?: readonly A11yTheme[] } = {},
): Promise<string[]> {
  const found: string[] = [];
  for (const theme of options.themes ?? A11Y_THEMES) {
    await useTheme(page, theme);
    for (const line of await a11yViolations(page, options)) found.push(`[${theme}] ${line}`);
  }
  return found;
}

/** {@link expectNoA11yViolations} in the light and the dark theme. */
export async function expectNoA11yViolationsInThemes(
  page: Page,
  options: A11yOptions & { themes?: readonly A11yTheme[] } = {},
): Promise<void> {
  expect(await a11yViolationsInThemes(page, options), 'axe WCAG 2.2 AA violations').toEqual([]);
}
