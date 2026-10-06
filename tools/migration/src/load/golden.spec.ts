import { GOLDEN_ORG, GOLDEN_RUN, GOLDEN_UID, goldenRun } from './golden.ts';
import { runLoad, type LoadArgs } from './load.ts';
import { runRollback } from './rollback.ts';
import { memoryAuth, memoryDb } from './testing.ts';
import { runVerify } from './verify.ts';
import { memorySink } from '../export/sink.ts';
import { memoryStore } from '../files/testing.ts';

const NOW = new Date('2026-10-07T09:00:00.000Z');
const FILES = 'materia-v2-dev-files';

/** MIG-03's real transform output through the load, verify and rollback, in memory. */
function world() {
  const { files, objects } = goldenRun();
  const sink = memorySink(GOLDEN_RUN, files);
  const target = memoryDb();
  const { auth, claims } = memoryAuth({ [GOLDEN_UID]: {} });
  const store = memoryStore();
  for (const object of objects) {
    store.put(FILES, object.name, object.bytes, { contentType: object.contentType, metadata: object.metadata });
  }
  const args: LoadArgs = {
    runId: GOLDEN_RUN,
    env: 'dev',
    mode: 'rehearsal',
    dryRun: false,
    confirmProd: false,
    skipUnfinishedFiles: false,
    toolVersion: 'test',
    operator: 'operator@example.com',
  };
  const base = { sink, db: target.db, auth, now: () => NOW, log: () => undefined, ask: async () => '' };
  const filesBucket = { store: store.store, bucket: FILES };
  return {
    target,
    claims,
    store,
    objects,
    load: () => runLoad(args, base),
    verify: () => runVerify({ runId: GOLDEN_RUN, env: 'dev' }, { ...base, files: filesBucket }),
    rollback: () =>
      runRollback(
        {
          runId: GOLDEN_RUN,
          env: 'dev',
          dryRun: false,
          confirmProd: false,
          keepOrg: false,
          operator: 'o',
          toolVersion: 't',
        },
        { ...base, files: filesBucket },
      ),
  };
}

describe('the golden transform output', () => {
  it('loads every file, verifies, re-loads unchanged and rolls back to empty', async () => {
    const w = world();
    const report = await w.load();
    expect(report).toMatchObject({ orgId: GOLDEN_ORG, complete: true, failures: [], conflicts: [] });
    expect(report.documentsWithoutFile).toBe(1);
    for (const [file, counts] of Object.entries(report.counts)) {
      expect(counts.failed, file).toBe(0);
      expect(counts.lines, file).toBeGreaterThan(0);
    }
    expect(w.claims.get(GOLDEN_UID)).toMatchObject({ orgId: GOLDEN_ORG, role: 'owner' });

    const verified = await w.verify();
    expect(verified.files.problems).toEqual([]);
    expect(verified.passed).toBe(true);

    const again = await w.load();
    for (const [file, counts] of Object.entries(again.counts)) {
      expect(counts.create + counts.update, file).toBe(0);
    }

    const rolledBack = await w.rollback();
    expect(rolledBack).toMatchObject({ complete: true, orgDeleted: true, filesDeleted: w.objects.length });
    expect(w.target.paths()).toEqual([]);
    expect(w.store.names(FILES)).toEqual([]);
  });
});
