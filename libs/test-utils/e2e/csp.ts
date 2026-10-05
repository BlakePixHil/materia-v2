import type { Page } from '@playwright/test';

/**
 * Collects Content Security Policy violations on a page (FND-22). CI serves the app from the Hosting
 * emulator with the real policy, so a blocked script, request, image or frame shows up here. Call
 * it before the page loads and read the list at the end: `expect(csp()).toEqual([])`.
 */
export function watchCspViolations(page: Page): () => string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  return () => [...violations];
}
