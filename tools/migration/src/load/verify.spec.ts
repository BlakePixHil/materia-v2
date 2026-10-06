import { createHash } from 'node:crypto';

import { FIXTURE_FILE, FIXTURE_ORG, FIXTURE_PATHS, FIXTURE_UID, fixtureRun, type FixtureOptions } from './fixture.ts';
import { runLoad } from './load.ts';
import { memoryAuth, memoryDb } from './testing.ts';
import { runVerify, type VerifyDeps, type VerifyReport } from './verify.ts';
import { memorySink } from '../export/sink.ts';
import { memoryStore } from '../files/testing.ts';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const P = FIXTURE_PATHS;
const FILES = 'materia-v2-dev-files';

async function loaded(options: FixtureOptions = {}) {
  const sink = memorySink('run-fixture', fixtureRun(options));
  const target = memoryDb();
  const { auth, claims } = memoryAuth({ [FIXTURE_UID]: {} });
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
  if (options.outcome === undefined || options.outcome === 'copied') {
    files.put(FILES, `${P.document}/v1`, FIXTURE_FILE, {
      metadata: { sha256: createHash('sha256').update(FIXTURE_FILE).digest('hex'), migrationRunId: 'run-fixture' },
    });
  }
  const logs: string[] = [];
  const verify = (readAs?: VerifyDeps['readAs']) =>
    runVerify(
      { runId: 'run-fixture', env: 'dev' },
      {
        sink,
        db: target.db,
        auth,
        files: { store: files.store, bucket: FILES },
        ...(readAs ? { readAs } : {}),
        now: () => new Date(NOW.getTime() + 60_000),
        log: (line) => void logs.push(line),
      },
    );
  return { sink, target, claims, files, logs, verify };
}

describe('runVerify', () => {
  it('passes a clean load: every record matches, the file is intact, the person can read it all', async () => {
    const s = await loaded();
    const reads: string[][] = [];
    const report = await s.verify(async (uid, claims, paths) => {
      expect(uid).toBe(FIXTURE_UID);
      expect(claims).toMatchObject({ orgId: FIXTURE_ORG, role: 'owner' });
      reads.push([...paths]);
      return [];
    });
    expect(report.passed).toBe(true);
    expect(report.entities['matters']).toEqual({
      loaded: 1,
      matching: 1,
      differing: 0,
      missing: 0,
      editedInV2: 0,
      laterRun: 0,
      notMigrated: 0,
    });
    expect(Object.values(report.entities).every((check) => check.matching === check.loaded)).toBe(true);
    expect(report.files).toEqual({ checked: 1, problems: [] });
    expect(report.access).toEqual([{ uid: FIXTURE_UID, claims: 'ok', reads: expect.stringMatching(/^all \d+ read$/) }]);
    expect(reads[0]).toContain(P.matter);
    expect(report.legacy).toEqual({ manifestCounts: { cards: 1, attachments: 1 }, rejects: 0 });
    const markdown = s.sink.files.get('verify/verify-report.md') ?? '';
    expect(markdown).toContain('**Passed**');
    expect(markdown).toContain('| matters | 1 | 1 | 0 | 0 | 0 | 0 | 0 |');
    expect((JSON.parse(s.sink.files.get('verify/report.json') ?? '') as VerifyReport).passed).toBe(true);
    expect(s.logs.at(-1)).toMatch(/^Verified: 0 missing, 0 different/);
  });

  it('without the emulator it checks the claims, not reads', async () => {
    const report = await (await loaded()).verify();
    expect(report.passed).toBe(true);
    expect(report.access[0]?.reads).toMatch(/not checked here/);
  });

  it('fails on a missing or different record, a broken file, wrong claims, refused reads or anything privileged', async () => {
    const s = await loaded();
    s.target.docs.delete(P.note);
    s.target.docs.set(P.task, { ...s.target.get(P.task), title: 'Changed behind the load' });
    s.target.docs.set(P.matter, { ...s.target.get(P.matter), privileged: true });
    s.files.put(FILES, `${P.document}/v1`, Buffer.from('other bytes'), { metadata: { sha256: 'x' } });
    s.claims.set(FIXTURE_UID, { orgId: 'org-other', role: 'owner', orgs: { 'org-other': 'owner' } });
    const report = await s.verify(async (_uid, _claims, paths) => paths.slice(0, 1));
    expect(report.passed).toBe(false);
    expect(report.missing).toEqual([P.note]);
    expect(report.differing).toEqual(
      expect.arrayContaining([
        { path: P.task, fields: ['title'] },
        { path: P.matter, fields: ['privileged'] },
      ]),
    );
    expect(report.privileged).toEqual([P.matter]);
    expect(report.files.problems).toEqual([{ path: P.document, problem: 'size differs' }]);
    expect(report.access[0]).toMatchObject({ claims: "the claims don't give the org's role" });
    expect(report.access[0]?.reads).toMatch(/^refused 1 of/);
    const markdown = s.sink.files.get('verify/verify-report.md') ?? '';
    expect(markdown).toContain('**Failed**');
    expect(markdown).toContain(`- \`${P.note}\``);
    expect(markdown).toContain(`\`${P.task}\`: title`);
    expect(markdown).toContain('## Privileged (none expected)');
    expect(s.logs.at(-1)).toMatch(/^NOT verified: 1 missing/);
  });

  it('reports each kind of file problem', async () => {
    const s = await loaded();
    const sha = createHash('sha256').update(FIXTURE_FILE).digest('hex');
    const check = async () => (await s.verify()).files.problems[0]?.problem;
    s.files.put(FILES, `${P.document}/v1`, FIXTURE_FILE, { metadata: { sha256: 'f'.repeat(64) } });
    expect(await check()).toBe('sha256 differs');
    // Same size and sha256 recorded, other bytes: the legacy MD5 catches it.
    s.files.put(FILES, `${P.document}/v1`, Buffer.alloc(FIXTURE_FILE.length, 1), { metadata: { sha256: sha } });
    expect(await check()).toBe('MD5 differs from the legacy file');
    await s.files.store.remove(FILES, `${P.document}/v1`);
    expect(await check()).toBe('file missing');
    s.target.docs.set(P.document, { ...s.target.get(P.document), storagePath: undefined });
    expect(await check()).toBe('no storagePath');
  });

  it('counts records changed in v2 since, reloaded by a later run, or made in v2, and still passes', async () => {
    const s = await loaded();
    const later = new Date(NOW.getTime() + 3_600_000);
    s.target.docs.set(P.note, {
      ...s.target.get(P.note),
      bodyMd: 'Edited in v2',
      updatedAt: later,
      updatedBy: FIXTURE_UID,
    });
    const task = s.target.get(P.task) ?? {};
    // A delta changed the task since; the matter it found unchanged keeps this run.
    s.target.docs.set(P.task, {
      ...task,
      title: 'Apply for the grant (changed in legacy)',
      migration: { ...(task['migration'] as object), runId: 'run-delta-1' },
    });
    const matter = s.target.get(P.matter) ?? {};
    s.target.docs.set(P.matter, { ...matter, migration: { ...(matter['migration'] as object), runId: 'run-delta-1' } });
    const party = { ...(s.target.get(P.party) ?? {}) };
    delete party['migration'];
    s.target.docs.set(P.party, party);
    const report = await s.verify();
    expect(report.passed).toBe(true);
    expect(report.entities['notes']).toMatchObject({ editedInV2: 1, matching: 0 });
    expect(report.entities['tasks']).toMatchObject({ laterRun: 1 });
    expect(report.entities['matters']).toMatchObject({ matching: 1 });
    expect(report.entities['parties']).toMatchObject({ notMigrated: 1 });
  });

  it('checks the counter is at least the run’s and the numbers point at the run’s matters', async () => {
    const s = await loaded();
    s.target.docs.set(P.counter, { ...s.target.get(P.counter), next: 1 });
    s.target.docs.set(P.matterNumber, { ...s.target.get(P.matterNumber), matterId: 'm-other' });
    const report = await s.verify();
    expect(report.differing).toEqual([
      { path: P.counter, fields: ['next'] },
      { path: P.matterNumber, fields: ['matterId'] },
    ]);
  });

  it('a person without an account or membership fails the access check', async () => {
    const s = await loaded();
    s.target.docs.set(P.member, { ...s.target.get(P.member), status: 'suspended' });
    expect((await s.verify()).access[0]?.claims).toBe('not an active member');
    s.claims.delete(FIXTURE_UID);
    expect((await s.verify()).access[0]?.claims).toBe('no account');
  });

  it('skips the file check for documents loaded without their file', async () => {
    const report = await (await loaded({ outcome: 'missing' })).verify();
    expect(report.files).toEqual({ checked: 0, problems: [] });
    expect(report.passed).toBe(true);
  });
});
