import { randomUUID } from 'node:crypto';

import type { Timestamp } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { recordSnapshotDefinition } from './record-snapshot';
import { updateSettingsDefinition } from './update-settings';
import { runCallable, type CallableDeps, type CallableDefinition } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the trust snapshot callables (BILL-11, ADR-035). Every matter and amount is fictional. */

const ORG = 'org-a';
// 10:30 on 5 Oct in Melbourne, still 4 Oct in UTC.
const NOW = new Date('2026-10-04T23:30:00Z');
const meta = { createdBy: 'user-owner', updatedBy: 'user-owner', schemaVersion: 1 };
const TRUST = { showOnMatters: true, system: 'other', otherName: 'In-house trust records', staleAfterDays: 30 };

function world(org: Record<string, unknown> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      timezone: 'Australia/Melbourne',
      flags: { 'billing.trustDisplay': true },
      trust: TRUST,
      ...org,
    },
    [`orgs/${ORG}/matters/m1`]: { ...meta, number: 'M-2026-0042', title: 'Estate of Fictional Quill' },
    [`orgs/${ORG}/matters/m-gone`]: { ...meta, number: 'M-2026-0043', deletedAt: NOW },
    [`orgs/${ORG}/matters/m-priv`]: { ...meta, number: 'M-2026-0044', privileged: true },
  });
  return { ...store, clock: new FakeClock(NOW), doc: (path: string) => store.docs.get(path), store };
}

type World = ReturnType<typeof world>;

const deps = (w: World): CallableDeps => ({
  db: () => w.db,
  clock: w.clock,
  ports: () => fakePorts(),
  memberLookup: async () => true,
  idempotency: {
    begin: async () => ({ replay: false }),
    complete: async () => undefined,
    abandon: async () => undefined,
  },
  sink: () => undefined,
});

function call<T>(def: CallableDefinition<never, T>, w: World, data: Record<string, unknown>, role: Role = 'lawyer') {
  return runCallable(
    def,
    { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
    deps(w),
  );
}

const record = (w: World, data: Record<string, unknown>, role: Role = 'lawyer') =>
  call(
    recordSnapshotDefinition as never,
    w,
    { matterId: 'm1', amountCents: 8_421_000, asAt: '2026-10-05', ...data },
    role,
  );

const audits = (w: World) =>
  [...w.store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, entry]) => entry);

beforeEach(() => setRemoteFlagLoader(async () => ({})));
afterEach(() => clearFlagCaches());

describe('trust-recordSnapshot', () => {
  it('records the copied balance with its as-at date and source, and audits it', async () => {
    const w = world();
    await expect(record(w, { note: 'Trust ledger report 5 Oct' })).resolves.toEqual({ saved: true });
    expect(w.doc(`orgs/${ORG}/trustSnapshots/m1`)).toMatchObject({
      matterId: 'm1',
      amountCents: 8_421_000,
      // Today in Melbourne, though UTC is still on the 4th.
      asAt: '2026-10-05',
      source: 'manual',
      sourceSystemName: 'In-house trust records',
      note: 'Trust ledger report 5 Oct',
      recordedBy: 'user-lawyer',
    });
    expect((w.doc(`orgs/${ORG}/trustSnapshots/m1`)?.['recordedAt'] as Timestamp).toDate()).toEqual(NOW);
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'trust.snapshot_recorded',
        summary: 'Trust balance snapshot recorded',
        entity: expect.objectContaining({ path: `orgs/${ORG}/trustSnapshots/m1`, collection: 'trustSnapshots' }),
        data: expect.objectContaining({ amountCents: 8_421_000, asAt: '2026-10-05' }),
      }),
    ]);
  });

  it('replaces the snapshot on update, keeping its creation and auditing the previous amount', async () => {
    const w = world({ trust: { ...TRUST, system: 'smokeball', otherName: undefined } });
    await record(w, { amountCents: 500_000, asAt: '2026-09-01' });
    w.clock.advance(60_000);
    await record(w, { amountCents: 420_000, asAt: '2026-10-02' }, 'admin');
    expect(w.doc(`orgs/${ORG}/trustSnapshots/m1`)).toMatchObject({
      amountCents: 420_000,
      asAt: '2026-10-02',
      sourceSystemName: 'Smokeball',
      createdBy: 'user-lawyer',
      updatedBy: 'user-admin',
      recordedBy: 'user-admin',
    });
    expect(audits(w).at(-1)).toMatchObject({
      summary: 'Trust balance snapshot updated',
      data: { previousAmountCents: 500_000, previousAsAt: '2026-09-01' },
    });
  });

  it('refuses a future as-at date and a negative or fractional amount', async () => {
    const w = world();
    await expect(record(w, { asAt: '2026-10-06' })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      message: 'The as-at date can’t be in the future',
    });
    await expect(record(w, { amountCents: -100 })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    });
    await expect(record(w, { amountCents: 10.5 })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    });
    expect(w.doc(`orgs/${ORG}/trustSnapshots/m1`)).toBeUndefined();
  });

  it('allows a long-past as-at date (it shows as out of date)', async () => {
    const w = world();
    await expect(record(w, { asAt: '2025-01-31' })).resolves.toEqual({ saved: true });
  });

  it('refuses paralegals and read-only members', async () => {
    for (const role of ['paralegal', 'readonly'] as const) {
      await expect(record(world(), {}, role)).rejects.toMatchObject({
        details: expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      });
    }
  });

  it('refuses while the flag or the org switch is off, and for deleted or unknown matters', async () => {
    await expect(record(world({ flags: {} }), {})).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FEATURE_DISABLED' }),
    });
    clearFlagCaches();
    await expect(record(world({ trust: { ...TRUST, showOnMatters: false } }), {})).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FAILED_PRECONDITION' }),
    });
    clearFlagCaches();
    await expect(record(world({ trust: undefined }), {})).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FAILED_PRECONDITION' }),
    });
    clearFlagCaches();
    await expect(record(world(), { matterId: 'm-gone' })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'NOT_FOUND' }),
    });
    await expect(record(world(), { matterId: 'missing' })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'NOT_FOUND' }),
    });
  });
});

describe('trust-updateSettings', () => {
  const update = (w: World, settings: Record<string, unknown>, role: Role = 'owner') =>
    call(updateSettingsDefinition as never, w, { settings }, role);

  it('saves the switch, the records and the threshold, and audits the change', async () => {
    const w = world({ trust: undefined });
    await expect(
      update(w, { showOnMatters: true, system: 'leap', otherName: 'ignored', staleAfterDays: 14 }),
    ).resolves.toEqual({ saved: true });
    expect(w.doc(`orgs/${ORG}`)?.['trust']).toEqual({ showOnMatters: true, system: 'leap', staleAfterDays: 14 });
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'trust.settings_updated',
        summary: 'Trust settings changed: showOnMatters, system, staleAfterDays',
      }),
    ]);
    // The same again: nothing to save.
    await expect(update(w, { showOnMatters: true, system: 'leap', staleAfterDays: 14 })).resolves.toEqual({
      saved: false,
    });
  });

  it('turning it off keeps the snapshots', async () => {
    const w = world();
    await record(w, {});
    await update(w, { ...TRUST, showOnMatters: false });
    expect(w.doc(`orgs/${ORG}`)?.['trust']).toMatchObject({ showOnMatters: false });
    expect(w.doc(`orgs/${ORG}/trustSnapshots/m1`)).toBeDefined();
  });

  it('needs a name for other records, and is for owners and admins only, behind the flag', async () => {
    await expect(update(world(), { showOnMatters: true, system: 'other', staleAfterDays: 30 })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    });
    await expect(update(world(), TRUST, 'lawyer')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    });
    await expect(update(world({ flags: {} }), TRUST)).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FEATURE_DISABLED' }),
    });
  });
});
