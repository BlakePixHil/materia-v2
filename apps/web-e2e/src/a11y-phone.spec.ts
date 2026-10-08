import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

/**
 * The files behind the phone screens (MOB-*): a PR that changes one runs the audit. The patterns are
 * in phone-screen-files.txt, which CI also reads to install WebKit's system packages on that PR's
 * Chromium leg.
 */
const PHONE_SCREEN_FILES = readFileSync(path.resolve(__dirname, '../phone-screen-files.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => new RegExp(line));

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
