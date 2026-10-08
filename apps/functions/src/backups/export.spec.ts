import { exportedCollectionIds } from '@materia/domain';

import {
  collectionsToExport,
  exportDue,
  exportsBucket,
  exportFirestore,
  exportFolder,
  exportPlan,
  type ExportDeps,
} from './export';
import { createLog, type LogSink } from '../core/log';

const silent: LogSink = () => undefined;

function fakeDeps(responses: object[], clock = { t: 0 }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: ExportDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      const body = responses.shift();
      if (!body) throw new Error('no more responses');
      return new Response(JSON.stringify(body), { status: 'status' in body ? Number(body.status) : 200 });
    }) as typeof fetch,
    token: async () => 'token',
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls };
}

describe('exportPlan', () => {
  it('exports the last whole minute at least a minute ago, under daily/', () => {
    const plan = exportPlan('materia-v2-dev', new Date('2026-10-05T15:00:42.123Z'));
    expect(plan).toEqual({
      kind: 'daily',
      snapshotTime: '2026-10-05T14:59:00Z',
      outputUriPrefix: 'gs://materia-v2-dev-exports/daily/2026-10-05T14-59-00Z',
    });
  });

  it('uses monthly/ on the 1st in Melbourne, which is still the 30th in UTC', () => {
    // 2026-10-31T15:00Z is 02:00 on 1 November in Melbourne (AEDT).
    expect(exportPlan('p', new Date('2026-10-31T15:01:00Z')).kind).toBe('monthly');
    expect(exportPlan('p', new Date('2026-11-01T15:01:00Z')).kind).toBe('daily');
  });

  it('names the bucket and folder', () => {
    expect(exportsBucket('materia-v2-prod')).toBe('materia-v2-prod-exports');
    expect(exportFolder('2026-10-05T14:59:00.000Z')).toBe('2026-10-05T14-59-00Z');
  });
});

describe('exportFirestore', () => {
  const plan = exportPlan('materia-v2-dev', new Date('2026-10-05T15:00:00Z'));
  const log = createLog({ fn: 'backups-exportFirestore' }, silent);

  it('starts the export with the snapshot time and waits for the operation', async () => {
    const { deps, calls } = fakeDeps([
      { name: 'projects/materia-v2-dev/databases/(default)/operations/op1' },
      { name: 'projects/materia-v2-dev/databases/(default)/operations/op1', done: false },
      {
        name: 'projects/materia-v2-dev/databases/(default)/operations/op1',
        done: true,
        metadata: { progressDocuments: { completedWork: '1234' } },
      },
    ]);
    await expect(exportFirestore(deps, 'materia-v2-dev', plan, log)).resolves.toEqual({ documents: 1234 });
    expect(calls[0]?.url).toBe(
      'https://firestore.googleapis.com/v1/projects/materia-v2-dev/databases/(default):exportDocuments',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      outputUriPrefix: 'gs://materia-v2-dev-exports/daily/2026-10-05T14-59-00Z',
      snapshotTime: '2026-10-05T14:59:00Z',
    });
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer token');
    expect(calls[1]?.url).toBe(
      'https://firestore.googleapis.com/v1/projects/materia-v2-dev/databases/(default)/operations/op1',
    );
    expect(calls).toHaveLength(3);
  });

  it('names the collections to take when the plan lists them (SEC-07h)', async () => {
    const { deps, calls } = fakeDeps([{ name: 'ops/op4', done: true }]);
    await exportFirestore(deps, 'materia-v2-dev', { ...plan, collectionIds: ['matters', 'orgs'] }, log);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      outputUriPrefix: 'gs://materia-v2-dev-exports/daily/2026-10-05T14-59-00Z',
      snapshotTime: '2026-10-05T14:59:00Z',
      collectionIds: ['matters', 'orgs'],
    });
  });

  it('throws when the operation fails', async () => {
    const { deps } = fakeDeps([
      { name: 'ops/op2' },
      { name: 'ops/op2', done: true, error: { code: 7, message: 'PERMISSION_DENIED' } },
    ]);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('Export ops/op2 failed: 7 PERMISSION_DENIED');
  });

  it('throws when the API refuses the request', async () => {
    const { deps } = fakeDeps([{ status: 403, error: { message: 'denied' } }]);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('Firestore admin API 403');
  });

  it('gives up after 25 minutes', async () => {
    const pending = Array.from({ length: 200 }, () => ({ name: 'ops/op3', done: false }));
    const { deps } = fakeDeps(pending);
    await expect(exportFirestore(deps, 'p', plan, log)).rejects.toThrow('still running after 25 minutes');
  });
});

describe('what the export takes (SEC-07h)', () => {
  it('takes every known collection and every one the walk finds, but Clerk’s chunks', async () => {
    const lines: string[] = [];
    const log = createLog({ fn: 'backups-exportFirestore' }, (_severity, message) => lines.push(message));
    const { collectionIds, skipped } = await collectionsToExport(
      // heartbeats, requests and manifest: server-only ones dev's first export warned about.
      async () => ['orgs', 'matters', 'documents', 'chunks', 'eventGuards', 'heartbeats', 'requests', 'manifest'],
      log,
    );
    expect(skipped).toEqual(['chunks']);
    expect(collectionIds).toEqual(exportedCollectionIds([]));
    expect(collectionIds).toEqual(expect.arrayContaining(['documents', 'eventGuards', 'invoices', 'matters', 'orgs']));
    expect(collectionIds).not.toContain('chunks');
    expect(lines).toEqual([]);
  });

  it('exports a collection the list doesn’t know, and warns so the list gets it', async () => {
    const lines: string[] = [];
    const log = createLog({ fn: 'backups-exportFirestore' }, (severity, message, entry) =>
      lines.push(`${severity}: ${message} ${JSON.stringify(entry['collections'])}`),
    );
    const { collectionIds } = await collectionsToExport(async () => ['orgs', 'somethingNew'], log);
    expect(collectionIds).toContain('somethingNew');
    expect(lines).toEqual(['warn: collections missing from FIRESTORE_COLLECTION_IDS: somethingNew ["somethingNew"]']);
  });

  it('exports everything when the walk fails, so no night is lost', async () => {
    const lines: string[] = [];
    const log = createLog({ fn: 'backups-exportFirestore' }, (severity, message) =>
      lines.push(`${severity}: ${message}`),
    );
    await expect(collectionsToExport(async () => Promise.reject(new Error('denied')), log)).resolves.toEqual({
      skipped: [],
    });
    expect(lines).toEqual(['warn: collection walk failed, exporting everything']);
  });

  it('runs every night by default, and every few days when the cadence says so, always on the 1st', () => {
    // 02:00 Melbourne on 6, 7 and 8 October 2026 (AEDT), and on 1 November.
    const night = (utc: string) => exportPlan('p', new Date(utc));
    const nights = ['2026-10-05T15:01:00Z', '2026-10-06T15:01:00Z', '2026-10-07T15:01:00Z'].map(night);
    expect(nights.map((plan) => exportDue(plan))).toEqual([true, true, true]);
    const everyOther = nights.map((plan) => exportDue(plan, 2));
    expect(everyOther.filter(Boolean)).toHaveLength(2);
    expect(everyOther[0]).toBe(everyOther[2]);
    expect(everyOther[0]).not.toBe(everyOther[1]);
    const first = night('2026-10-31T15:01:00Z');
    expect(first.kind).toBe('monthly');
    expect(exportDue(first, 7)).toBe(true);
  });
});
