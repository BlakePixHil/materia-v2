import { randomUUID } from 'node:crypto';

import type { Timestamp } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { onWriteDefinition, syncDisbursement, type DisbursementWriteOutcome } from './on-write';
import { disbursementStatusPatch, setStatusDefinition } from './set-status';
import { planDisbursementSync } from './shared';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the disbursement functions (BILL-04). Every person, matter and amount is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters/m1`;
const DB = `${M}/disbursements`;
const NOW = new Date('2026-10-09T00:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const disbursement = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  date: '2026-10-01',
  description: 'Title search',
  payee: 'Fictional Titles Office',
  amountExGstCents: 2_000,
  gstCents: 200,
  gstTreatment: 'taxable',
  status: 'unbilled',
  wipCountedCents: 0,
  ...extra,
});

beforeAll(() => setRemoteFlagLoader(async () => ({})));
afterAll(() => setRemoteFlagLoader());

describe('planDisbursementSync', () => {
  it('recomputes GST from the treatment, overwriting a tampered preview, and counts it ex GST', () => {
    expect(planDisbursementSync(disbursement({ gstCents: 0 }), undefined)).toEqual({
      patch: { gstCents: 200, wipCountedCents: 2_000 },
      wipDelta: 2_000,
    });
    expect(planDisbursementSync(disbursement({ gstTreatment: 'gst_free', gstCents: 200 }), undefined)).toEqual({
      patch: { gstCents: 0, wipCountedCents: 2_000 },
      wipDelta: 2_000,
    });
  });

  it('derives ex GST from a GST-inclusive amount, the remainder in the GST', () => {
    expect(
      planDisbursementSync(disbursement({ amountIncGstCents: 1_105, amountExGstCents: 1, gstCents: 1 }), undefined),
    ).toEqual({ patch: { amountExGstCents: 1_005, gstCents: 100, wipCountedCents: 1_005 }, wipDelta: 1_005 });
  });

  it('does nothing when already right and counted', () => {
    expect(planDisbursementSync(disbursement({ wipCountedCents: 2_000 }), undefined)).toEqual({
      patch: {},
      wipDelta: 0,
    });
  });

  it('keeps billed and written-off amounts, and takes them and deleted ones out of WIP', () => {
    for (const change of [{ status: 'billed' }, { status: 'written_off' }, { deletedAt: NOW }]) {
      expect(planDisbursementSync(disbursement({ wipCountedCents: 2_000, gstCents: 7, ...change }), undefined)).toEqual(
        {
          patch: { wipCountedCents: 0 },
          wipDelta: -2_000,
        },
      );
    }
  });

  it('takes a hard-deleted disbursement’s count back, and marks an uncounted one', () => {
    expect(planDisbursementSync(undefined, disbursement({ wipCountedCents: 2_000 }))).toEqual({
      patch: {},
      wipDelta: -2_000,
    });
    const legacy: Record<string, unknown> = disbursement({ status: 'billed' });
    delete legacy['wipCountedCents'];
    expect(planDisbursementSync(legacy, undefined)).toEqual({ patch: { wipCountedCents: 0 }, wipDelta: 0 });
  });

  it('leaves malformed amounts and treatments alone', () => {
    expect(planDisbursementSync(disbursement({ gstTreatment: 'luxury', gstCents: 5 }), undefined).patch).toEqual({
      wipCountedCents: 2_000,
    });
    expect(planDisbursementSync(disbursement({ amountExGstCents: -5, gstCents: 5 }), undefined).patch).toEqual({});
  });
});

describe('disbursementStatusPatch', () => {
  it('writes off unbilled ones and restores written-off ones, nothing else', () => {
    expect(disbursementStatusPatch(disbursement(), 'written_off')).toEqual({ status: 'written_off' });
    expect(disbursementStatusPatch(disbursement({ status: 'written_off' }), 'unbilled')).toEqual({
      status: 'unbilled',
    });
    expect(disbursementStatusPatch(disbursement(), 'unbilled')).toBeNull();
    expect(disbursementStatusPatch(disbursement({ status: 'billed' }), 'written_off')).toBeNull();
    expect(disbursementStatusPatch(disbursement({ status: 'billed' }), 'unbilled')).toBeNull();
    expect(disbursementStatusPatch(disbursement({ deletedAt: NOW }), 'written_off')).toBeNull();
    expect(disbursementStatusPatch(undefined, 'written_off')).toBeNull();
  });
});

function world(initial: Record<string, Record<string, unknown>> = {}, flagOn = true) {
  clearFlagCaches();
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', flags: { 'billing.disbursements': flagOn } },
    [M]: { ...meta, number: 'M-2026-0042', wipCents: 13_200 },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  let event = 0;
  const doc = (path: string) => store.docs.get(path);
  /** Writes a disbursement (as a client would), then runs the trigger for that write. */
  const write = async (id: string, data: Record<string, unknown> | undefined, base = DB) => {
    const path = `${base}/${id}`;
    const before = doc(path);
    if (data) store.docs.set(path, { ...before, ...data });
    else store.docs.delete(path);
    return fire(path, before);
  };
  const fire = (path: string, before: Record<string, unknown> | undefined): Promise<DisbursementWriteOutcome> => {
    const current = doc(path);
    const change = {
      before: before ? { ref: { path }, data: () => before } : undefined,
      after: current ? { ref: { path }, data: () => current } : undefined,
    } as unknown as TriggerChange;
    const parts = path.split('/');
    const ctx = {
      eventId: `e${++event}`,
      time: NOW,
      params: { orgId: ORG, matterId: parts[3], disbursementId: parts[5] },
      log,
      clock,
      db: store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return syncDisbursement(change, ctx);
  };
  const wip = (matter = M) => doc(matter)?.['disbursementWipCents'];
  return { ...store, clock, log, doc, write, fire, wip };
}

describe('disbursements-onWrite', () => {
  it('is declared on matter disbursements', () => {
    expect(onWriteDefinition).toMatchObject({ name: 'disbursements-onWrite', on: 'written' });
    expect(onWriteDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/disbursements/{disbursementId}');
  });

  it('keeps disbursementWipCents through edits, write-off, delete and restore, leaving time WIP alone', async () => {
    const w = world();
    await w.write('d1', disbursement({ gstCents: 0 }));
    expect(w.doc(`${DB}/d1`)).toMatchObject({ gstCents: 200, wipCountedCents: 2_000 });
    expect(w.wip()).toBe(2_000);
    expect((w.doc(M)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(NOW);
    await w.write('d2', disbursement({ amountExGstCents: 34_560, gstCents: 0, gstTreatment: 'gst_free' }));
    expect(w.wip()).toBe(36_560);
    expect(await w.write('d1', { amountIncGstCents: 5_500 })).toEqual({
      wipDelta: 3_000,
      patched: ['amountExGstCents', 'gstCents', 'wipCountedCents'],
    });
    expect(w.doc(`${DB}/d1`)).toMatchObject({ amountExGstCents: 5_000, gstCents: 500 });
    await w.write('d1', { status: 'written_off' });
    expect(w.wip()).toBe(34_560);
    await w.write('d1', { status: 'unbilled' });
    await w.write('d2', { deletedAt: NOW, deletedBy: 'user-lawyer' });
    expect(w.wip()).toBe(5_000);
    await w.write('d2', { deletedAt: null, deletedBy: null });
    await w.write('d1', undefined);
    expect(w.wip()).toBe(34_560);
    expect(w.doc(M)?.['wipCents']).toBe(13_200);
  });

  it('a redelivered or late event changes nothing', async () => {
    const w = world();
    await w.write('d1', disbursement());
    const before = w.doc(`${DB}/d1`);
    await w.write('d1', { amountExGstCents: 3_000 });
    expect(w.wip()).toBe(3_000);
    expect(await w.fire(`${DB}/d1`, before)).toEqual({ wipDelta: 0, patched: [] });
    expect(w.wip()).toBe(3_000);
  });

  it('keeps a matter-less disbursement’s count unchanged', async () => {
    const w = world();
    expect(await w.write('d1', disbursement({ matterId: 'gone' }), `orgs/${ORG}/matters/gone/disbursements`)).toEqual({
      wipDelta: 0,
      patched: [],
    });
    expect(w.doc(`orgs/${ORG}/matters/gone`)).toBeUndefined();
  });
});

describe('disbursements-setStatus', () => {
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
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      setStatusDefinition,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(w),
    );
  const seeded = (flagOn = true) =>
    world(
      {
        [`${DB}/d1`]: disbursement({ wipCountedCents: 2_000 }),
        [`${DB}/d2`]: disbursement({ status: 'written_off' }),
        [`${DB}/d3`]: disbursement({ status: 'billed', invoiceId: 'inv-1' }),
        [`${DB}/d4`]: disbursement({ deletedAt: NOW }),
      },
      flagOn,
    );

  it('writes off unbilled ones and skips the rest', async () => {
    const w = seeded();
    const result = await call(w, {
      matterId: 'm1',
      disbursementIds: ['d1', 'd2', 'd3', 'd4', 'missing'],
      status: 'written_off',
    });
    expect(result).toEqual({ updated: ['d1'], skipped: ['d2', 'd3', 'd4', 'missing'] });
    expect(w.doc(`${DB}/d1`)).toMatchObject({ status: 'written_off', updatedBy: 'user-lawyer' });
    expect(w.doc(`${DB}/d3`)?.['status']).toBe('billed');
  });

  it('restores written-off ones', async () => {
    const w = seeded();
    expect(await call(w, { matterId: 'm1', disbursementIds: ['d1', 'd2'], status: 'unbilled' })).toEqual({
      updated: ['d2'],
      skipped: ['d1'],
    });
  });

  it('needs time.approve, a matter the caller can see and the flag', async () => {
    const w = seeded();
    const input = { matterId: 'm1', disbursementIds: ['d1'], status: 'written_off' };
    await expect(call(w, input, 'paralegal')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(call(w, { ...input, matterId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(call(seeded(false), input)).rejects.toMatchObject({ details: { code: 'FEATURE_DISABLED' } });
  });
});
