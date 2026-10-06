import { domain } from '../domain.ts';
import { FIXTURE_ORG, FIXTURE_PATHS, FIXTURE_UID, fixtureRun, type FixtureOptions } from './fixture.ts';
import { LoadRefusedError, runLoad, type LoadArgs, type LoadReport } from './load.ts';
import { memoryAuth, memoryDb } from './testing.ts';
import type { Data } from './values.ts';
import { memorySink } from '../export/sink.ts';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const P = FIXTURE_PATHS;
const ORG_NAME = 'Rivers Estate Law (Fictional)';
const templates = 'migration' in domain.ChecklistTemplate.schema.shape;

function setup(
  options: FixtureOptions = {},
  initial: Record<string, Data> = {},
  accounts: Record<string, Record<string, unknown>> = { [FIXTURE_UID]: {} },
) {
  const sink = memorySink('run-fixture', fixtureRun(options));
  const target = memoryDb(initial);
  const { auth, claims } = memoryAuth(accounts);
  const logs: string[] = [];
  let clock = NOW.getTime();
  const answers: string[] = [];
  const deps = {
    sink,
    db: target.db,
    auth,
    now: () => new Date(clock),
    log: (line: string) => void logs.push(line),
    ask: async () => answers.shift() ?? '',
  };
  const args = (overrides: Partial<LoadArgs> = {}): LoadArgs => ({
    runId: 'run-fixture',
    env: 'dev',
    mode: 'rehearsal',
    dryRun: false,
    confirmProd: false,
    skipUnfinishedFiles: false,
    toolVersion: 'test',
    operator: 'operator@example.com',
    ...overrides,
  });
  const load = (overrides: Partial<LoadArgs> = {}, run = sink) => runLoad(args(overrides), { ...deps, sink: run });
  return {
    sink,
    target,
    claims,
    logs,
    answers,
    load,
    tick: (ms: number) => void (clock += ms),
    /** The same run transformed again (a new sink), with lines changed. */
    retransform: (edit: NonNullable<FixtureOptions['edit']>) =>
      memorySink('run-fixture', fixtureRun({ ...options, edit })),
  };
}

const total = (report: LoadReport, decision: keyof LoadReport['counts'][string]) =>
  Object.values(report.counts).reduce((sum, count) => sum + count[decision], 0);
const dataPaths = (s: ReturnType<typeof setup>) =>
  s.target.writes
    .filter((op) => !op.path.includes('/migrations/') && !op.path.includes('/audit/'))
    .map((op) => op.path);

describe('runLoad', () => {
  it('a dry run plans every write and writes nothing', async () => {
    const s = setup();
    const report = await s.load({ dryRun: true });
    expect(s.target.writes).toEqual([]);
    expect(s.sink.files.has('load/report.json')).toBe(false);
    expect(report).toMatchObject({ dryRun: true, complete: false, conflicts: [] });
    expect(report.counts['matters']).toMatchObject({ lines: 1, create: 1 });
    expect(total(report, 'create')).toBe(templates ? 13 : 12);
    expect(s.logs.join('\n')).toMatch(/matters\s+1 lines: 1 create/);
    expect(s.logs.at(-1)).toBe('Dry run: nothing written.');
  });

  it('writes every record in dependency order, then the run record, claims, one audit entry and the report', async () => {
    const s = setup();
    const report = await s.load();
    expect(report.complete).toBe(true);
    const order = dataPaths(s);
    for (const [earlier, later] of [
      [P.org, P.user],
      [P.user, P.member],
      [P.member, P.counter],
      [P.matterNumber, P.contact],
      [P.contact, P.matter],
      [P.matter, P.party],
      [P.party, P.task],
      [P.note, P.document],
      [P.document, P.personalTask],
    ] as const) {
      expect(order.indexOf(earlier), `${earlier} before ${later}`).toBeLessThan(order.indexOf(later));
    }
    for (const path of Object.values(P)) {
      if (path === P.template && !templates) continue;
      expect(s.target.get(path), path).toBeDefined();
    }
    expect(s.target.get(P.matter)?.['migration']).toEqual({
      runId: 'run-fixture',
      legacyPath: 'workflows/wf-rivers/cards/card-quill',
      loadedAt: NOW,
    });
    expect(s.target.get(`orgs/${FIXTURE_ORG}/migrations/run-fixture`)).toMatchObject({
      runId: 'run-fixture',
      mode: 'rehearsal',
      status: 'succeeded',
      counts: { matters: 1, documents: 1 },
      operator: 'operator@example.com',
      toolVersion: 'test',
    });
    const audit = s.target.paths(`orgs/${FIXTURE_ORG}/audit/`);
    expect(audit).toEqual([`orgs/${FIXTURE_ORG}/audit/migration-run-fixture-loaded`]);
    expect(s.target.get(audit[0] ?? '')).toMatchObject({
      action: 'migration.loaded',
      source: 'migration',
      actor: 'system',
    });
    // The person can sign in to the org: claims and the users mirror.
    expect(s.claims.get(FIXTURE_UID)).toMatchObject({
      orgId: FIXTURE_ORG,
      role: 'owner',
      orgs: { [FIXTURE_ORG]: 'owner' },
    });
    expect(s.target.get(P.user)).toMatchObject({ orgIds: [FIXTURE_ORG], activeOrgId: FIXTURE_ORG, claimsVersion: 1 });
    const saved = JSON.parse(s.sink.files.get('load/report.json') ?? '') as LoadReport;
    expect(saved).toMatchObject({ runId: 'run-fixture', complete: true, conflicts: [] });
    expect(s.logs.at(-1)).toMatch(/^Loaded: \d+ documents written, 0 left alone/);
  });

  it('is idempotent: a second run writes no record again', async () => {
    const s = setup();
    await s.load();
    s.tick(60_000);
    const writesBefore = s.target.writes.length;
    const again = await s.load();
    expect(total(again, 'create') + total(again, 'update')).toBe(0);
    expect(total(again, 'unchanged') + total(again, 'keep')).toBe(templates ? 13 : 12);
    expect(again.conflicts).toEqual([]);
    // Only the run record, the claims mirror and the audit entry.
    const paths = s.target.writes.slice(writesBefore).map((op) => op.path);
    expect(new Set(paths)).toEqual(
      new Set([
        `orgs/${FIXTURE_ORG}/migrations/run-fixture`,
        P.user,
        `orgs/${FIXTURE_ORG}/audit/migration-run-fixture-loaded`,
      ]),
    );
  });

  it('leaves a record changed in v2 since the load alone (MIG_C_USER_EDITED), and updates the rest', async () => {
    const s = setup();
    await s.load();
    // The lawyer edits the note; a trigger counts the matter's task (as the system).
    const later = new Date(NOW.getTime() + 3_600_000);
    s.target.docs.set(P.note, {
      ...s.target.get(P.note),
      bodyMd: 'Edited in v2.',
      updatedAt: later,
      updatedBy: FIXTURE_UID,
    });
    s.target.docs.set(P.matter, { ...s.target.get(P.matter), openTaskCount: 1, updatedAt: later, updatedBy: 'system' });
    // Legacy changed both since (a delta).
    const changed = s.retransform((file, lines) =>
      lines.map((item) =>
        file === 'notes' || file === 'matters'
          ? {
              ...item,
              data: {
                ...item.data,
                ...(file === 'notes' ? { bodyMd: 'Edited in legacy.' } : { title: 'Estate of Q. Quill (fictional)' }),
              },
            }
          : item,
      ),
    );
    s.tick(7_200_000);
    const report = await s.load({}, changed);
    expect(report.conflicts).toEqual([
      { code: 'MIG_C_USER_EDITED', path: P.note, legacyPath: 'workflows/wf-rivers/cards/card-quill#comment/cm-1' },
    ]);
    expect(s.target.get(P.note)?.['bodyMd']).toBe('Edited in v2.');
    expect(report.counts['matters']).toMatchObject({ update: 1 });
    // The legacy change lands; what v2 maintains (the count, the trigger's stamp) stays.
    expect(s.target.get(P.matter)).toMatchObject({
      title: 'Estate of Q. Quill (fictional)',
      openTaskCount: 1,
      updatedBy: 'system',
    });
    expect((s.target.get(`orgs/${FIXTURE_ORG}/migrations/run-fixture`)?.['warnings'] as Data[])[0]).toMatchObject({
      code: 'MIG_C_USER_EDITED',
      path: P.note,
    });
  });

  it("leaves alone what v2 made itself at a migration path (the person's own account), and still joins them to the org", async () => {
    const own = { email: 'alex.rivers@example.com', orgIds: ['org-own'], activeOrgId: 'org-own' };
    const s = setup(
      {},
      {
        [P.user]: {
          ...own,
          memberships: { 'org-own': { role: 'owner', name: 'Own Practice (Fictional)' } },
          claimsVersion: 3,
        },
        'orgs/org-own': { name: 'Own Practice (Fictional)' },
        'orgs/org-own/members/uid-alex-rivers': { role: 'owner', status: 'active' },
      },
    );
    const report = await s.load();
    expect(report.conflicts).toEqual([
      { code: 'MIG_C_NOT_MIGRATED', path: P.user, legacyPath: `profiles/${FIXTURE_UID}` },
    ]);
    expect(s.target.get(P.user)).toMatchObject({
      email: 'alex.rivers@example.com',
      orgIds: [FIXTURE_ORG, 'org-own'],
      activeOrgId: 'org-own',
      claimsVersion: 4,
    });
    expect(s.target.get(P.user)).not.toHaveProperty('migration');
  });

  it('raises a matter counter to the run’s, keeps a higher one, and refuses numbers another matter holds', async () => {
    const low = setup(
      {},
      { [P.counter]: { next: 1, createdAt: NOW, createdBy: 'system', updatedAt: NOW, updatedBy: 'system' } },
    );
    expect((await low.load()).counts['counters']).toMatchObject({ raise: 1 });
    expect(low.target.get(P.counter)?.['next']).toBe(2);
    const high = setup({}, { [P.counter]: { next: 9 } });
    expect((await high.load()).counts['counters']).toMatchObject({ keep: 1 });
    expect(high.target.get(P.counter)?.['next']).toBe(9);

    const taken = setup({}, { [P.matterNumber]: { number: 'M-2024-0001', matterId: 'm-made-in-v2', year: 2024 } });
    await expect(taken.load()).rejects.toThrow(/1 matter numbers are already held by other matters/);
    expect(taken.target.writes).toEqual([]);
  });

  it('prod needs --confirm-prod and the org’s name typed back', async () => {
    const s = setup();
    await expect(s.load({ env: 'prod' })).rejects.toThrow('Writing to prod needs --confirm-prod.');
    s.answers.push('Rivers');
    await expect(s.load({ env: 'prod', confirmProd: true })).rejects.toThrow(/not the org name/);
    expect(s.target.writes).toEqual([]);
    s.answers.push(` ${ORG_NAME} `);
    expect((await s.load({ env: 'prod', confirmProd: true, mode: 'cutover' })).complete).toBe(true);
    // A dry run in prod asks nothing.
    expect((await s.load({ env: 'prod', dryRun: true })).dryRun).toBe(true);
  });

  it('refuses before writing when the person has no v2 account, or the org neither exists nor is created', async () => {
    const noAccount = setup({}, {}, {});
    await expect(noAccount.load()).rejects.toThrow(/no v2 account uid-alex-rivers: run auth-import/);
    const noOrg = setup({ withoutOrg: true });
    await expect(noOrg.load()).rejects.toBeInstanceOf(LoadRefusedError);
    await expect(noOrg.load()).rejects.toThrow(/doesn't exist in dev, and the run doesn't create it/);
    expect(noOrg.target.writes).toEqual([]);
    const broken = setup();
    broken.sink.files.delete('report.json');
    await expect(broken.load()).rejects.toBeInstanceOf(LoadRefusedError);
  });

  it('loads into an org that already exists', async () => {
    const s = setup({ withoutOrg: true }, { [P.org]: { name: 'Rivers Estate Law (Fictional)', retentionYears: 10 } });
    const report = await s.load();
    expect(report.complete).toBe(true);
    expect(s.target.get(P.org)).not.toHaveProperty('migration');
    expect(s.target.get(P.matter)).toBeDefined();
  });

  it('stops at a phase that fails, records the run failed and leaves the claims alone', async () => {
    const s = setup();
    s.target.failOn.add(P.matter);
    const report = await s.load();
    expect(report.complete).toBe(false);
    expect(report.failures).toEqual([{ path: P.matter, message: 'made-up failure' }]);
    expect(s.target.get(P.task)).toBeUndefined();
    expect(s.target.get(`orgs/${FIXTURE_ORG}/migrations/run-fixture`)).toMatchObject({ status: 'failed' });
    expect(s.claims.get(FIXTURE_UID)).toEqual({});
    expect(s.logs.join('\n')).toMatch(/matters: 1 writes failed; later phases not written/);
    // Running it again finishes the job.
    s.target.failOn.clear();
    expect((await s.load()).complete).toBe(true);
    expect(s.target.get(P.task)).toBeDefined();
  });

  it('loads a document whose legacy file is gone, for review', async () => {
    const s = setup({ outcome: 'missing' });
    const report = await s.load();
    expect(report.documentsWithoutFile).toBe(1);
    expect(s.target.get(P.document)).toMatchObject({ needsReview: ['MIG_W_ATTACHMENT_OBJECT_MISSING'] });
  });
});
