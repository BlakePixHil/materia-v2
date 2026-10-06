import {
  FIXTURE_ORG,
  FIXTURE_PATHS,
  FIXTURE_READ_TIME,
  FIXTURE_UID,
  fixtureRun,
  type FixtureOptions,
} from './fixture.ts';
import { FILE_MISSING, FILE_NOT_COPIED, readRun } from './run-files.ts';
import { sha256 } from '../export/jsonl.ts';
import { memorySink } from '../export/sink.ts';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const read = (options: FixtureOptions = {}, skipUnfinishedFiles = false, files = fixtureRun(options)) =>
  readRun(memorySink('run-fixture', files), 'run-fixture', { now: NOW, skipUnfinishedFiles });

describe('readRun', () => {
  it('reads every transform file in load order, decoded, checked and stamped with the load time', async () => {
    const run = await read();
    expect(run.orgId).toBe(FIXTURE_ORG);
    expect(run.memberUids).toEqual([FIXTURE_UID]);
    expect(run.orgLine?.path).toBe(FIXTURE_PATHS.org);
    expect(run.phases.map((item) => [item.phase.file, item.lines.length])).toEqual([
      ['orgs', 1],
      ['users', 1],
      ['members', 1],
      ['counters', 1],
      ['matter-numbers', 1],
      ['contacts', 1],
      ['checklist-templates', 1],
      ['matters', 1],
      ['parties', 1],
      ['tasks', 1],
      ['notes', 1],
      ['activity', 0],
      ['documents', 1],
      ['personal-tasks', 1],
    ]);
    const matter = run.phases.find((item) => item.phase.file === 'matters')?.lines[0];
    expect(matter?.data['migration']).toEqual({ runId: 'run-fixture', legacyPath: expect.any(String), loadedAt: NOW });
    expect(matter?.data['createdAt']).toEqual(new Date('2024-03-04T05:06:07.000Z'));
    // The org's MFA grace starts at the load, not the export.
    const security = run.orgLine?.data['security'] as Record<string, Date>;
    expect(security['mfaRequiredSince']).toEqual(NOW);
    expect(security['mfaEnforceAfter']?.getTime()).toBeGreaterThan(NOW.getTime());
    expect(FIXTURE_READ_TIME.getTime()).toBeLessThan(NOW.getTime());
    // Documents come from the copy, with its outcome and the legacy object's MD5.
    const document = run.phases.find((item) => item.phase.file === 'documents')?.lines[0];
    expect(document).toMatchObject({ outcome: 'copied', copy: { md5Hash: expect.any(String) } });
    expect(document?.data).toMatchObject({ version: 1, scan: { status: 'clean' } });
    expect(run.documentsWithoutFile).toBe(0);
  });

  it('loads a document whose legacy file is gone for review, and stops on unfinished copies unless told', async () => {
    const missing = await read({ outcome: 'missing' });
    const document = missing.phases.find((item) => item.phase.file === 'documents')?.lines[0];
    expect(document?.data).toMatchObject({ scan: { status: 'error' }, needsReview: [FILE_MISSING], version: 0 });
    expect(missing.documentsWithoutFile).toBe(1);
    await expect(read({ outcome: 'unscanned' })).rejects.toThrow(/copy is unscanned.*--skip-unfinished-files/);
    await expect(read({ outcome: 'failed' })).rejects.toThrow(/copy is failed/);
    const skipped = await read({ outcome: 'failed' }, true);
    expect(skipped.phases.find((item) => item.phase.file === 'documents')?.lines[0]?.data['needsReview']).toEqual([
      FILE_NOT_COPIED,
    ]);
  });

  it('refuses a run the transform did not finish, or files it does not list', async () => {
    const noReport = fixtureRun();
    noReport.delete('report.json');
    await expect(read({}, false, noReport)).rejects.toThrow(/has no report.json/);

    const rejected = fixtureRun();
    rejected.set('report.json', JSON.stringify({ files: {}, rejects: [{ code: 'MIG_R_X' }] }));
    await expect(read({}, false, rejected)).rejects.toThrow(/lists no files/);

    const changed = fixtureRun();
    changed.set(
      'transformed/notes.jsonl',
      `${changed.get('transformed/notes.jsonl')}`.replace('executor', 'executrix'),
    );
    await expect(read({}, false, changed)).rejects.toThrow(/notes.jsonl isn't the file the transform's report lists/);

    const stale = fixtureRun();
    const report = JSON.parse(stale.get('report.json') ?? '') as { files: Record<string, unknown> };
    delete report.files['transformed/notes.jsonl'];
    stale.set('report.json', JSON.stringify(report));
    await expect(read({}, false, stale)).rejects.toThrow(/left from an earlier transform/);

    const gone = fixtureRun();
    gone.delete('transformed/notes.jsonl');
    await expect(read({}, false, gone)).rejects.toThrow(/lists transformed\/notes.jsonl, which isn't in the run/);

    const unknown = fixtureRun();
    const more = JSON.parse(unknown.get('report.json') ?? '') as { files: Record<string, unknown> };
    more.files['transformed/deadlines.jsonl'] = { count: 0, sha256: sha256('') };
    unknown.set('report.json', JSON.stringify(more));
    await expect(read({}, false, unknown)).rejects.toThrow(/deadlines.jsonl, which this load doesn't know/);

    // A run's folder holding another run's lines: its rollback would never find them.
    await expect(read({}, false, fixtureRun({ runId: 'run-other' }))).rejects.toThrow(
      /line 1 carries run run-other: transform it again as run-fixture/,
    );
  });

  it('refuses documents copied from another transform, or not copied at all', async () => {
    const notCopied = fixtureRun();
    notCopied.delete('files/documents.jsonl');
    await expect(read({}, false, notCopied)).rejects.toThrow(/run copy-files first/);
    const other = await fixtureRun({
      edit: (file, lines) =>
        file === 'files/documents.jsonl' ? lines.map((item) => ({ ...item, path: `${item.path}x` })) : lines,
    });
    await expect(read({}, false, other)).rejects.toThrow(/copied from an earlier transform/);
    const noResult = fixtureRun({
      edit: (file, lines) =>
        file === 'files/documents.jsonl'
          ? lines.map((item) => ({ path: item.path, legacyPath: item.legacyPath, data: item.data }))
          : lines,
    });
    await expect(read({}, false, noResult)).rejects.toThrow(/no copy result/);
  });

  it('checks each line: JSON, shape, path, order, org, instants and schema', async () => {
    const bad = (edit: NonNullable<FixtureOptions['edit']>) => read({ edit });
    const notes = (change: (line: Record<string, unknown>) => unknown) =>
      bad((file, lines) => (file === 'notes' ? (lines.map((item) => change(item as never)) as never) : lines));
    await expect(notes((item) => ({ ...item, legacyPath: '' }))).rejects.toThrow(/notes.jsonl line 1: legacyPath/);
    await expect(notes((item) => ({ ...item, path: 'orgs/x/notes/n' }))).rejects.toThrow(/is not a notes path/);
    await expect(
      notes((item) => ({ ...item, path: (item['path'] as string).replace(FIXTURE_ORG, 'org-other') })),
    ).rejects.toThrow(/in another org/);
    await expect(notes((item) => ({ ...item, data: { ...(item['data'] as object), bodyMd: 42 } }))).rejects.toThrow(
      /notes.jsonl line 1: bodyMd/,
    );
    await expect(
      notes((item) => ({ ...item, data: { ...(item['data'] as object), createdAt: { $bytes: 'x' } } })),
    ).rejects.toThrow(/notes.jsonl line 1/);
    await expect(bad((file, lines) => (file === 'notes' ? [...lines, ...lines] : lines))).rejects.toThrow(
      /sorted by path, without repeats/,
    );
    await expect(
      bad((file, lines) =>
        file === 'orgs' ? [...lines, ...lines.map((item) => ({ ...item, path: 'orgs/org-mig-rivers2' }))] : lines,
      ),
    ).rejects.toThrow(/more than one org|in another org/);

    const notJson = fixtureRun();
    notJson.set('transformed/notes.jsonl', '{nope\n');
    const report = JSON.parse(notJson.get('report.json') ?? '') as { files: Record<string, { sha256: string }> };
    report.files['transformed/notes.jsonl'] = { sha256: sha256('{nope\n') } as never;
    notJson.set('report.json', JSON.stringify(report));
    await expect(read({}, false, notJson)).rejects.toThrow(/notes.jsonl line 1 is not JSON/);
  });

  it('refuses a run that loads into no org', async () => {
    const files = fixtureRun({ edit: (file, lines) => (file === 'users' ? lines : []) });
    await expect(read({}, false, files)).rejects.toThrow(/loads nothing into an org/);
  });
});
