import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REQUIRED_READS } from './audit/iam.ts';
import type { AuditReport } from './audit/report.ts';
import { EXPORT_FILES } from './export/scope.ts';
import { memorySink, type RunSink } from './export/sink.ts';
import {
  compareWithAudit,
  exportCommand,
  ExportRefusedError,
  runExport,
  type ExportArgs,
  type ExportDeps,
  type ExportManifest,
} from './export.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from './legacy/fixtures.ts';
import { memoryReader, type LegacyReader } from './legacy/reader.ts';
import type { IamTester } from './legacy/rest.ts';
import { loadProfile, type MappingProfile } from './profile.ts';

const { docs, objects } = loadLegacyFixtures();
const READ_TIME = '2026-10-06T21:00:00.123456Z';
const NOW = new Date('2026-10-06T21:05:00Z');

function grants(project: string[], bucket: string[] = []): IamTester {
  return {
    project: async (asked) => asked.filter((p) => project.includes(p)),
    bucket: async (asked) => asked.filter((p) => bucket.includes(p)),
  };
}
const READ_ONLY = grants([...REQUIRED_READS, 'firebaseauth.users.get']);

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

const args = (over: Partial<ExportArgs> = {}): ExportArgs => ({
  uid: FIXTURE_UIDS.subject,
  profile,
  profileHash: 'profile-sha',
  source: { project: 'legacy-p', bucket: 'legacy-b' },
  runId: 'r1',
  resume: false,
  toolVersion: '0.0.0+test',
  ...over,
});

function setup(options: { iam?: IamTester | null; sink?: RunSink | null; now?: Date; reader?: LegacyReader } = {}) {
  const lines: string[] = [];
  const reads: string[] = [];
  const base: LegacyReader = options.reader ?? {
    ...memoryReader(docs, objects),
    authRecord: async () => ({ email: 'alex.rivers@example.com', providers: ['google.com'] }),
  };
  const spied: LegacyReader = {
    ...base,
    get: (path) => (reads.push(path), base.get(path)),
    list: (path) => (reads.push(path), base.list(path)),
    query: (...a) => (reads.push(a[0]), base.query(...a)),
  };
  const readTimes: string[] = [];
  const sink = options.sink === undefined ? memorySink('r1') : options.sink;
  const deps: ExportDeps = {
    iam: options.iam === undefined ? READ_ONLY : options.iam,
    serverReadTime: async () => (reads.push('readTime'), READ_TIME),
    reader: (readTime) => (readTimes.push(readTime), spied),
    sink,
    now: () => options.now ?? NOW,
    log: (line) => void lines.push(line),
  };
  return { deps, lines, reads, readTimes, sink };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('runExport', () => {
  it('refuses write-capable credentials before reading or writing anything', async () => {
    const files = new Map<string, string>();
    const { deps, reads } = setup({
      iam: grants([...REQUIRED_READS, 'datastore.entities.update']),
      sink: memorySink('r1', files),
    });
    await expect(runExport(args(), deps)).rejects.toThrow(
      /Refusing to read the legacy project: these credentials can write/,
    );
    expect(reads).toEqual([]);
    expect(files.size).toBe(0);
  });

  it('refuses credentials with a bucket-level write too', async () => {
    const { deps, reads } = setup({ iam: grants([...REQUIRED_READS], ['storage.objects.create']) });
    await expect(runExport(args(), deps)).rejects.toThrow(/bucket:storage.objects.create/);
    expect(reads).toEqual([]);
  });

  it('writes every file, then a manifest whose counts and sha256s match them', async () => {
    const files = new Map<string, string>();
    const { deps, readTimes } = setup({ sink: memorySink('r1', files) });
    const manifest = await runExport(args(), deps);

    expect([...files.keys()].filter((name) => name.startsWith('raw/'))).toEqual(
      EXPORT_FILES.map((file) => `raw/${file}.jsonl`),
    );
    expect(readTimes).toEqual([READ_TIME]);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const text = files.get(name) ?? '';
      expect(entry).toEqual({ count: text.split('\n').length - 1, bytes: Buffer.byteLength(text), sha256: sha(text) });
    }
    expect(manifest).toMatchObject({
      version: 1,
      runId: 'r1',
      kind: 'full',
      sourceProject: 'legacy-p',
      uid: FIXTURE_UIDS.subject,
      readTime: READ_TIME,
      startedAt: NOW.toISOString(),
      toolVersion: '0.0.0+test',
      profileHash: 'profile-sha',
      location: 'memory://runs/r1/',
      workflows: { exported: 3, excluded: 1 },
      counts: { cards: 10, attachments: 7, people: 2, auth: 1, 'storage-objects': 9, notifications: 2 },
      downloadTokensStripped: 7,
      warnings: [],
    });
    expect(JSON.parse(files.get('manifest.json') ?? '')).toEqual(manifest);
    expect(JSON.parse(files.get('checkpoint.json') ?? '')).toMatchObject({ readTime: READ_TIME, runId: 'r1' });

    const cards = (files.get('raw/cards.jsonl') ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { path: string; id: string; readTime: string });
    expect(cards.map((c) => c.path)).toEqual(cards.map((c) => c.path).sort());
    expect(cards.every((c) => c.readTime === READ_TIME && c.path.endsWith(`/${c.id}`))).toBe(true);
  });

  it('gives the same bytes for the same snapshot', async () => {
    const first = await runExport(args(), setup().deps);
    const second = await runExport(args({ runId: 'r2' }), setup({ sink: memorySink('r2') }).deps);
    expect(second.files).toEqual(first.files);
  });

  it('logs counts, never data', async () => {
    const { deps, lines } = setup();
    await runExport(args(), deps);
    const log = lines.join('\n');
    const data = new Set<string>();
    for (const doc of docs) {
      for (const key of [
        'title',
        'description',
        'name',
        'originalFileName',
        'email',
        'firstName',
        'lastName',
        'company',
      ]) {
        const value = doc.data[key];
        if (typeof value === 'string' && value.trim().length > 3) data.add(value.trim());
      }
    }
    expect(data.size).toBeGreaterThan(20);
    for (const value of data) expect(log).not.toContain(value);
    expect(log).not.toContain('@');
    expect(log).toMatch(/raw\/cards.jsonl: 10 records/);
  });

  it('writes nothing in a dry run', async () => {
    const { deps, lines } = setup({ sink: null });
    const manifest = await runExport(args(), deps);
    expect(manifest.location).toBe('dry-run');
    expect(manifest.counts.cards).toBe(10);
    expect(lines.at(-1)).toMatch(/^Dry run: .* wrote nothing/);
  });

  it('reads the emulator without an IAM check', async () => {
    const { deps, lines } = setup({ iam: null });
    await runExport(args(), deps);
    expect(lines[0]).toMatch(/on the emulator, which has no IAM/);
  });

  it('refuses a run id already in use', async () => {
    const sink = memorySink('r1', new Map([['checkpoint.json', '{}']]));
    await expect(runExport(args(), setup({ sink }).deps)).rejects.toThrow(
      /already exists .* --resume, or a new --run-id/,
    );
  });

  it('refuses a since that is not before the snapshot', async () => {
    await expect(runExport(args({ since: '2026-10-06T22:00:00.000Z' }), setup().deps)).rejects.toThrow(
      ExportRefusedError,
    );
  });

  it('records a delta as one, with the paths the load needs to see deletions', async () => {
    const files = new Map<string, string>();
    const manifest = await runExport(
      args({ since: '2025-02-05T00:00:00.000Z' }),
      setup({ sink: memorySink('r1', files) }).deps,
    );
    expect(manifest).toMatchObject({
      kind: 'delta',
      since: '2025-02-05T00:00:00.000Z',
      counts: { cards: 9, attachments: 7, paths: 17 },
      delta: { unchanged: { cards: 1, attachments: 0 }, nonUniform: { cards: 1 } },
    });
    expect(files.get('raw/paths.jsonl')?.split('\n')).toHaveLength(18);
  });
});

describe('resuming an interrupted run', () => {
  async function interrupted(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const sink = memorySink('r1', files);
    // The first attempt dies while writing the cards.
    const failing: RunSink = {
      ...sink,
      async create(name, type, options) {
        if (name === 'raw/cards.jsonl') throw new Error('connection reset');
        return sink.create(name, type, options);
      },
    };
    await expect(runExport(args(), setup({ sink: failing }).deps)).rejects.toThrow('connection reset');
    return files;
  }

  it('keeps the readTime and the files already written, and writes the rest', async () => {
    const files = await interrupted();
    expect(files.has('manifest.json')).toBe(false);
    const checkpoint = JSON.parse(files.get('checkpoint.json') ?? '') as { files: Record<string, unknown> };
    expect(Object.keys(checkpoint.files)).toEqual(EXPORT_FILES.slice(0, 5).map((f) => `raw/${f}.jsonl`));

    const workflows = files.get('raw/workflows.jsonl');
    const { deps, lines, reads } = setup({ sink: memorySink('r1', files) });
    const manifest = await runExport(args({ resume: true }), deps);
    expect(reads).not.toContain('readTime');
    expect(manifest.readTime).toBe(READ_TIME);
    expect(files.get('raw/workflows.jsonl')).toBe(workflows);
    expect(lines).toContain('raw/workflows.jsonl: 3 records, kept from the interrupted run.');
    expect(Object.keys(manifest.files)).toHaveLength(EXPORT_FILES.length);
    expect(files.has('manifest.json')).toBe(true);
  });

  it('refuses when the snapshot is too old for Firestore to read', async () => {
    const files = await interrupted();
    const late = setup({ sink: memorySink('r1', files), now: new Date('2026-10-06T22:00:00Z') });
    await expect(runExport(args({ resume: true }), late.deps)).rejects.toThrow(/nearly an hour old/);
  });

  it('refuses when the profile or delta changed', async () => {
    const files = await interrupted();
    await expect(
      runExport(args({ resume: true, profileHash: 'other' }), setup({ sink: memorySink('r1', files) }).deps),
    ).rejects.toThrow(/the mapping profile differ/);
    await expect(
      runExport(
        args({ resume: true, since: '2025-01-01T00:00:00.000Z' }),
        setup({ sink: memorySink('r1', files) }).deps,
      ),
    ).rejects.toThrow(/--since differ/);
  });

  it('fails when a file written at the same readTime reads back differently', async () => {
    const files = await interrupted();
    const changed = docs.map((doc) =>
      doc.path.startsWith('workspaces/') ? { ...doc, data: { ...doc.data, name: 'changed' } } : doc,
    );
    const reader = { ...memoryReader(changed, objects), authRecord: async () => null };
    await expect(
      runExport(args({ resume: true }), setup({ sink: memorySink('r1', files), reader }).deps),
    ).rejects.toThrow(/raw\/workspaces.jsonl differs/);
  });

  it('refuses a run that finished, or never started', async () => {
    const done = memorySink(
      'r1',
      new Map([
        ['manifest.json', '{}'],
        ['checkpoint.json', '{}'],
      ]),
    );
    await expect(runExport(args({ resume: true }), setup({ sink: done }).deps)).rejects.toThrow(/already complete/);
    await expect(runExport(args({ resume: true }), setup().deps)).rejects.toThrow(/Nothing to resume/);
  });
});

describe('compareWithAudit', () => {
  it("puts the export's counts beside the audit's", () => {
    const manifest = {
      workflows: { exported: 5, excluded: 1 },
      counts: {
        cards: 313,
        attachments: 70,
        'checklist-templates': 4,
        referrers: 30,
        integrations: 3,
        workspaces: 1,
        'dashboard-checklist-items': 0,
      },
    } as unknown as ExportManifest;
    const report = {
      counts: {
        workflows: { inScope: 5 },
        cards: { total: 313 },
        attachments: { count: 71 },
        checklistTemplates: 4,
        referrers: 30,
        integrations: 3,
        workspaces: 1,
        dashboardItems: 0,
      },
    } as unknown as AuditReport;
    const rows = compareWithAudit(manifest, report);
    expect(rows.filter((r) => r.exported !== r.audit)).toEqual([{ name: 'attachments', exported: 70, audit: 71 }]);
    expect(rows).toHaveLength(8);
  });
});

describe('exportCommand', () => {
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await exportCommand(
      argv,
      (l) => void out.push(l),
      (l) => void out.push(l),
      {},
    );
    return { code, out: out.join('\n') };
  };
  const PROFILE = `${FIXTURE_DIR}mapping-profile.json`;

  it('prints its usage', async () => {
    expect(await run('--help')).toMatchObject({ code: 0, out: expect.stringContaining('materia-migrate export') });
    expect((await run()).code).toBe(1);
  });

  it('refuses arguments that make no sense', async () => {
    expect(await run('--profile', PROFILE)).toMatchObject({ code: 1, out: expect.stringMatching(/--env dev/) });
    expect(await run('--profile', PROFILE, '--env', 'staging')).toMatchObject({ code: 1 });
    expect(await run('--profile', PROFILE, '--dry-run', '--resume')).toMatchObject({ code: 1 });
    expect(await run('--profile', PROFILE, '--env', 'dev', '--resume')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/--run-id/),
    });
    expect(await run('--profile', PROFILE, '--env', 'dev', '--run-id', '../x')).toMatchObject({ code: 1 });
    expect(await run('--profile', PROFILE, '--dry-run', '--since', 'last week')).toMatchObject({ code: 1 });
    expect(await run('--profile', PROFILE, '--dry-run', '--uid', 'someone-else')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/not the profile's subject/),
    });
  });

  it('keeps made-up data and the emulator apart from the real buckets', async () => {
    expect(await run('--profile', PROFILE, '--env', 'emulator')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/only a demo- source/),
    });
    expect(await run('--profile', PROFILE, '--env', 'prod', '--source-project', 'demo-legacy')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/never goes to the prod/),
    });
    expect(await run('--profile', PROFILE, '--env', 'emulator', '--source-project', 'demo-legacy')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/FIRESTORE_EMULATOR_HOST is not set/),
    });
  });

  it('rejects an invalid profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-02-'));
    await writeFile(join(dir, 'bad.json'), '{"version": 2}');
    expect(await run('--profile', join(dir, 'bad.json'), '--dry-run')).toMatchObject({
      code: 1,
      out: expect.stringMatching(/not a valid mapping profile/),
    });
  });
});
