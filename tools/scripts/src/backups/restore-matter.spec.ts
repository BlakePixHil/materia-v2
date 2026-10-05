import { FakeDb } from './fake.ts';
import { checkReadTime, parseArgs, restoreMatter, type RestoreOptions } from './restore-matter.ts';

/** The single-matter restore (SEC-03) against in-memory databases. Everything is fictional. */

const M = 'orgs/o1/matters/m1';
const NOW = new Date('2026-10-06T00:00:00Z');

function backupAndLive() {
  const source = new FakeDb({
    'orgs/o1': { name: 'Fictional Firm', retentionYears: 10 },
    [M]: { number: 'W-2026-0001', title: 'Estate of A. Example' },
    [`${M}/tasks/t1`]: { title: 'Lodge probate' },
    [`${M}/tasks/t2`]: { title: 'Call executor' },
    [`${M}/documents/d1`]: { name: 'will.pdf' },
    [`${M}/documents/d1/chunks/0`]: { text: 'chunk' },
  });
  // Live: t1 edited, t2 and d1's chunk deleted by mistake, t3 added since.
  const target = new FakeDb({
    'orgs/o1': { name: 'Fictional Firm', retentionYears: 10 },
    [M]: { number: 'W-2026-0001', title: 'Estate of A. Example' },
    [`${M}/tasks/t1`]: { title: 'Lodge probate (edited)' },
    [`${M}/tasks/t3`]: { title: 'New task' },
    [`${M}/documents/d1`]: { name: 'will.pdf' },
  });
  return { source, target };
}

const lines: string[] = [];
const opts = (overrides: Partial<RestoreOptions> = {}): RestoreOptions => ({
  orgId: 'o1',
  matterId: 'm1',
  source: { readTime: '2026-10-05T14:00:00.000Z' },
  apply: false,
  deleteExtra: false,
  now: NOW,
  runId: 'restore-test',
  log: (line) => lines.push(line),
  ...overrides,
});

beforeEach(() => {
  lines.length = 0;
});

describe('restoreMatter', () => {
  it('reports what it would do and writes nothing in a dry run', async () => {
    const { source, target } = backupAndLive();
    const report = await restoreMatter(source, target, opts());
    expect(report.diff).toEqual({
      create: [`${M}/documents/d1/chunks/0`, `${M}/tasks/t2`],
      overwrite: [`${M}/tasks/t1`],
      unchanged: [M, `${M}/documents/d1`],
      extra: [`${M}/tasks/t3`],
    });
    expect(report.applied).toBe(false);
    expect(target.writes).toEqual([]);
    expect(target.audits).toEqual([]);
    expect(lines.join('\n')).toContain('dry run: nothing written');
    // Ids and counts only: no titles in the output.
    expect(lines.join('\n')).not.toContain('Lodge probate');
  });

  it('writes the differences back, keeps what was added since, and audits the restore', async () => {
    const { source, target } = backupAndLive();
    const report = await restoreMatter(source, target, opts({ apply: true }));
    expect(report.applied).toBe(true);
    expect(target.writes.sort()).toEqual([`${M}/documents/d1/chunks/0`, `${M}/tasks/t1`, `${M}/tasks/t2`]);
    expect(await target.get(`${M}/tasks/t1`)).toEqual({ title: 'Lodge probate' });
    expect(await target.get(`${M}/tasks/t3`)).toEqual({ title: 'New task' });
    expect(target.audits).toHaveLength(1);
    const { orgId, entry } = target.audits[0] as (typeof target.audits)[number];
    expect(orgId).toBe('o1');
    expect(entry).toMatchObject({
      actor: 'system',
      action: 'matter.restored',
      entity: { path: M, collection: 'matters', id: 'm1', matterId: 'm1' },
      runId: 'restore-test',
      source: 'job',
      data: {
        readTime: '2026-10-05T14:00:00.000Z',
        created: 2,
        overwritten: 1,
        unchanged: 2,
        addedSince: 1,
        deleted: 0,
      },
    });
    // The org's 10-year retention.
    expect((entry['expireAt'] as Date).getUTCFullYear()).toBe(2036);
  });

  it('deletes what was added since with --delete-extra', async () => {
    const { source, target } = backupAndLive();
    const report = await restoreMatter(
      source,
      target,
      opts({ apply: true, deleteExtra: true, source: { database: 'restore-1' } }),
    );
    expect(report.deleted).toBe(1);
    expect(await target.get(`${M}/tasks/t3`)).toBeNull();
    expect(target.audits[0]?.entry['data']).toMatchObject({ database: 'restore-1', deleted: 1 });
  });

  it('refuses a destroyed matter (certificate or tombstone)', async () => {
    const { source, target } = backupAndLive();
    target.docs.set('orgs/o1/destructionCertificates/dc-m1', { number: 'W-2026-0001' });
    await expect(restoreMatter(source, target, opts({ apply: true }))).rejects.toThrow('was destroyed');

    const other = backupAndLive();
    other.target.docs.set(M, { number: 'W-2026-0001', destroyedAt: NOW, certificateId: 'dc-m1' });
    await expect(restoreMatter(other.source, other.target, opts())).rejects.toThrow('was destroyed');
    expect(other.target.writes).toEqual([]);
  });

  it('refuses a matter the source doesn’t have', async () => {
    const { target } = backupAndLive();
    await expect(restoreMatter(new FakeDb(), target, opts())).rejects.toThrow('isn’t in the source');
  });

  it('refuses to write while a migration run is in progress', async () => {
    const { source, target } = backupAndLive();
    target.running = ['run-42'];
    await expect(restoreMatter(source, target, opts({ apply: true }))).rejects.toThrow('Migration run run-42');
    expect(target.writes).toEqual([]);
  });

  it('rejects ids that aren’t document ids', async () => {
    const { source, target } = backupAndLive();
    await expect(restoreMatter(source, target, opts({ matterId: 'm1/tasks' }))).rejects.toThrow('document ids');
  });
});

describe('checkReadTime', () => {
  it('accepts a time within the last hour to the second', () => {
    expect(checkReadTime('2026-10-05T23:30:15.5Z', NOW)).toBe('2026-10-05T23:30:15.500Z');
  });

  it('needs a whole minute when older than an hour', () => {
    expect(checkReadTime('2026-10-05T10:00:00Z', NOW)).toBe('2026-10-05T10:00:00.000Z');
    expect(() => checkReadTime('2026-10-05T10:00:30Z', NOW)).toThrow('whole minute');
  });

  it('rejects the future, the far past and nonsense', () => {
    expect(() => checkReadTime('2026-10-07T00:00:00Z', NOW)).toThrow('in the past');
    expect(() => checkReadTime('2026-09-20T00:00:00Z', NOW)).toThrow('7-day PITR window');
    expect(() => checkReadTime('yesterday', NOW)).toThrow('isn’t a timestamp');
  });
});

describe('parseArgs', () => {
  const base = ['--project', 'materia-v2-dev', '--org', 'o1', '--matter', 'm1'];

  it('is a dry run against (default) unless told otherwise', () => {
    expect(parseArgs([...base, '--from-database', 'restore-1'], NOW)).toEqual({
      project: 'materia-v2-dev',
      orgId: 'o1',
      matterId: 'm1',
      fromDatabase: 'restore-1',
      targetDatabase: '(default)',
      apply: false,
      deleteExtra: false,
    });
    expect(parseArgs([...base, '--read-time', '2026-10-05T23:00:00Z', '--apply', '--delete-extra'], NOW)).toMatchObject(
      {
        readTime: '2026-10-05T23:00:00.000Z',
        apply: true,
        deleteExtra: true,
      },
    );
  });

  it('needs exactly one source and the ids', () => {
    expect(() => parseArgs(base, NOW)).toThrow('exactly one');
    expect(() => parseArgs([...base, '--from-database', 'x', '--read-time', '2026-10-05T23:00:00Z'], NOW)).toThrow(
      'exactly one',
    );
    expect(() => parseArgs(['--project', 'p'], NOW)).toThrow('Usage');
    expect(() => parseArgs([...base, '--from-database', '(default)'], NOW)).toThrow('is the target');
    expect(() => parseArgs([...base, '--from-database', 'x', '--apply', '--dry-run'], NOW)).toThrow('together');
  });
});
