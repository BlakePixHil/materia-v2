import { AdminApi, snapshotTimeOfFolder } from './admin-api.ts';
import { scripted } from './fake.ts';

const F = 'https://firestore.googleapis.com/v1';

describe('AdminApi', () => {
  it('lists ready backups of (default), newest first', async () => {
    const { deps, calls } = scripted([
      {
        backups: [
          {
            name: 'b/old',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-04T15:00:00Z',
            state: 'READY',
          },
          {
            name: 'b/new',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-05T15:00:00Z',
            state: 'READY',
          },
          {
            name: 'b/busy',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-06T15:00:00Z',
            state: 'CREATING',
          },
          {
            name: 'b/other',
            database: 'projects/p/databases/drill',
            snapshotTime: '2026-10-06T15:00:00Z',
            state: 'READY',
          },
        ],
      },
    ]);
    const backups = await new AdminApi(deps, 'p').listBackups('australia-southeast1');
    expect(backups.map((b) => b.name)).toEqual(['b/new', 'b/old']);
    expect(calls[0]?.url).toBe(`${F}/projects/p/locations/australia-southeast1/backups`);
  });

  it('restores, clones, creates, imports and deletes databases', async () => {
    const op = { name: 'projects/p/databases/x/operations/1', done: true };
    const { deps, calls } = scripted([op, op, op, op, op]);
    const api = new AdminApi(deps, 'p');
    await api.restore('x', 'projects/p/locations/l/backups/b1');
    await api.clone('x', '2026-10-05T15:00:00Z');
    await api.createDatabase('x', 'australia-southeast1');
    await api.importDocuments('x', 'gs://p-backups/daily/2026-10-05T15-00-00Z');
    await api.deleteDatabase('x');
    expect(calls).toEqual([
      {
        url: `${F}/projects/p/databases:restore`,
        method: 'POST',
        body: { databaseId: 'x', backup: 'projects/p/locations/l/backups/b1' },
      },
      {
        url: `${F}/projects/p/databases:clone`,
        method: 'POST',
        body: {
          databaseId: 'x',
          pitrSnapshot: { database: 'projects/p/databases/(default)', snapshotTime: '2026-10-05T15:00:00Z' },
        },
      },
      {
        url: `${F}/projects/p/databases?databaseId=x`,
        method: 'POST',
        body: { locationId: 'australia-southeast1', type: 'FIRESTORE_NATIVE' },
      },
      {
        url: `${F}/projects/p/databases/x:importDocuments`,
        method: 'POST',
        body: { inputUriPrefix: 'gs://p-backups/daily/2026-10-05T15-00-00Z' },
      },
      { url: `${F}/projects/p/databases/x`, method: 'DELETE' },
    ]);
  });

  it('waits for an operation and surfaces its error', async () => {
    const { deps, calls, clock } = scripted([
      { name: 'ops/1', done: false },
      { name: 'ops/1', done: true },
      { name: 'ops/2', done: true, error: { code: 9, message: 'FAILED_PRECONDITION' } },
    ]);
    const api = new AdminApi(deps, 'p');
    await expect(api.wait({ name: 'ops/1' })).resolves.toMatchObject({ done: true });
    expect(calls.map((c) => c.url)).toEqual([`${F}/ops/1`, `${F}/ops/1`]);
    expect(clock.t).toBe(20_000);
    await expect(api.wait({ name: 'ops/2' })).rejects.toThrow('ops/2 failed: 9 FAILED_PRECONDITION');
  });

  it('gives up waiting after the timeout', async () => {
    const { deps } = scripted(Array.from({ length: 10 }, () => ({ name: 'ops/3', done: false })));
    await expect(new AdminApi(deps, 'p').wait({ name: 'ops/3' }, { pollMs: 1000, timeoutMs: 3000 })).rejects.toThrow(
      'still running',
    );
  });

  it('throws on an HTTP error with the status', async () => {
    const { deps } = scripted([{ status: 403, error: 'denied' }]);
    await expect(new AdminApi(deps, 'p').deleteDatabase('x')).rejects.toThrow(
      'DELETE https://firestore.googleapis.com/v1/projects/p/databases/x: 403',
    );
  });

  it('lists finished exports in daily/ and monthly/, newest first, across pages', async () => {
    const { deps, calls } = scripted([
      {
        items: [{ name: 'daily/2026-10-04T15-00-00Z/2026-10-04T15-00-00Z.overall_export_metadata' }],
        nextPageToken: 't2',
      },
      {
        items: [
          { name: 'daily/2026-10-05T15-00-00Z/2026-10-05T15-00-00Z.overall_export_metadata' },
          { name: 'daily/junk/junk.overall_export_metadata' },
        ],
      },
      { items: [{ name: 'monthly/2026-09-30T15-00-00Z/2026-09-30T15-00-00Z.overall_export_metadata' }] },
    ]);
    const exports = await new AdminApi(deps, 'p').listExports('p-backups');
    expect(exports).toEqual([
      { uri: 'gs://p-backups/daily/2026-10-05T15-00-00Z', kind: 'daily', snapshotTime: '2026-10-05T15:00:00Z' },
      { uri: 'gs://p-backups/daily/2026-10-04T15-00-00Z', kind: 'daily', snapshotTime: '2026-10-04T15:00:00Z' },
      { uri: 'gs://p-backups/monthly/2026-09-30T15-00-00Z', kind: 'monthly', snapshotTime: '2026-09-30T15:00:00Z' },
    ]);
    expect(calls[1]?.url).toContain('pageToken=t2');
    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain('matchGlob=daily/*/*.overall_export_metadata');
  });

  it('lists collection ids at a read time, across pages', async () => {
    const { deps, calls } = scripted([
      { collectionIds: ['tasks'], nextPageToken: 'n' },
      { collectionIds: ['documents'] },
    ]);
    const ids = await new AdminApi(deps, 'p').listCollectionIds(
      '(default)',
      'orgs/o1/matters/m1',
      '2026-10-05T15:00:00.000Z',
    );
    expect(ids).toEqual(['tasks', 'documents']);
    expect(calls[0]).toEqual({
      url: `${F}/projects/p/databases/(default)/documents/orgs/o1/matters/m1:listCollectionIds`,
      method: 'POST',
      body: { pageSize: 300, readTime: '2026-10-05T15:00:00.000Z' },
    });
    expect(calls[1]?.body).toMatchObject({ pageToken: 'n' });
  });

  it('parses export folder names', () => {
    expect(snapshotTimeOfFolder('2026-10-05T14-59-00Z')).toBe('2026-10-05T14:59:00Z');
    expect(snapshotTimeOfFolder('2026-10-05')).toBeNull();
  });
});
