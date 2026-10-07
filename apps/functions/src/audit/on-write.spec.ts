import { Timestamp } from 'firebase-admin/firestore';

import { audit } from './audit';
import { onMatterWriteDefinition, onOrgWriteDefinition, recordWrite } from './on-write';
import { clearRetentionCache, DEFAULT_RETENTION_YEARS, retentionYears } from './retention';
import type { TriggerChange, TriggerContext } from '../core/trigger';

const AT = new Date('2026-10-04T00:00:00.000Z');

/** A tiny in-memory stand-in for the Firestore calls the audit code makes. */
function fakeDb(orgs: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  let auto = 0;
  const reads: string[] = [];
  const ref = (path: string) => ({
    id: path.split('/').at(-1),
    path,
    get: async () => {
      reads.push(path);
      const data = orgs[path];
      return { exists: !!data, get: (field: string) => data?.[field] };
    },
    create: async (data: Record<string, unknown>) => {
      if (docs.has(path)) throw Object.assign(new Error('exists'), { code: 6 });
      docs.set(path, data);
    },
  });
  const db = {
    doc: ref,
    collection: (path: string) => ({
      doc: (id?: string) => ref(id ? `${path}/${id}` : `${path}/auto-${++auto}`),
      where: (field: string, _op: 'in', values: unknown[]) => ({
        limit: () => ({
          get: async () => ({
            empty: !Object.entries(orgs).some(
              ([key, data]) => key.startsWith(`${path}/`) && values.includes(data[field]),
            ),
          }),
        }),
      }),
    }),
  };
  return { db: db as unknown as TriggerContext['db'], docs, reads };
}

const snap = (path: string, data: Record<string, unknown>) => ({ ref: { path }, data: () => data });

function ctx(db: TriggerContext['db'], eventId = 'evt-1'): TriggerContext {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  return {
    eventId,
    time: AT,
    params: { orgId: 'org-a' },
    log: log as unknown as TriggerContext['log'],
    clock: { now: () => AT },
    db,
    ports: {} as TriggerContext['ports'],
  };
}

const change = (
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
  path = 'orgs/org-a/matters/m1/notes/n1',
) => ({ before: before && snap(path, before), after: after && snap(path, after) }) as unknown as TriggerChange;

beforeEach(() => clearRetentionCache());

describe('recordWrite', () => {
  it('writes one entry under the event id, at the event time, expiring after the org retention', async () => {
    const { db, docs } = fakeDb({ 'orgs/org-a': { retentionYears: 10 } });
    const result = await recordWrite(
      change(undefined, { bodyMd: 'Spoke with the executor', updatedBy: 'user-1' }),
      ctx(db),
    );
    expect(result).toBe('written');
    const entry = docs.get('orgs/org-a/audit/evt-1');
    expect(entry).toMatchObject({
      at: AT,
      action: 'create',
      actor: { uid: 'user-1' },
      expireAt: new Date('2036-10-04T00:00:00.000Z'),
    });
    expect(JSON.stringify(entry)).not.toContain('executor');
  });

  it('is a no-op the second time for the same event id', async () => {
    const { db, docs } = fakeDb();
    const write = change({ status: 'a', updatedBy: 'u' }, { status: 'b', updatedBy: 'u' });
    expect(await recordWrite(write, ctx(db, 'evt-dup'))).toBe('written');
    expect(await recordWrite(write, ctx(db, 'evt-dup'))).toBe('duplicate');
    expect(docs.size).toBe(1);
  });

  it('skips writes that are not audited', async () => {
    const { db, docs } = fakeDb();
    expect(await recordWrite(change(undefined, { x: 1 }, 'orgs/org-a/metrics/m'), ctx(db))).toBe('skipped');
    expect(await recordWrite(change(), ctx(db))).toBe('skipped');
    expect(docs.size).toBe(0);
  });

  it("leaves the migration tool's deletes to its one entry: a rollback, or a delta deleting what legacy deleted", async () => {
    const migrated = (runId: string) => ({
      title: 'Call executor',
      updatedBy: 'user-1',
      migration: { runId, legacyPath: 'workflows/w/cards/c', loadedAt: AT },
    });
    const removed = (runId: string) => change(migrated(runId), undefined, 'orgs/org-a/matters/m1/tasks/t1');
    const rollback = fakeDb({ 'orgs/org-a/migrations/run-back': { status: 'rolling_back' } });
    expect(await recordWrite(removed('run-back'), ctx(rollback.db, 'e1'))).toBe('skipped');
    const { db, docs } = fakeDb({
      'orgs/org-a/migrations/run-done': { status: 'rolled_back' },
      'orgs/org-a/migrations/run-ok': { status: 'succeeded' },
    });
    expect(await recordWrite(removed('run-done'), ctx(db, 'e2'))).toBe('skipped');
    // The run's record went with the org it created.
    expect(await recordWrite(removed('run-gone'), ctx(db, 'e3'))).toBe('skipped');
    // Otherwise a migrated document's delete is an ordinary one.
    expect(await recordWrite(removed('run-ok'), ctx(db, 'e4'))).toBe('written');
    expect([...docs.keys()]).toEqual(['orgs/org-a/audit/e4']);
    expect(rollback.docs.size).toBe(0);

    const delta = fakeDb({
      'orgs/org-a/migrations/run-ok': { status: 'succeeded' },
      'orgs/org-a/migrations/run-delta': { status: 'running' },
    });
    expect(await recordWrite(removed('run-ok'), ctx(delta.db, 'e5'))).toBe('skipped');
    expect(delta.docs.size).toBe(0);
  });

  it('rethrows other write failures (the wrapper logs them as dead letters)', async () => {
    const { db } = fakeDb();
    const broken = {
      ...db,
      doc: (path: string) =>
        path.includes('/audit/') ? { create: () => Promise.reject(new Error('unavailable')) } : db.doc(path),
    } as unknown as TriggerContext['db'];
    await expect(recordWrite(change(undefined, { a: 1 }), ctx(broken))).rejects.toThrow('unavailable');
  });

  it('runs from both trigger definitions', async () => {
    const { db, docs } = fakeDb();
    await onOrgWriteDefinition.handler(change(undefined, { a: 1 }, 'orgs/org-a/contacts/c1'), ctx(db, 'e-org'));
    await onMatterWriteDefinition.handler(change(undefined, { a: 1 }), ctx(db, 'e-matter'));
    expect([...docs.keys()]).toEqual(['orgs/org-a/audit/e-org', 'orgs/org-a/audit/e-matter']);
    expect(onOrgWriteDefinition.document).toBe('orgs/{orgId}/{collection}/{docId}');
    expect(onMatterWriteDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/{sub}/{docId}');
  });
});

describe('retentionYears', () => {
  it('reads the org setting once per ten minutes and defaults to seven years', async () => {
    const { db, reads } = fakeDb({ 'orgs/org-a': { retentionYears: 8 }, 'orgs/org-b': { retentionYears: 'x' } });
    expect(await retentionYears(db, 'org-a', 0)).toBe(8);
    expect(await retentionYears(db, 'org-a', 60_000)).toBe(8);
    expect(reads).toEqual(['orgs/org-a']);
    expect(await retentionYears(db, 'org-a', 11 * 60_000)).toBe(8);
    expect(reads).toHaveLength(2);
    expect(await retentionYears(db, 'org-b', 0)).toBe(DEFAULT_RETENTION_YEARS);
    expect(await retentionYears(db, 'org-missing', 0)).toBe(DEFAULT_RETENTION_YEARS);
  });
});

describe('audit()', () => {
  const callCtx = (db: TriggerContext['db']) => ({
    uid: 'user-1',
    orgId: 'org-a',
    requestId: 'req-9',
    db,
    clock: { now: () => AT },
  });

  it('records a semantic event from a callable', async () => {
    const { db, docs } = fakeDb();
    const id = await audit(callCtx(db), {
      action: 'invoice.issued',
      entity: { path: 'orgs/org-a/invoices/inv-42' },
      summary: 'Invoice INV-0042 issued',
      data: { number: 'INV-0042', narrative: 'Professional fees for the estate' },
    });
    expect(id).toBe('auto-1');
    expect(docs.get('orgs/org-a/audit/auto-1')).toMatchObject({
      at: AT,
      actor: { uid: 'user-1' },
      action: 'invoice.issued',
      entity: { path: 'orgs/org-a/invoices/inv-42', collection: 'invoices', id: 'inv-42' },
      summary: 'Invoice INV-0042 issued',
      requestId: 'req-9',
      source: 'callable',
      data: { number: 'INV-0042', narrative: { len: 32 } },
    });
    expect((docs.get('orgs/org-a/audit/auto-1')?.['expireAt'] as Date).toISOString()).toBe('2033-10-04T00:00:00.000Z');
  });

  it('rejects write-style actions and other orgs', async () => {
    const { db } = fakeDb();
    await expect(
      audit(callCtx(db), { action: 'update', entity: { path: 'orgs/org-a/x/1' }, summary: 's' }),
    ).rejects.toThrow(/invoice\.issued/);
    await expect(
      audit(callCtx(db), { action: 'member.role_changed', entity: { path: 'orgs/org-b/members/u' }, summary: 's' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('works without extra data', async () => {
    const { db, docs } = fakeDb();
    await audit(callCtx(db), {
      action: 'export.created',
      entity: { path: 'orgs/org-a/exports/e1' },
      summary: 'Export created',
    });
    expect(docs.get('orgs/org-a/audit/auto-1')).not.toHaveProperty('data');
    expect(Timestamp).toBeDefined();
  });
});
