import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA (Agent handbook, Non-negotiables). */
export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export interface A11yOptions {
  /** CSS selectors to leave out of the scan, for third-party widgets only. Document each one. */
  exclude?: string[];
}

/**
 * Waits for finite CSS transitions and animations to finish, so axe measures the settled UI. WebKit
 * animates a freshly rendered button's background from transparent, and a contrast check taken
 * mid-transition reads white text on near-white. Infinite animations (spinners, shimmer) are skipped.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Fails the test with a readable list if axe finds any WCAG 2.2 AA violation on the page. */
export async function expectNoA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags([...A11Y_TAGS]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  const summary = violations.map(
    (v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary, 'axe WCAG 2.2 AA violations').toEqual([]);
}
