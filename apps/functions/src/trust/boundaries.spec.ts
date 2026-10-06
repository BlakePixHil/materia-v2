import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ACTIVITY_RULES, ruleFor } from '../activity/mapping';

/**
 * Trust balance snapshots stay out of invoices, client exports, emails, notifications and the
 * matter activity feed (BILL-11, ADR-035): only the trust callables write them, and only Clerk's
 * matter context reads them (for billing roles, with "Not the trust ledger").
 */

const ROOT = join(__dirname, '..');
// Where a snapshot may be read or written. Everything else (jobs, documents, mail, notifications,
// audit export, time and billing) must never mention one.
const ALLOWED = ['trust/', 'clerk/context/'];
const MENTIONS = /trustSnapshot|TrustSnapshot|trustBalance/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('trust snapshot boundaries', () => {
  it('are read and written only by the trust callables and Clerk’s matter context', () => {
    const mentioning = sources(ROOT)
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .filter((path) => MENTIONS.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(mentioning.length).toBeGreaterThan(0);
    expect(mentioning.filter((path) => !ALLOWED.some((prefix) => path.startsWith(prefix)))).toEqual([]);
  });

  it('never become matter activity, which every member reads', () => {
    expect(Object.keys(ACTIVITY_RULES).filter((key) => key.startsWith('trust'))).toEqual([]);
    const path = 'orgs/org-a/trustSnapshots/m1';
    for (const action of ['trust.snapshot_recorded', 'create', 'update']) {
      expect(
        ruleFor({ action, source: 'callable', entity: { path, collection: 'trustSnapshots', id: 'm1' } }),
      ).toBeUndefined();
    }
  });
});
