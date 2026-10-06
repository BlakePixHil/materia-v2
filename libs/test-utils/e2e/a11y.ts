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
 * Fails the test with a readable list if axe finds any WCAG 2.2 AA violation on the page.
 *
 * The scan runs with reduced motion emulated, so the app's reduced-motion rule (libs/ui base.css)
 * makes every animation instant. Settling first isn't enough on its own: something that appears
 * while axe runs, such as a toast from a server write, would otherwise be measured mid fade-in
 * (CI: color-contrast on a deadlines toast's description and action at a fraction of its opacity).
 */
export async function expectNoA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags([...A11Y_TAGS]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  let violations;
  try {
    ({ violations } = await builder.analyze());
  } finally {
    if (!reduced) await page.emulateMedia({ reducedMotion: null });
  }
  const summary = violations.map(
    (v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary, 'axe WCAG 2.2 AA violations').toEqual([]);
}
