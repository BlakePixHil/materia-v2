import { randomUUID } from 'node:crypto';

import type { Timestamp } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { exportCsvDefinition } from './export';
import { onWriteDefinition, syncTimeEntry, type TimeWriteOutcome } from './on-write';
import { rejectDefinition } from './reject';
import { setStatusDefinition, statusPatch } from './set-status';
import { planTimeSync, rateOrg } from './shared';
import { writeDownDefinition } from './write-down';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the time functions (BILL-01). Every person, matter and entry is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters/m1`;
const TE = `${M}/timeEntries`;
const NOW = new Date('2026-10-09T00:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const BILLING = { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true };
const INPUTS = {
  org: { billing: { unitMinutes: 6, rounding: 'up' as const, defaultRateCents: 30000 } },
  matter: { fee: { arrangement: 'hourly' } },
  member: { rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }] },
};
const entry = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  uid: 'user-lawyer',
  date: '2026-10-01',
  minutes: 18,
  units: 3,
  rateCents: 44000,
  amountCents: 13200,
  narrative: 'Perusing and considering the will',
  billable: true,
  status: 'draft',
  source: 'manual',
  wipCountedCents: 0,
  ...extra,
});

describe('planTimeSync', () => {
  it('recomputes a draft from the rate in force, overwriting tampered values, and counts it', () => {
    expect(planTimeSync(entry({ units: 1, rateCents: 99999, amountCents: 1 }), undefined, INPUTS)).toEqual({
      patch: { units: 3, rateCents: 44000, amountCents: 13200, wipCountedCents: 13200 },
      wipDelta: 13200,
    });
  });

  it('does nothing for a draft that is already right and counted', () => {
    expect(planTimeSync(entry({ wipCountedCents: 13200 }), undefined, INPUTS)).toEqual({ patch: {}, wipDelta: 0 });
  });

  it('keeps a final entry’s snapshot, and takes billed, written-off, non-billable and deleted entries out of WIP', () => {
    expect(
      planTimeSync(
        entry({ status: 'final', rateCents: 40000, amountCents: 12000, wipCountedCents: 12000 }),
        undefined,
        INPUTS,
      ),
    ).toEqual({
      patch: {},
      wipDelta: 0,
    });
    for (const change of [{ status: 'billed' }, { status: 'written_off' }, { billable: false }, { deletedAt: NOW }]) {
      expect(planTimeSync(entry({ wipCountedCents: 13200, ...change }), undefined, INPUTS)).toEqual({
        patch: { wipCountedCents: 0 },
        wipDelta: -13200,
      });
    }
  });

  it('takes a hard-deleted entry’s count back', () => {
    expect(planTimeSync(undefined, entry({ wipCountedCents: 13200 }), INPUTS)).toEqual({ patch: {}, wipDelta: -13200 });
  });

  it('leaves values alone without billing settings, but still counts', () => {
    expect(planTimeSync(entry({ amountCents: 500 }), undefined, null)).toEqual({
      patch: { wipCountedCents: 500 },
      wipDelta: 500,
    });
    expect(rateOrg({ name: 'x' })).toBeNull();
    expect(rateOrg({ billing: { defaultRateCents: 100, rounding: 'nearest' } })).toEqual({
      billing: { defaultRateCents: 100, rounding: 'nearest' },
    });
  });

  it('marks a pre-BILL-01 entry (no wipCountedCents) as counted', () => {
    const legacy: Record<string, unknown> = entry({ billable: false });
    delete legacy['wipCountedCents'];
    expect(planTimeSync(legacy, undefined, INPUTS)).toEqual({ patch: { wipCountedCents: 0 }, wipDelta: 0 });
  });
});

describe('statusPatch', () => {
  it('approves drafts and returns final entries to draft, nothing else', () => {
    expect(statusPatch(entry(), 'final')).toEqual({ status: 'final' });
    expect(statusPatch(entry({ status: 'final' }), 'draft')).toEqual({ status: 'draft' });
    expect(statusPatch(entry({ status: 'final' }), 'final')).toBeNull();
    expect(statusPatch(entry({ status: 'billed' }), 'draft')).toBeNull();
    expect(statusPatch(entry({ status: 'written_off' }), 'final')).toBeNull();
    expect(statusPatch(entry({ deletedAt: NOW }), 'final')).toBeNull();
    expect(statusPatch(undefined, 'final')).toBeNull();
  });
});

function world(initial: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', billing: BILLING },
    [`orgs/${ORG}/members/user-lawyer`]: {
      ...meta,
      role: 'lawyer',
      status: 'active',
      defaultRateCents: 48000,
      rates: [
        { effectiveFrom: '2026-07-01', rateCents: 44000 },
        { effectiveFrom: '2026-10-05', rateCents: 48000 },
      ],
    },
    [`orgs/${ORG}/members/user-para`]: {
      ...meta,
      role: 'paralegal',
      status: 'active',
      defaultRateCents: 22000,
      rates: [],
    },
    [M]: { ...meta, number: 'M-2026-0042', fee: { arrangement: 'hourly', history: [] }, wipCents: 0 },
    [`orgs/${ORG}/matters/m-fixed`]: {
      ...meta,
      number: 'M-2026-0045',
      fee: { arrangement: 'hourly', rateOverrideCents: 35000 },
      wipCents: 0,
    },
    [`orgs/${ORG}/matters/m-priv`]: {
      ...meta,
      number: 'M-2026-0043',
      privileged: true,
      fee: { arrangement: 'hourly' },
      wipCents: 0,
    },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  let event = 0;
  const doc = (path: string) => store.docs.get(path);
  /** Writes an entry (as a client would), then runs the trigger for that write. */
  const write = async (id: string, data: Record<string, unknown> | undefined, base = TE) => {
    const path = `${base}/${id}`;
    const before = doc(path);
    if (data) store.docs.set(path, { ...before, ...data });
    else store.docs.delete(path);
    return fire(path, before);
  };
  const fire = (path: string, before: Record<string, unknown> | undefined): Promise<TimeWriteOutcome> => {
    const current = doc(path);
    const change = {
      before: before ? { ref: { path }, data: () => before } : undefined,
      after: current ? { ref: { path }, data: () => current } : undefined,
    } as unknown as TriggerChange;
    const parts = path.split('/');
    const ctx = {
      eventId: `e${++event}`,
      time: NOW,
      params: { orgId: ORG, matterId: parts[3], entryId: parts[5] },
      log,
      clock,
      db: store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return syncTimeEntry(change, ctx);
  };
  const wip = (matter = M) => doc(matter)?.['wipCents'];
  return { ...store, clock, log, doc, write, fire, wip };
}

describe('time-onWrite', () => {
  it('is declared on matter time entries', () => {
    expect(onWriteDefinition).toMatchObject({ name: 'time-onWrite', on: 'written' });
    expect(onWriteDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/timeEntries/{entryId}');
  });

  it('snapshots the rate in force on the entry’s date (a mid-month change) and keeps WIP', async () => {
    const w = world();
    await w.write('te1', entry({ date: '2026-10-04', units: 0, rateCents: 0, amountCents: 0 }));
    expect(w.doc(`${TE}/te1`)).toMatchObject({
      units: 3,
      rateCents: 44000,
      amountCents: 13200,
      wipCountedCents: 13200,
    });
    await w.write('te2', entry({ date: '2026-10-05', amountCents: 1 }));
    expect(w.doc(`${TE}/te2`)).toMatchObject({ rateCents: 48000, amountCents: 14400 });
    expect(w.wip()).toBe(13200 + 14400);
    expect((w.doc(M)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(NOW);
  });

  it('overrides a tampered amount on an edit, and follows edits, billable, delete and restore', async () => {
    const w = world();
    await w.write('te1', entry());
    expect(w.wip()).toBe(13200);
    expect(await w.write('te1', { minutes: 30, amountCents: 999999 })).toEqual({
      wipDelta: 8800,
      patched: ['units', 'amountCents', 'wipCountedCents'],
    });
    expect(w.doc(`${TE}/te1`)).toMatchObject({ units: 5, amountCents: 22000 });
    expect(w.wip()).toBe(22000);
    await w.write('te1', { billable: false });
    expect(w.wip()).toBe(0);
    await w.write('te1', { billable: true });
    await w.write('te1', { deletedAt: NOW, deletedBy: 'user-lawyer' });
    expect(w.wip()).toBe(0);
    await w.write('te1', { deletedAt: null, deletedBy: null });
    expect(w.wip()).toBe(22000);
    await w.write('te1', undefined);
    expect(w.wip()).toBe(0);
  });

  it('uses the matter’s rate override and the org default when the member has none', async () => {
    const w = world({
      [`orgs/${ORG}/members/user-none`]: { ...meta, role: 'lawyer', status: 'active', defaultRateCents: 0 },
    });
    await w.write('te1', entry({ matterId: 'm-fixed' }), `orgs/${ORG}/matters/m-fixed/timeEntries`);
    expect(w.doc(`orgs/${ORG}/matters/m-fixed/timeEntries/te1`)).toMatchObject({
      rateCents: 35000,
      amountCents: 10500,
    });
    await w.write('te2', entry({ uid: 'user-none' }));
    expect(w.doc(`${TE}/te2`)).toMatchObject({ rateCents: 30000, amountCents: 9000 });
  });

  it('a redelivered or late event changes nothing (it reconciles the current state)', async () => {
    const w = world();
    await w.write('te1', entry());
    const before = w.doc(`${TE}/te1`);
    await w.write('te1', { minutes: 60 });
    expect(w.wip()).toBe(44000);
    expect(await w.fire(`${TE}/te1`, before)).toEqual({ wipDelta: 0, patched: [] });
    expect(w.wip()).toBe(44000);
  });

  it('keeps a matter-less entry’s count unchanged', async () => {
    const w = world();
    expect(await w.write('te1', entry({ matterId: 'gone' }), `orgs/${ORG}/matters/gone/timeEntries`)).toEqual({
      wipDelta: 0,
      patched: [],
    });
    expect(w.doc(`orgs/${ORG}/matters/gone`)).toBeUndefined();
  });

  it('leaves a destroyed matter’s tombstone alone when its entries are deleted (CORE-19)', async () => {
    const w = world({ [`${TE}/te1`]: entry({ wipCountedCents: 13200 }) });
    w.docs.set(M, { ...w.doc(M), wipCents: 13200, destroyedAt: NOW });
    expect(await w.write('te1', undefined)).toEqual({ wipDelta: 0, patched: [] });
    expect(w.wip()).toBe(13200);
  });
});

const deps = (w: ReturnType<typeof world>): CallableDeps => ({
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
const audits = (w: ReturnType<typeof world>) =>
  [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, value]) => value);

describe('time-setStatus', () => {
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      setStatusDefinition,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(w),
    );
  const seeded = () =>
    world({
      [`${TE}/te1`]: entry({ rateCents: 1, amountCents: 1 }),
      [`${TE}/te2`]: entry({ status: 'final' }),
      [`${TE}/te3`]: entry({ status: 'billed' }),
      [`${TE}/te4`]: entry({ deletedAt: NOW }),
      [`${TE}/te5`]: entry({ uid: 'user-para', date: '2026-10-06' }),
    });

  it('approves drafts with a fresh snapshot and skips the rest', async () => {
    const w = seeded();
    const result = await call(w, {
      matterId: 'm1',
      entryIds: ['te1', 'te2', 'te3', 'te4', 'te5', 'missing'],
      status: 'final',
    });
    expect(result).toEqual({ updated: ['te1', 'te5'], skipped: ['te2', 'te3', 'te4', 'missing'], conflicts: [] });
    expect(w.doc(`${TE}/te1`)).toMatchObject({
      status: 'final',
      rateCents: 44000,
      amountCents: 13200,
      updatedBy: 'user-lawyer',
    });
    // A member with no rate history keeps their single rate.
    expect(w.doc(`${TE}/te5`)).toMatchObject({ status: 'final', rateCents: 22000, amountCents: 6600 });
    // BILL-03: one semantic audit row for the call, with ids only.
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'time.finalised',
        summary: '2 time entries marked final',
        entity: expect.objectContaining({ path: M }),
        data: { entryIds: ['te1', 'te5'] },
      }),
    ]);
  });

  it('leaves an entry the author changed since the approver saw it (optimistic concurrency)', async () => {
    const seen = new Date('2026-10-08T00:00:00Z');
    const w = world({
      [`${TE}/te1`]: entry({ updatedAt: new Date('2026-10-08T00:05:00Z') }),
      [`${TE}/te5`]: entry({ uid: 'user-para', updatedAt: seen }),
    });
    const result = await call(w, {
      matterId: 'm1',
      entryIds: ['te1', 'te5'],
      status: 'final',
      expectedUpdatedAt: { te1: seen.getTime(), te5: seen.getTime() },
    });
    expect(result).toEqual({ updated: ['te5'], skipped: [], conflicts: ['te1'] });
    expect(w.doc(`${TE}/te1`)?.['status']).toBe('draft');
  });

  it('clears a send-back note on approval', async () => {
    const w = world({ [`${TE}/te1`]: entry({ rejection: { note: 'Which call?', by: 'user-lawyer', at: NOW } }) });
    await call(w, { matterId: 'm1', entryIds: ['te1'], status: 'final' });
    expect(w.doc(`${TE}/te1`)).not.toHaveProperty('rejection');
  });

  it('returns final entries to draft', async () => {
    const w = seeded();
    expect(await call(w, { matterId: 'm1', entryIds: ['te1', 'te2'], status: 'draft' })).toEqual({
      updated: ['te2'],
      skipped: ['te1'],
      conflicts: [],
    });
    expect(w.doc(`${TE}/te2`)?.['status']).toBe('draft');
    expect(audits(w)).toEqual([expect.objectContaining({ action: 'time.returned_to_draft' })]);
  });

  it('needs time.approve and a matter the caller can see', async () => {
    const w = seeded();
    await expect(call(w, { matterId: 'm1', entryIds: ['te1'], status: 'final' }, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(call(w, { matterId: 'nope', entryIds: ['te1'], status: 'final' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses an archived matter (CORE-19)', async () => {
    const w = seeded();
    w.docs.set(M, { ...w.doc(M), status: 'archived' });
    await expect(call(w, { matterId: 'm1', entryIds: ['te1'], status: 'final' })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'matter_archived' },
    });
    expect(w.doc(`${TE}/te1`)?.['status']).toBe('draft');
  });
});

describe('time-writeDown', () => {
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      writeDownDefinition,
      {
        data: { requestId: randomUUID(), matterId: 'm1', reason: 'Over the estimate', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(w),
    );
  const seeded = () =>
    world({
      [`${TE}/te1`]: entry({ status: 'final', units: 10, amountCents: 44000, minutes: 60 }),
      [`${TE}/te2`]: entry({
        units: 5,
        amountCents: 22000,
        rejection: { note: 'Which call?', by: 'user-lawyer', at: NOW },
      }),
      [`${TE}/te3`]: entry({ status: 'billed' }),
    });

  it('writes one entry down to new units, approving it and keeping the originals', async () => {
    const w = seeded();
    expect(await call(w, { entryIds: ['te1'], newUnits: 6 })).toEqual({ updated: ['te1'], skipped: [], conflicts: [] });
    expect(w.doc(`${TE}/te1`)).toMatchObject({
      status: 'final',
      minutes: 60,
      units: 6,
      amountCents: 26400,
      writeDown: { originalUnits: 10, originalAmountCents: 44000, by: 'user-lawyer', reason: 'Over the estimate' },
      updatedBy: 'user-lawyer',
    });
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'time.written_down',
        summary: '1 time entry written down',
        data: { entryIds: ['te1'], newUnits: 6 },
      }),
    ]);
  });

  it('writes drafts down by a percentage, clearing a send-back note, and skips billed time', async () => {
    const w = seeded();
    expect(await call(w, { entryIds: ['te2', 'te3'], percent: 20 })).toEqual({
      updated: ['te2'],
      skipped: ['te3'],
      conflicts: [],
    });
    const te2 = w.doc(`${TE}/te2`);
    expect(te2).toMatchObject({ status: 'final', units: 4, amountCents: 17600 });
    expect(te2).not.toHaveProperty('rejection');
  });

  it('writes entries off, moving them out of WIP through the trigger', async () => {
    const w = seeded();
    await w.write('te1', {});
    expect(w.wip()).toBe(44000);
    await call(w, { entryIds: ['te1'], writeOff: true });
    expect(w.doc(`${TE}/te1`)).toMatchObject({ status: 'written_off', amountCents: 44000 });
    await w.fire(`${TE}/te1`, w.doc(`${TE}/te1`));
    expect(w.wip()).toBe(0);
    expect(audits(w)).toEqual([expect.objectContaining({ action: 'time.written_off', data: { entryIds: ['te1'] } })]);
  });

  it('skips a write-down that wouldn’t lower the value, and needs time.approve', async () => {
    const w = seeded();
    expect(await call(w, { entryIds: ['te1'], newUnits: 12 })).toMatchObject({ updated: [], skipped: ['te1'] });
    expect(audits(w)).toEqual([]);
    await expect(call(w, { entryIds: ['te1'], percent: 10 }, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(call(w, { entryIds: ['te1'] })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('time-reject', () => {
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>) =>
    runCallable(
      rejectDefinition,
      {
        data: { requestId: randomUUID(), matterId: 'm1', note: 'Which call was this?', ...data },
        auth: { uid: 'user-lawyer', token: { orgId: ORG, role: 'lawyer' } },
      },
      deps(w),
    );

  it('sends drafts back with a note and leaves other entries', async () => {
    const w = world({
      [`${TE}/te1`]: entry({ uid: 'user-para' }),
      [`${TE}/te2`]: entry({ status: 'final' }),
    });
    expect(await call(w, { entryIds: ['te1', 'te2'] })).toEqual({ updated: ['te1'], skipped: ['te2'], conflicts: [] });
    const te1 = w.doc(`${TE}/te1`) as Record<string, Timestamp | Record<string, unknown>>;
    expect(te1).toMatchObject({ status: 'draft', rejection: { note: 'Which call was this?', by: 'user-lawyer' } });
    expect(((te1['rejection'] as Record<string, Timestamp>)['at'] as Timestamp).toDate()).toEqual(NOW);
    expect((te1['updatedAt'] as Timestamp).toDate()).toEqual(NOW);
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'time.rejected',
        summary: '1 time entry sent back',
        data: { entryIds: ['te1'] },
      }),
    ]);
  });
});

describe('time-exportCsv', () => {
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      exportCsvDefinition,
      {
        data: { from: '2026-10-01', to: '2026-10-31', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role, auth_time: NOW.getTime() / 1000 - 60 } },
      },
      deps(w),
    );
  const seeded = () =>
    world({
      [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active', displayName: 'Jordan Price' },
      [M]: {
        ...meta,
        number: 'M-2026-0042',
        title: 'Estate of Ivy Santoro',
        type: 'probate',
        responsibleUid: 'user-lawyer',
      },
      [`${TE}/te1`]: entry({ status: 'final', date: '2026-10-02', narrative: '=cmd' }),
      [`${TE}/te2`]: entry({ date: '2026-10-03' }),
      [`${TE}/te3`]: entry({ status: 'final', date: '2026-09-30' }),
      [`${TE}/te4`]: entry({ status: 'final', date: '2026-10-04', deletedAt: NOW }),
      [`orgs/${ORG}/matters/m-priv/timeEntries/te5`]: entry({
        matterId: 'm-priv',
        status: 'final',
        date: '2026-10-05',
      }),
    });

  it('exports the filtered entries as CSV, oldest first, and audits the export', async () => {
    const w = seeded();
    const result = await call(w, { unbilledOnly: true });
    expect(result).toMatchObject({ rows: 2, truncated: false });
    const lines = result.csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      "2026-10-02,M-2026-0042,Estate of Ivy Santoro,Jordan Price,'=cmd,18,3,0.30,440.00,132.00,Yes,final,,",
    );
    expect(lines[2]).toContain('M-2026-0043');
    expect(audits(w)).toEqual([
      expect.objectContaining({ action: 'time.exported', summary: 'Time exported (2 entries)' }),
    ]);
  });

  it('filters by person, status, responsible lawyer and matter type', async () => {
    const w = seeded();
    expect((await call(w, { uid: 'user-lawyer', status: 'draft' })).rows).toBe(1);
    expect((await call(w, { matterType: 'will' })).rows).toBe(0);
    expect((await call(w, { responsibleUid: 'user-lawyer' })).rows).toBe(2);
    await expect(call(w, {}, 'paralegal')).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
