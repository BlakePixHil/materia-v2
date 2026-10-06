import type { FirestoreSource } from './firestore/firestore-client';
import { InMemoryTimerPort } from './testing/in-memory-timer';
import { firestoreTimerPort, readTimer, timerCallables } from './timer';

/** The global timer's storage (BILL-02). */

const SERVER = { __server: true };
const UID = 'user-jordan';
const AT = new Date('2026-10-06T00:00:00.000Z');

function fakeSource(existing: Record<string, unknown> | null = null) {
  const calls: { op: string; path?: string; data?: unknown }[] = [];
  let listener: ((snap: unknown) => void) | undefined;
  const snap = (data: Record<string, unknown> | null, pending = false) => ({
    exists: () => !!data,
    data: () => data,
    metadata: { hasPendingWrites: pending, fromCache: false },
  });
  let fail: unknown = null;
  const sdk = {
    doc: (_db: unknown, path: string) => ({ path }),
    serverTimestamp: () => SERVER,
    onSnapshot: (_ref: unknown, _options: unknown, next: (s: unknown) => void) => {
      listener = next;
      return () => calls.push({ op: 'unsubscribe' });
    },
    setDoc: async (ref: { path: string }, data: unknown) => void calls.push({ op: 'setDoc', path: ref.path, data }),
    updateDoc: async (ref: { path: string }, data: unknown) => {
      if (fail) throw fail;
      calls.push({ op: 'updateDoc', path: ref.path, data });
    },
    deleteDoc: async (ref: { path: string }) => {
      if (fail) throw fail;
      calls.push({ op: 'deleteDoc', path: ref.path });
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async () => snap(existing),
        set: (ref: { path: string }, data: unknown) => calls.push({ op: 'tx.set', path: ref.path, data }),
      }),
  };
  const source = { get: async () => ({ sdk, db: {} }) } as unknown as FirestoreSource;
  return {
    source,
    calls,
    emit: (data: Record<string, unknown> | null, pending = false) => listener?.(snap(data, pending)),
    failWith: (error: unknown) => (fail = error),
  };
}

const stored = {
  orgId: 'org-1',
  matterId: 'm-1',
  matterNumber: 'M-2026-0001',
  startedAt: { toDate: () => AT },
  accumulatedMs: 1000,
  running: true,
  narrativeDraft: 'Draft',
  lastHeartbeatAt: AT,
  forgotten: { reason: 'long', at: AT },
};

describe('readTimer', () => {
  it('reads a stored timer, Timestamps and all', () => {
    expect(readTimer(stored)).toEqual({
      orgId: 'org-1',
      matterId: 'm-1',
      matterNumber: 'M-2026-0001',
      taskId: undefined,
      startedAt: AT,
      accumulatedMs: 1000,
      running: true,
      narrativeDraft: 'Draft',
      lastHeartbeatAt: AT,
      clientStarted: false,
      needsReview: undefined,
      forgotten: { reason: 'long', at: AT },
      forgottenSeenAt: undefined,
    });
  });

  it('falls back on bad fields, and is null without a matter', () => {
    expect(readTimer(null)).toBeNull();
    expect(readTimer({ running: true })).toBeNull();
    expect(readTimer({ matterId: 'm-1', accumulatedMs: 'x', forgotten: { reason: 'nope', at: AT } })).toMatchObject({
      matterNumber: 'm-1',
      accumulatedMs: 0,
      running: false,
      startedAt: null,
      forgotten: undefined,
    });
  });
});

describe('firestoreTimerPort', () => {
  it('watches users/{uid}/timer/current', async () => {
    const fake = fakeSource();
    const seen: unknown[] = [];
    const stop = firestoreTimerPort(fake.source).watch(
      UID,
      (s) => seen.push(s),
      () => undefined,
    );
    await Promise.resolve();
    await Promise.resolve();
    fake.emit(stored, true);
    fake.emit(null);
    expect(seen).toEqual([
      { timer: expect.objectContaining({ matterId: 'm-1' }), pending: true, fromCache: false },
      { timer: null, pending: false, fromCache: false },
    ]);
    stop();
    expect(fake.calls).toEqual([{ op: 'unsubscribe' }]);
  });

  it('reports a failed start of the listener', async () => {
    const source = { get: () => Promise.reject(new Error('no sdk')) } as unknown as FirestoreSource;
    const errors: unknown[] = [];
    firestoreTimerPort(source).watch(
      UID,
      () => undefined,
      (e) => errors.push(e),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
  });

  it('starts in a transaction with the server’s time', async () => {
    const fake = fakeSource();
    const outcome = await firestoreTimerPort(fake.source).start(
      UID,
      { orgId: 'org-1', matterId: 'm-1', matterNumber: 'M-2026-0001', taskId: 't-1' },
      { offline: false, now: AT },
    );
    expect(outcome).toEqual({ started: true });
    expect(fake.calls[0]).toMatchObject({
      op: 'tx.set',
      path: `users/${UID}/timer/current`,
      data: { matterId: 'm-1', taskId: 't-1', startedAt: SERVER, running: true, accumulatedMs: 0, createdBy: UID },
    });
    expect((fake.calls[0]?.data as Record<string, unknown>)['clientStarted']).toBeUndefined();
  });

  it('returns the timer already there instead (two tabs at once)', async () => {
    const fake = fakeSource(stored);
    const outcome = await firestoreTimerPort(fake.source).start(
      UID,
      { orgId: 'org-1', matterId: 'm-2', matterNumber: 'M-2026-0002' },
      { offline: false, now: AT },
    );
    expect(outcome).toMatchObject({ started: false, current: { matterId: 'm-1' } });
    expect(fake.calls).toEqual([]);
  });

  it('starts offline on the device clock', async () => {
    const fake = fakeSource();
    await firestoreTimerPort(fake.source).start(
      UID,
      { orgId: 'org-1', matterId: 'm-1', matterNumber: 'M-2026-0001' },
      { offline: true, now: AT },
    );
    expect(fake.calls[0]).toMatchObject({ op: 'setDoc', data: { startedAt: AT, clientStarted: true } });
  });

  it('updates with a heartbeat and the meta, and discards', async () => {
    const fake = fakeSource();
    const port = firestoreTimerPort(fake.source);
    await port.update(UID, { running: true, startedAt: 'server', forgottenSeenAt: 'server' });
    await port.update(UID, { startedAt: AT });
    await port.discard(UID);
    expect(fake.calls).toEqual([
      {
        op: 'updateDoc',
        path: `users/${UID}/timer/current`,
        data: {
          running: true,
          startedAt: SERVER,
          forgottenSeenAt: SERVER,
          lastHeartbeatAt: SERVER,
          updatedAt: SERVER,
          updatedBy: UID,
        },
      },
      expect.objectContaining({ data: expect.objectContaining({ startedAt: AT }) }),
      { op: 'deleteDoc', path: `users/${UID}/timer/current` },
    ]);
  });

  it('turns failures into domain errors', async () => {
    const fake = fakeSource();
    fake.failWith(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const port = firestoreTimerPort(fake.source);
    await expect(port.update(UID, {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(port.discard(UID)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('timerCallables', () => {
  it('stops through time-stopTimer, idempotently', async () => {
    const call = vi.fn().mockResolvedValue({ matterId: 'm-1', entryIds: ['e-1'], minutes: 24 });
    await timerCallables({ call }).stop({ narrative: 'Call', split: false });
    expect(call).toHaveBeenCalledWith('time-stopTimer', { narrative: 'Call', split: false }, { idempotent: true });
  });
});

describe('InMemoryTimerPort', () => {
  it('keeps one timer per person', async () => {
    const port = new InMemoryTimerPort(() => AT);
    const seen: unknown[] = [];
    port.watch(UID, (s) => seen.push(s.timer?.matterId ?? null));
    await Promise.resolve();
    const start = { orgId: 'org-1', matterId: 'm-1', matterNumber: 'M-1' };
    expect(await port.start(UID, start, { offline: false, now: AT })).toEqual({ started: true });
    expect(await port.start(UID, { ...start, matterId: 'm-2' }, { offline: false, now: AT })).toMatchObject({
      started: false,
    });
    await port.update(UID, { running: false, accumulatedMs: 5 });
    await port.discard(UID);
    await expect(port.update(UID, {})).rejects.toThrow('No timer');
    expect(seen).toEqual([null, 'm-1', 'm-1', null]);
  });
});
