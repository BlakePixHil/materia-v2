import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Helpers for the SEC-07 performance specs (`chromium-perf`, run with E2E_PERF=1 against the
 * large practice: `materia-scripts seed-large`). They sign in as the full-load fee earner, whose
 * screens read what a fee earner's would at the target scale.
 */
export const PERF_ACCOUNT = { email: 'lawyer1@large.example', password: 'materia-local-dev' } as const;

/** Where the specs write their JSON and Lighthouse reports (CI uploads it). */
export function perfOutDir(): string {
  // Specs run from the workspace root (CommonJS, so no import.meta).
  const dir = process.env['PERF_OUT_DIR'] ?? path.resolve('dist/.playwright/apps/web-e2e/perf');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeReport(name: string, data: unknown): string {
  const file = path.join(perfOutDir(), name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
}

/** What the reads counter (libs/data-access read-counter.ts) has seen since it was last reset. */
export interface ReadSnapshot {
  reads: number;
  cached: number;
  byLabel: Record<string, { reads: number; cached: number; requests: number }>;
}

type CounterWindow = { __materiaReads?: { snapshot(): ReadSnapshot; reset(): void } };

export async function readSnapshot(page: Page): Promise<ReadSnapshot> {
  return page.evaluate(() => {
    const counter = (window as unknown as CounterWindow).__materiaReads;
    if (!counter) throw new Error('No reads counter: build the web app with --configuration=e2e (or development).');
    return counter.snapshot();
  });
}

export async function resetReads(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as CounterWindow).__materiaReads?.reset());
}

/**
 * Waits until the screen stops reading: the count unchanged for `quietMs` (listeners answered,
 * lookups done). Returns the snapshot then.
 */
export async function settledReads(page: Page, quietMs = 2500, timeoutMs = 45_000): Promise<ReadSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await readSnapshot(page);
  let since = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const now = await readSnapshot(page);
    if (now.reads !== last.reads || now.cached !== last.cached) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return now;
    }
  }
  throw new Error(`Reads didn't settle within ${timeoutMs} ms (last ${last.reads})`);
}

/** Signs in through the sign-in page as the perf account and waits for Today. */
export async function signInForPerf(page: Page): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Work email').fill(PERF_ACCOUNT.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password').fill(PERF_ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
}

/** The labels that read the most, for the report: `orgs/*\/matters/* (doc): 41 in 41 requests`. */
export function topLabels(snapshot: ReadSnapshot, count = 8): string[] {
  return Object.entries(snapshot.byLabel)
    .filter(([, e]) => e.reads > 0)
    .sort(([, a], [, b]) => b.reads - a.reads)
    .slice(0, count)
    .map(([label, e]) => `${label}: ${e.reads} in ${e.requests} request${e.requests === 1 ? '' : 's'}`);
}
