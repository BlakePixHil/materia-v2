import { devices, type Locator, type Page } from '@playwright/test';

/** Phone helpers for the e2e specs (MOB-02, MOB-05). */

/** A device's screen, without its browser: the project's browser runs it (a describe can't switch browsers). */
export function phone(name: 'iPhone 12' | 'Pixel 7' | 'iPhone 12 landscape') {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name];
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
}

/** Whether the page has the app's phone layout: narrower than 768px, as the app's `MOBILE_QUERY`. */
export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? Infinity) < 768;
}

/**
 * The matter's section links. A phone's Overview (MOB-02) has no tab bar: it lists the other
 * sections under "More on this matter" at its foot. Every other tab has the bar, Overview included.
 */
export function matterTabs(page: Page): Locator {
  return page.getByRole('navigation', { name: /^(Matter sections|More on this matter)$/ });
}

const PHONE_SECTIONS = { 'Key facts': 'facts', 'Open tasks': 'tasks', 'Pinned notes': 'notes' } as const;

/**
 * A card on the matter's Overview. A phone's Overview (MOB-02) has sections that fold instead: Key
 * facts, Tasks (the open ones) and Notes (the latest few, pinned ones marked). Notes starts folded.
 */
export function overviewCard(page: Page, name: keyof typeof PHONE_SECTIONS): Locator {
  return isPhone(page)
    ? page.locator(`mt-phone-matter [data-section="${PHONE_SECTIONS[name]}"]`)
    : page.getByRole('region', { name });
}

/**
 * The matter's current stage on the stepper. A phone (MOB-02) draws the track without labels and
 * names the current stage under it: "Stage 2 of 6 · Grant application".
 */
export function currentStage(page: Page, title: string): Locator {
  const stepper = page.locator('mt-estate-stepper');
  return isPhone(page)
    ? stepper.locator('.mt-stepper-now').filter({ hasText: new RegExp(`Stage \\d+ of \\d+ · ${title}\\s*$`) })
    : stepper.getByRole('button', { name: new RegExp(`^${title}\\s*, current$`) });
}

/** Picks a stage on the stepper: its step, or on a phone the stage menu under the track. */
export async function chooseStage(page: Page, title: string): Promise<void> {
  const stepper = page.locator('mt-estate-stepper');
  if (!isPhone(page)) return stepper.getByRole('button', { name: title, exact: true }).click();
  await stepper.getByRole('button', { name: /Change stage$/ }).click();
  await page.getByRole('menu', { name: 'Move the matter to' }).getByRole('menuitem', { name: title }).click();
}

/**
 * Visible controls smaller than 44 × 44px. A control counts its label's box when it sits in one (a
 * checkbox in a row), and links inside running text are left out (WCAG 2.5.8's inline exception).
 */
export function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]';
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // Not shown, or visually hidden.
      if (element.closest('[inert], [aria-hidden="true"]')) continue;
      if (element.matches('a') && style.display === 'inline' && element.closest('p, li > span, .mt-md')) continue;
      const label = element.closest('label');
      if (label) rect = label.getBoundingClientRect();
      if (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44) continue;
      const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ');
      const where =
        element.className && typeof element.className === 'string' ? `.${element.className.split(' ')[0]}` : '';
      small.push(
        `${element.tagName.toLowerCase()}${where} “${name.slice(0, 40)}” ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      );
    }
    return small;
  });
}
