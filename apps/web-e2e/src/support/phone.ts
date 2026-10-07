import { devices, type Page } from '@playwright/test';

/** Phone helpers for the e2e specs (MOB-02, MOB-05). */

/** A device's screen, without its browser: the project's browser runs it (a describe can't switch browsers). */
export function phone(name: 'iPhone 12' | 'Pixel 7' | 'iPhone 12 landscape') {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name];
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
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
