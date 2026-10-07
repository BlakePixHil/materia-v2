import { execFileSync } from 'node:child_process';

import { test, webkit } from '@playwright/test';

import { Audit, MATTER, PHONE, PHONE_AUDIT_ROUTES, signInToAuditPractice, ZONE } from './support/audit';

/**
 * The phone audit in WebKit, iPhone Safari's engine, on a pull request that changes a phone screen
 * (SEC-06b). PRs test in Chromium only and the morning run adds WebKit, so a phone screen's
 * WebKit-only accessibility problem would otherwise first show after merge. It runs from the
 * Chromium project and opens WebKit itself; it is skipped when the PR changes no phone screen, and
 * outside a PR (the morning run audits the phone in WebKit already). `E2E_PHONE_AUDIT=1` runs it
 * anyway. Fictional data only.
 */

/** The files behind the phone screens (MOB-*): a PR that changes one runs the audit. */
const PHONE_SCREEN_FILES = [
  // The shell and its TabBar, the phone layout, the PWA's banners and push.
  /^apps\/web\/src\/app\/shell\//,
  /^apps\/web\/src\/app\/core\/(layout|pwa|push)\//,
  // The TabBar's destinations that only a phone has, and the phone versions of the others.
  /^apps\/web\/src\/app\/features\/(today|record|scan|more)\//,
  /^apps\/web\/src\/app\/.+\/phone-[\w-]+\.ts$/,
  // The design system's phone parts.
  /^libs\/ui\/src\/lib\/(bottom-sheet|pull-refresh|nav)\//,
  // This audit itself.
  /^apps\/web-e2e\/src\/a11y-phone\.spec\.ts$/,
];

/**
 * The files a pull request changes. CI checks out the PR's merge commit, whose first parent is the
 * base branch. Empty outside a PR or when git can't tell.
 */
function changedFiles(): string[] {
  if (process.env['GITHUB_EVENT_NAME'] !== 'pull_request') return [];
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD^1', 'HEAD'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

const phoneScreensChanged = () =>
  process.env['E2E_PHONE_AUDIT'] === '1' ||
  changedFiles().some((file) => PHONE_SCREEN_FILES.some((pattern) => pattern.test(file)));

test.describe('accessibility audit at phone width in WebKit', () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Opens WebKit from Chromium');
  test.skip(!phoneScreensChanged(), 'Only for a PR that changes a phone screen');

  test('Today, Record and the main destinations, in iPhone Safari’s engine', async ({ request, baseURL }) => {
    test.setTimeout(300_000);
    const browser = await webkit.launch();
    try {
      const context = await browser.newContext({
        ...PHONE,
        ...(baseURL ? { baseURL } : {}),
        timezoneId: ZONE,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const audit = new Audit(page);
      await signInToAuditPractice(page, request, 'lawyer');
      for (const url of PHONE_AUDIT_ROUTES(MATTER)) await audit.visit(url);
      audit.expectClean();
    } finally {
      await browser.close();
    }
  });
});
