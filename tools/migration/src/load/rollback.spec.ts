import { FIXTURE_FILE, FIXTURE_ORG, FIXTURE_PATHS, FIXTURE_UID, fixtureRun, type FixtureOptions } from './fixture.ts';
import { runLoad } from './load.ts';
import { classify, RollbackRefusedError, runRollback, type RollbackArgs } from './rollback.ts';
import { memoryAuth, memoryDb } from './testing.ts';
import type { Data } from './values.ts';
import { memorySink } from '../export/sink.ts';
import { memoryStore } from '../files/testing.ts';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const P = FIXTURE_PATHS;
const FILES = 'materia-v2-dev-files';
const RUN_PATH = `orgs/${FIXTURE_ORG}/migrations/run-fixture`;

async function loaded(options: FixtureOptions = {}, initial: Record<string, Data> = {}) {
  const sink = memorySink('run-fixture', fixtureRun(options));
  const target = memoryDb(initial);
  const { auth, claims } = memoryAuth({ [FIXTURE_UID]: { admin: false } });
  const files = memoryStore();
  await runLoad(
    {
      runId: 'run-fixture',
      env: 'dev',
      mode: 'rehearsal',
      dryRun: false,
      confirmProd: false,
      skipUnfinishedFiles: false,
      toolVersion: 'test',
      operator: 'operator@example.com',
    },
    { sink, db: target.db, auth, now: () => NOW, log: () => undefined, ask: async () => '' },
  );
  const ours = { migrationRunId: 'run-fixture' };
  files.put(FILES, `${P.document}/v1`, FIXTURE_FILE, { metadata: ours });
  files.put(FILES, `migration-quarantine/run-fixture/${P.document}/v1`, FIXTURE_FILE, { metadata: ours });
  files.put(FILES, `users/${FIXTURE_UID}/avatar.png`, Buffer.from('png'), { metadata: ours });
  // Someone else's file in the org, and one from another run.
  files.put(FILES, `orgs/${FIXTURE_ORG}/matters/m-other/documents/d-1/v1`, Buffer.from('x'), {});
  files.put(FILES, `orgs/${FIXTURE_ORG}/matters/m-other/documents/d-2/v1`, Buffer.from('y'), {
    metadata: { migrationRunId: 'run-other' },
  });
  const logs: string[] = [];
  const answers: string[] = [];
  const rollback = (overrides: Partial<RollbackArgs> = {}) =>
    runRollback(
      {
        runId: 'run-fixture',
        env: 'dev',
        dryRun: false,
        confirmProd: false,
        keepOrg: false,
        operator: 'operator@example.com',
        toolVersion: 'test',
        ...overrides,
      },
      {
        sink,
        db: target.db,
        auth,
        files: { store: files.store, bucket: FILES },
        now: () => new Date(NOW.getTime() + 60_000),
        log: (line) => void logs.push(line),
        ask: async () => answers.shift() ?? '',
      },
    );
  return { sink, target, claims, files, logs, answers, rollback };
}

describe('runRollback', () => {
  it('a dry run counts what would go and deletes nothing', async () => {
    const s = await loaded();
    const before = s.target.paths();
    const report = await s.rollback({ dryRun: true });
    expect(report).toMatchObject({ dryRun: true, orgDeleted: true, filesDeleted: 3, blocked: [], complete: false });
    expect(report.deleted).toMatchObject({ matters: 1, tasks: 2, members: 1, users: 1, audit: 1 });
    expect(s.target.paths()).toEqual(before);
    expect(s.files.names(FILES)).toHaveLength(5);
    expect(s.logs.at(-1)).toBe('Dry run: nothing deleted (3 files would go).');
  });

  it('removes everything a run that created the org loaded, the org with it, and its files', async () => {
    const s = await loaded();
    const report = await s.rollback();
    expect(report).toMatchObject({ orgDeleted: true, complete: true, failures: [], editedInV2: 0 });
    expect(s.target.paths()).toEqual([]);
    expect(s.files.names(FILES)).toEqual([
      `orgs/${FIXTURE_ORG}/matters/m-other/documents/d-1/v1`,
      `orgs/${FIXTURE_ORG}/matters/m-other/documents/d-2/v1`,
    ]);
    // The person keeps their account, without the org in their claims.
    expect(s.claims.get(FIXTURE_UID)).toEqual({ admin: false });
    expect(JSON.parse(s.sink.files.get('rollback/report.json') ?? '')).toMatchObject({
      complete: true,
      orgDeleted: true,
    });
    expect(s.logs.at(-1)).toMatch(/^Rolled back: \d+ documents and 3 files deleted, the org with them; 0 failed\./);
  });

  it('a second run sweeps what triggers still finishing left under the deleted org', async () => {
    const s = await loaded();
    await s.rollback();
    // A trigger that was still running counted the matter's deletion afterwards.
    s.target.docs.set(`orgs/${FIXTURE_ORG}/metrics/day-2026-10-06`, { matters: { open: -1 } });
    const again = await s.rollback();
    expect(again).toMatchObject({ orgDeleted: true, complete: true, blocked: [] });
    expect(s.target.paths()).toEqual([]);
  });

  it('deletes deepest first, the run record marked rolling back meanwhile', async () => {
    const s = await loaded();
    const statusDuring: unknown[] = [];
    const apply = s.target.db.apply;
    s.target.db.apply = async (ops) => {
      if (ops.some((op) => op.op === 'delete')) statusDuring.push(s.target.get(RUN_PATH)?.['status']);
      return apply(ops);
    };
    const writes = s.target.writes.length;
    await s.rollback();
    expect(statusDuring.slice(0, -1).every((status) => status === 'rolling_back')).toBe(true);
    const depths = s.target.writes
      .slice(writes)
      .filter((op) => op.op === 'delete' && op.path !== RUN_PATH)
      .map((op) => op.path.split('/').length);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
  });

  it('with --keep-org keeps the org and what v2 made, and records the rollback once', async () => {
    const s = await loaded();
    const report = await s.rollback({ keepOrg: true });
    expect(report.orgDeleted).toBe(false);
    expect(s.target.get(P.org)).toBeDefined();
    for (const path of [P.matter, P.task, P.note, P.document, P.contact, P.member, P.personalTask, P.matterNumber]) {
      expect(s.target.get(path), path).toBeUndefined();
    }
    expect(s.target.get(RUN_PATH)).toMatchObject({ status: 'rolled_back', operator: 'operator@example.com' });
    expect(s.target.get(`orgs/${FIXTURE_ORG}/audit/migration-run-fixture-rolled-back`)).toMatchObject({
      action: 'migration.rolled_back',
      source: 'migration',
    });
  });

  it('keeps the org it didn’t create', async () => {
    const s = await loaded(
      { withoutOrg: true },
      { [P.org]: { name: 'Rivers Estate Law (Fictional)', retentionYears: 7 } },
    );
    const report = await s.rollback();
    expect(report.orgDeleted).toBe(false);
    expect(s.target.get(P.org)).toEqual({ name: 'Rivers Estate Law (Fictional)', retentionYears: 7 });
    expect(s.target.get(P.matter)).toBeUndefined();
  });

  it('refuses, deleting nothing, while records it didn’t load sit under ones it did', async () => {
    const s = await loaded();
    const made = `${P.matter}/notes/n-made-in-v2`;
    s.target.docs.set(made, { bodyMd: 'Typed in v2 after the load.' });
    const before = s.target.paths();
    await expect(s.rollback()).rejects.toBeInstanceOf(RollbackRefusedError);
    await expect(s.rollback()).rejects.toThrow(/1 records under this run's weren't loaded by it.*n-made-in-v2/);
    expect(s.target.paths()).toEqual(before);
    const dry = await s.rollback({ dryRun: true });
    expect(dry.blocked).toEqual([made]);
  });

  it('counts documents changed in v2 since the load, and deletes them with the rest', async () => {
    const s = await loaded();
    const note = s.target.get(P.note) ?? {};
    s.target.docs.set(P.note, { ...note, updatedAt: new Date(NOW.getTime() + 1000), updatedBy: FIXTURE_UID });
    const report = await s.rollback();
    expect(report.editedInV2).toBe(1);
    expect(s.target.get(P.note)).toBeUndefined();
  });

  it('keeps the person’s users document when another org is theirs', async () => {
    const s = await loaded();
    const user = s.target.get(P.user) ?? {};
    s.target.docs.set(P.user, { ...user, orgIds: [FIXTURE_ORG, 'org-own'] });
    await s.rollback();
    expect(s.target.get(P.user)).toBeDefined();
  });

  it('prod needs --confirm-prod and the org’s name typed back', async () => {
    const s = await loaded();
    await expect(s.rollback({ env: 'prod' })).rejects.toThrow('Deleting from prod needs --confirm-prod.');
    s.answers.push('nope');
    await expect(s.rollback({ env: 'prod', confirmProd: true })).rejects.toThrow(/not the org name/);
    s.answers.push('Rivers Estate Law (Fictional)');
    expect((await s.rollback({ env: 'prod', confirmProd: true })).complete).toBe(true);
  });

  it('stops with the run still rolling back when deletes fail, and finishes when run again', async () => {
    const s = await loaded();
    s.target.failOn.add(P.task);
    const report = await s.rollback({ keepOrg: true });
    expect(report.complete).toBe(false);
    expect(report.failures).toEqual([{ path: P.task, message: 'made-up failure' }]);
    expect(s.target.get(RUN_PATH)).toMatchObject({ status: 'rolling_back' });
    expect(s.logs.at(-1)).toMatch(/^Stopped:/);
    s.target.failOn.clear();
    expect((await s.rollback({ keepOrg: true })).complete).toBe(true);
    expect(s.target.get(P.task)).toBeUndefined();
  });

  it('refuses a run it can’t read', async () => {
    const s = await loaded();
    s.sink.files.delete('report.json');
    await expect(s.rollback()).rejects.toBeInstanceOf(RollbackRefusedError);
  });
});

describe('classify', () => {
  it('tells the run’s records from v2’s own and from anything else', () => {
    const migration = { runId: 'run-1', legacyPath: 'workflows/w/cards/c', loadedAt: NOW };
    expect(classify({ path: P.note, data: { migration } }, 'run-1')).toBe('own');
    expect(classify({ path: P.note, data: { migration } }, 'run-2')).toBe('foreign');
    expect(classify({ path: P.note, data: {} }, 'run-1')).toBe('foreign');
    expect(classify({ path: `orgs/${FIXTURE_ORG}/audit/a-1`, data: {} }, 'run-1')).toBe('system');
    expect(classify({ path: `orgs/${FIXTURE_ORG}/unknown/x`, data: {} }, 'run-1')).toBe('foreign');
  });

  it('counts what Clerk and the notifications wrote after the load as v2’s own (MIG-09)', () => {
    const matter = P.note.split('/notes/')[0];
    expect(classify({ path: `${matter}/suggestions/s-1`, data: { kind: 'event' } }, 'run-1')).toBe('system');
    expect(classify({ path: `orgs/${FIXTURE_ORG}/notifications/n-1`, data: {} }, 'run-1')).toBe('system');
    expect(classify({ path: `orgs/${FIXTURE_ORG}/migrationEnrichments/run-1`, data: {} }, 'run-1')).toBe('system');
    // An event a person recorded from a suggestion is their work: it still stops the rollback.
    expect(classify({ path: `${matter}/events/e-1`, data: {} }, 'run-1')).toBe('foreign');
  });
});
