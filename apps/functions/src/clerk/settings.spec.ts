import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { CLERK_DISCLOSURE_VERSION, MAX_OCR_DAILY_PAGES, type Role } from '@materia/domain';

import { updateSettingsDefinition } from './settings';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** `clerk-updateSettings` (AI-13) against the in-memory Firestore; a fictional practice only. */
const ORG = 'org-clerk-settings';

function world(initial: Record<string, unknown> = { model: 'claude-sonnet-5-5' }) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Settings Legal', retentionYears: 7, settings: { clerk: initial } },
  });
  const clock = new FakeClock(new Date('2026-10-05T00:00:00Z'));
  const deps: CallableDeps = {
    db: () => store.db,
    clock,
    ports: () => fakePorts({ clock }),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  };
  const call = (data: Record<string, unknown>, role: Role = 'admin') =>
    runCallable(
      updateSettingsDefinition as unknown as CallableDefinition<never, { changed: string[] }>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `u-${role}`, token: { orgId: ORG, role } } },
      deps,
    );
  const clerk = () => (store.docs.get(`orgs/${ORG}`)?.['settings'] as { clerk: Record<string, unknown> }).clerk;
  const audits = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);
  return { call, clerk, audits };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as HttpsError,
  );

beforeEach(() => clearRetentionCache());

describe('clerk-updateSettings', () => {
  it('turns features off, sets limits and audits what changed, keeping the model', async () => {
    const w = world();
    const result = await w.call({
      enabled: true,
      features: { chat: false, brief: true },
      monthlyBudgetCents: 25_000,
      perUserDailyRequests: 150,
    });
    expect(result.changed.sort()).toEqual(['features.chat', 'monthlyBudgetCents', 'perUserDailyRequests']);
    expect(w.clerk()).toMatchObject({
      model: 'claude-sonnet-5-5',
      enabled: true,
      features: { chat: false, brief: true },
      monthlyBudgetCents: 25_000,
      perUserDailyRequests: 150,
    });
    expect(w.audits()).toEqual([
      expect.objectContaining({
        action: 'clerk.settings_changed',
        data: {
          changes: {
            'features.chat': { from: true, to: false },
            monthlyBudgetCents: { from: null, to: 25_000 },
            perUserDailyRequests: { from: null, to: 150 },
          },
        },
      }),
    ]);
  });

  it('clears a limit with null, and writes nothing when nothing changes', async () => {
    const w = world({ monthlyBudgetCents: 1000 });
    expect((await w.call({ monthlyBudgetCents: null })).changed).toEqual(['monthlyBudgetCents']);
    expect(w.clerk()).not.toHaveProperty('monthlyBudgetCents');
    expect((await w.call({ monthlyBudgetCents: null, enabled: true })).changed).toEqual([]);
    expect(w.audits()).toHaveLength(1);
  });

  it('sets the daily OCR page limit, 0 included, and null goes back to the default', async () => {
    const w = world();
    expect((await w.call({ ocrDailyPages: 0 })).changed).toEqual(['ocrDailyPages']);
    expect(w.clerk()['ocrDailyPages']).toBe(0);
    expect((await w.call({ ocrDailyPages: 500 })).changed).toEqual(['ocrDailyPages']);
    expect(w.clerk()['ocrDailyPages']).toBe(500);
    expect((await w.call({ ocrDailyPages: null })).changed).toEqual(['ocrDailyPages']);
    expect(w.clerk()).not.toHaveProperty('ocrDailyPages');
    expect(w.audits().map((entry) => entry['data'])).toEqual([
      { changes: { ocrDailyPages: { from: null, to: 0 } } },
      { changes: { ocrDailyPages: { from: 0, to: 500 } } },
      { changes: { ocrDailyPages: { from: 500, to: null } } },
    ]);
    expect((await errorOf(w.call({ ocrDailyPages: MAX_OCR_DAILY_PAGES + 1 })))?.details).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('records who acknowledged which version of the disclosure, and refuses an old version', async () => {
    const w = world();
    expect((await w.call({ acknowledgeVersion: CLERK_DISCLOSURE_VERSION }, 'owner')).changed).toEqual([
      'acknowledgement',
    ]);
    expect(w.clerk()).toMatchObject({ ackVersion: CLERK_DISCLOSURE_VERSION, acknowledgedBy: 'u-owner' });
    expect(w.clerk()['acknowledgedAt']).toBeDefined();
    expect(w.audits()[0]?.['summary']).toBe(
      `Clerk data-use disclosure version ${CLERK_DISCLOSURE_VERSION} acknowledged`,
    );
    const error = await errorOf(w.call({ acknowledgeVersion: CLERK_DISCLOSURE_VERSION + 1 }));
    expect(error?.details).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'disclosure_outdated' });
  });

  it('refuses lawyers and unknown fields', async () => {
    const w = world();
    expect((await errorOf(w.call({ enabled: false }, 'lawyer')))?.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await errorOf(w.call({ model: 'claude-opus-5-5' })))?.details).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(w.clerk()).toEqual({ model: 'claude-sonnet-5-5' });
  });
});
