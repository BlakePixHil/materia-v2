import { TestBed } from '@angular/core/testing';

import { MIGRATION_CALLABLES } from '@materia/domain';

import { CallableClient } from './callable-client';
import { latestMigrationRuns, migrationCallables, migrationRunsRepository, type MigrationRunItem } from './migration';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** The legacy migration's runs and the migration-* review callables (MIG-08). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-06T21:00:00Z'),
  createdBy: 'system',
  updatedAt: new Date('2026-10-06T21:30:00Z'),
  updatedBy: 'system',
  schemaVersion: 1,
};
const REQUEST = '00000000-0000-4000-8000-000000000001';

const run = (runId: string, mode: MigrationRunItem['mode'], startedAt: string, extra: object = {}) => ({
  runId,
  mode,
  status: 'succeeded' as const,
  startedAt: new Date(startedAt),
  counts: { matters: 42 },
  warnings: [],
  ...meta,
  ...extra,
});

describe('migrationRunsRepository', () => {
  it('reads the runs and refuses writes', async () => {
    const fs = new InMemoryFirestore();
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u-tess', orgId: 'org-a', role: 'owner' });
    const reviewedAt = new Date('2026-10-08T01:00:00Z');
    fs.set('orgs/org-a/migrations/cutover', run('cutover', 'cutover', '2026-10-06T21:00:00Z', { reviewedAt }));
    const repo = TestBed.runInInjectionContext(() => migrationRunsRepository());
    expect(await repo.get('cutover')).toMatchObject({ id: 'cutover', mode: 'cutover', reviewedAt });
    await expect(repo.update('cutover', { status: 'failed' } as never)).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
    });
  });
});

describe('latestMigrationRuns', () => {
  it('finds the latest run, and the import (the latest that isn’t a delta)', () => {
    const rehearsal = { id: 'r', ...run('r', 'rehearsal', '2026-10-01T00:00:00Z') };
    const cutover = { id: 'c', ...run('c', 'cutover', '2026-10-06T00:00:00Z') };
    const delta = { id: 'd', ...run('d', 'delta', '2026-10-07T00:00:00Z') };
    expect(latestMigrationRuns([rehearsal, delta, cutover])).toEqual({ latest: delta, import: cutover });
    expect(latestMigrationRuns([])).toEqual({ latest: null, import: null });
  });
});

describe('migrationCallables', () => {
  it('calls migration-review, and migration-resolveReview with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return {} as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => REQUEST },
    );
    const api = migrationCallables(client);
    await api.review();
    await api.review({ code: 'title_missing', limit: 0 });
    await api.resolve({ code: 'client_from_title' });
    expect(calls).toEqual([
      { name: MIGRATION_CALLABLES.review, data: {} },
      { name: MIGRATION_CALLABLES.review, data: { code: 'title_missing', limit: 0 } },
      { name: MIGRATION_CALLABLES.resolve, data: { code: 'client_from_title', requestId: REQUEST } },
    ]);
  });
});
