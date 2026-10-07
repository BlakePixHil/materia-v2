import { AdminApi } from './admin-api.ts';
import {
  deleteLeftovers,
  drill,
  parseArgs,
  pitrSnapshot,
  scratchId,
  summary,
  type DrillDatabases,
  type DrillOptions,
} from './drill.ts';
import { scripted } from './fake.ts';

/** The restore drill (SEC-03) against a scripted API and fake counts. */

const START = Date.parse('2026-10-06T00:00:00Z');
const op = (name: string) => ({ name, done: true });

function databases(
  counts: Record<string, Record<string, number>>,
  readTimes: (string | undefined)[] = [],
): DrillDatabases {
  return {
    collectionIds: async (id) => Object.keys(counts[id] ?? {}),
    count: async (id, group, readTime) => {
      if (id === '(default)') readTimes.push(readTime);
      return counts[id]?.[group] ?? 0;
    },
  };
}

function options(clock: { t: number }, lines: string[]): DrillOptions {
  return {
    location: 'australia-southeast1',
    exportsBucket: 'materia-v2-dev-exports',
    keep: false,
    now: () => START + clock.t,
    log: (line) => lines.push(line),
  };
}

describe('drill', () => {
  it('restores the newest backup, compares counts at its snapshot time and deletes the scratch database', async () => {
    const { deps, calls, clock } = scripted([
      {
        backups: [
          {
            name: 'projects/p/locations/l/backups/b1',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-05T14:00:00Z',
            state: 'READY',
          },
        ],
      },
      { name: 'ops/restore', done: false },
      op('ops/restore'),
      { status: 400, error: { message: 'Cannot serve because the database is in the middle of restore.' } },
      { collectionIds: [] },
      { name: 'ops/delete', done: true },
    ]);
    const readTimes: (string | undefined)[] = [];
    const db = 'drill-20261006-0000-backup';
    const lines: string[] = [];
    const result = await drill(
      new AdminApi(deps, 'p'),
      databases({ [db]: { matters: 3, tasks: 10 }, '(default)': { matters: 3, tasks: 10, audit: 0 } }, readTimes),
      'backup',
      options(clock, lines),
    );
    expect(result).toMatchObject({
      source: 'backup',
      database: db,
      from: 'projects/p/locations/l/backups/b1',
      snapshotTime: '2026-10-05T14:00:00Z',
      rpoMinutes: 600,
      restoreSeconds: 25,
      documents: 13,
      mismatches: [],
      exact: true,
      deleted: true,
    });
    expect(result.groups.map((g) => g.group)).toEqual(['audit', 'matters', 'tasks']);
    expect(new Set(readTimes)).toEqual(new Set(['2026-10-05T14:00:00Z']));
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining(`/databases/${db}`) });
  });

  it('compares a backup taken mid-minute with the live counts at the minutes either side', async () => {
    const { deps, clock } = scripted([
      {
        backups: [
          {
            name: 'projects/p/locations/l/backups/b1',
            database: 'projects/p/databases/(default)',
            snapshotTime: '2026-10-05T11:14:35.891229Z',
            state: 'READY',
          },
        ],
      },
      op('ops/restore'),
      { collectionIds: [] },
      { name: 'ops/delete', done: true },
    ]);
    const db = 'drill-20261006-0000-backup';
    const liveAt: Record<string, Record<string, number>> = {
      '2026-10-05T11:14:00.000Z': { matters: 3, tasks: 10, notes: 4 },
      '2026-10-05T11:15:00.000Z': { matters: 3, tasks: 12, notes: 4 },
    };
    const readTimes: (string | undefined)[] = [];
    const result = await drill(
      new AdminApi(deps, 'p'),
      {
        collectionIds: async () => ['matters', 'notes', 'tasks'],
        count: async (id, group, readTime) => {
          if (id === db) return { matters: 3, tasks: 11, notes: 5 }[group] ?? 0;
          readTimes.push(readTime);
          return liveAt[readTime as string]?.[group] ?? -1;
        },
      },
      'backup',
      options(clock, []),
    );
    expect(new Set(readTimes)).toEqual(new Set(Object.keys(liveAt)));
    expect(result.liveReadTimes).toEqual(Object.keys(liveAt));
    expect(result.groups.find((g) => g.group === 'tasks')).toEqual({
      group: 'tasks',
      restored: 11,
      live: 10,
      liveNextMinute: 12,
    });
    expect(result.mismatches).toEqual(['notes: restored 5, live 4 to 4']);
    expect(summary([{ ...result, mismatches: [] }])).toContain('✅ counts match (within the snapshot minute)');
  });

  it('imports the newest export into a new database and reports mismatched counts', async () => {
    const { deps, calls, clock } = scripted([
      { items: [{ name: 'daily/2026-10-05T14-59-00Z/2026-10-05T14-59-00Z.overall_export_metadata' }] },
      { items: [] },
      op('ops/create'),
      op('ops/import'),
      { collectionIds: [] },
      op('ops/delete'),
    ]);
    const db = 'drill-20261006-0000-export';
    const lines: string[] = [];
    const result = await drill(
      new AdminApi(deps, 'p'),
      databases({ [db]: { matters: 2 }, '(default)': { matters: 3 } }),
      'export',
      options(clock, lines),
    );
    expect(result.mismatches).toEqual(['matters: restored 2, live 3']);
    expect(lines).toContain('  MISMATCH matters: restored 2, live 3');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'POST', 'POST', 'DELETE']);
    expect(calls[3]?.body).toEqual({ inputUriPrefix: 'gs://materia-v2-dev-exports/daily/2026-10-05T14-59-00Z' });
  });

  it('clones a PITR snapshot and keeps the scratch database with --keep', async () => {
    const { deps, calls, clock } = scripted([op('ops/clone'), { collectionIds: [] }]);
    const lines: string[] = [];
    const result = await drill(new AdminApi(deps, 'p'), databases({}), 'pitr', {
      ...options(clock, lines),
      keep: true,
    });
    expect(result.snapshotTime).toBe('2026-10-05T23:58:00.000Z');
    expect(result.deleted).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain(':listCollectionIds');
  });

  it('fails when there is nothing to restore, and still tries to clean up', async () => {
    const { deps } = scripted([{ backups: [] }, { status: 404, error: 'not found' }]);
    const lines: string[] = [];
    await expect(drill(new AdminApi(deps, 'p'), databases({}), 'backup', options({ t: 0 }, lines))).rejects.toThrow(
      'No ready managed backup',
    );
    expect(lines.at(-1)).toContain('could not delete');
  });

  it('compares against today’s data when the snapshot is older than the PITR window', async () => {
    const { deps, clock } = scripted([
      { items: [] },
      { items: [{ name: 'monthly/2026-09-01T14-59-00Z/2026-09-01T14-59-00Z.overall_export_metadata' }] },
      op('c'),
      op('i'),
      { collectionIds: [] },
      op('d'),
    ]);
    const readTimes: (string | undefined)[] = [];
    const result = await drill(
      new AdminApi(deps, 'p'),
      databases({ '(default)': { matters: 1 } }, readTimes),
      'export',
      options(clock, []),
    );
    expect(result.exact).toBe(false);
    expect(readTimes).toEqual([undefined]);
  });
});

describe('deleteLeftovers', () => {
  it('deletes only drill- databases', async () => {
    const { deps, calls } = scripted([
      {
        databases: [
          { name: 'projects/p/databases/(default)' },
          { name: 'projects/p/databases/drill-20261006-2100-backup' },
          { name: 'projects/p/databases/restore-20261006' },
        ],
      },
      op('del'),
    ]);
    const lines: string[] = [];
    expect(await deleteLeftovers(new AdminApi(deps, 'p'), (line) => lines.push(line))).toEqual([
      'drill-20261006-2100-backup',
    ]);
    expect(calls.map((c) => `${c.method} ${c.url.split('/v1/')[1]}`)).toEqual([
      'GET projects/p/databases',
      'DELETE projects/p/databases/drill-20261006-2100-backup',
    ]);
    expect(lines).toEqual(['deleted leftover drill-20261006-2100-backup']);
  });
});

describe('summary', () => {
  it('renders a table row per source and lists mismatches', () => {
    const base = {
      database: 'd',
      from: 'f',
      snapshotTime: '2026-10-05T14:00:00Z',
      rpoMinutes: 600,
      restoreSeconds: 95,
      verifySeconds: 12,
      documents: 13,
      groups: [{ group: 'matters', restored: 3, live: 3 }],
      liveReadTimes: ['2026-10-05T14:00:00Z'],
      deleted: true,
    };
    const markdown = summary([
      { ...base, source: 'backup', mismatches: [], exact: true },
      { ...base, source: 'export', mismatches: ['tasks: restored 1, live 2'], exact: true },
    ]);
    expect(markdown).toContain('| backup | 2026-10-05T14:00:00Z | 600 min | 95 s | 12 s | 13 | 1 | ✅ counts match |');
    expect(markdown).toContain('❌ 1 mismatched');
    expect(markdown).toContain('- export: tasks: restored 1, live 2');
  });
});

describe('helpers', () => {
  it('names scratch databases and picks a PITR time', () => {
    expect(scratchId('backup', START)).toBe('drill-20261006-0000-backup');
    expect(pitrSnapshot(START + 59_000)).toBe('2026-10-05T23:58:00.000Z');
  });

  it('parses the arguments and refuses prod', () => {
    expect(parseArgs(['--project', 'materia-v2-dev'])).toEqual({
      project: 'materia-v2-dev',
      sources: ['backup'],
      keep: false,
    });
    expect(parseArgs(['--project', 'materia-v2-dev', '--source', 'all', '--keep'])).toEqual({
      project: 'materia-v2-dev',
      sources: ['backup', 'export'],
      keep: true,
    });
    expect(() => parseArgs(['--project', 'materia-v2-prod'])).toThrow('runs on dev');
    expect(() => parseArgs(['--project', 'materia-v2-dev', '--source', 'tape'])).toThrow('--source is');
    expect(() => parseArgs([])).toThrow('Usage');
  });
});
