import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256 } from './export/jsonl.ts';
import { dirSink, memorySink } from './export/sink.ts';
import { runTransform } from './transform/run.ts';
import { exportFixtureRun, FIXTURE_PROFILE, FIXTURE_RUN_ID } from './transform/testing.ts';
import { readRawRun, transformCommand, type TransformCommandDeps } from './transform.ts';

const GOLDEN = join(import.meta.dirname, '../fixtures/golden');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'materia-transform-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The fixtures exported to `<dir>/<runId>/`, under the profile file's own hash. */
async function exportTo(runId: string, since?: string) {
  const profileHash = sha256(await readFile(FIXTURE_PROFILE, 'utf8'));
  const { files } = await exportFixtureRun({ runId, profileHash, ...(since ? { since } : {}) });
  for (const [name, text] of files) {
    const sink = dirSink(join(dir, runId));
    const file = await sink.create(name, 'text/plain');
    await file.write(text);
    await file.close();
  }
}

async function run(argv: string[], deps: TransformCommandDeps = {}, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await transformCommand(
    argv,
    (line) => void out.push(line),
    (line) => void err.push(line),
    env,
    { toolVersion: async () => '0.0.0+test', ...deps },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const local = (runId: string, ...more: string[]) => [
  '--run',
  runId,
  '--profile',
  FIXTURE_PROFILE,
  '--target-org',
  'new',
  '--dir',
  dir,
  ...more,
];

const read = (runId: string, name: string) => readFile(join(dir, runId, name), 'utf8');

describe('materia-migrate transform', () => {
  it('prints its usage', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('materia-migrate transform --run <runId> --profile <profile.json> --target-org <orgId|new>');
  });

  it('refuses bad arguments before reading anything', async () => {
    const profile = ['--profile', FIXTURE_PROFILE, '--target-org', 'new'];
    const cases: [string[], RegExp][] = [
      [['--profile', FIXTURE_PROFILE, '--target-org', 'new', '--dir', dir], /Usage/],
      [['--run', 'r1', '--target-org', 'new', '--dir', dir], /Usage/],
      [['--run', 'r1', '--profile', FIXTURE_PROFILE, '--dir', dir], /Usage/],
      [['--run', '../r1', ...profile, '--dir', dir], /may hold only letters/],
      [['--run', 'r1', ...profile, '--base-run', 'r/0', '--dir', dir], /may hold only letters/],
      [['--run', 'r1', ...profile, '--base-run', 'r1', '--dir', dir], /--base-run is the run being transformed/],
      [['--run', 'r1', '--profile', FIXTURE_PROFILE, '--target-org', 'orgs/x', '--dir', dir], /org id or new/],
      [['--run', 'r1', ...profile, '--dir', dir, '--env', 'dev'], /--env or --dir, not both/],
      [['--run', 'r1', ...profile], /--env dev, --env prod or --env emulator/],
      [['--run', 'r1', ...profile, '--env', 'staging'], /--env dev, --env prod or --env emulator/],
      [['--run', 'r1', ...profile, '--env', 'emulator'], /is not set: run under `firebase emulators:exec`/],
      [['--run', 'r1', ...profile, '--nope'], /Unknown option/],
      [['--run', 'r1', '--profile', join(dir, 'none.json'), '--target-org', 'new', '--dir', dir], /Can't read/],
    ];
    for (const [argv, message] of cases) {
      const { code, err } = await run(argv);
      expect({ argv, code }).toEqual({ argv, code: 1 });
      expect(err).toMatch(message);
    }
  });

  it('refuses a profile that is not a mapping profile', async () => {
    const path = join(dir, 'profile.json');
    await writeFile(path, '{"version": 1}');
    const { code, err } = await run(['--run', 'r1', '--profile', path, '--target-org', 'new', '--dir', dir]);
    expect(code).toBe(1);
    expect(err).toMatch(/is not a valid mapping profile/);
  });

  it('writes the golden output to a local run, report last, and the same bytes again on a re-run', async () => {
    await exportTo(FIXTURE_RUN_ID);
    const first = await run(local(FIXTURE_RUN_ID));
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Wrote 14 entity files, idmap.jsonl and report.json/);
    // Counts and codes only.
    expect(first.out).not.toMatch(/Alex|Rivers|Wills|@example/);

    const report = JSON.parse(await read(FIXTURE_RUN_ID, 'report.json')) as {
      profileChanged: boolean;
      files: Record<string, { sha256: string }>;
    };
    expect(report.profileChanged).toBe(false);
    expect(Object.keys(report.files)).toHaveLength(15);
    for (const [name, { sha256: hash }] of Object.entries(report.files)) {
      const text = await read(FIXTURE_RUN_ID, name);
      expect(sha256(text)).toBe(hash);
      expect(text).toBe(await readFile(join(GOLDEN, name), 'utf8'));
    }

    const before = await Promise.all(Object.keys(report.files).map((name) => read(FIXTURE_RUN_ID, name)));
    expect((await run(local(FIXTURE_RUN_ID))).code).toBe(0);
    const after = await Promise.all(Object.keys(report.files).map((name) => read(FIXTURE_RUN_ID, name)));
    expect(after).toEqual(before);
    expect(await read(FIXTURE_RUN_ID, 'report.json')).toBe(JSON.stringify(report, null, 2) + '\n');
  });

  it('warns when the profile changed since the export', async () => {
    await exportTo('changed-run');
    const changed = join(dir, 'profile.json');
    const profile = JSON.parse(await readFile(FIXTURE_PROFILE, 'utf8')) as Record<string, unknown>;
    await writeFile(changed, JSON.stringify(profile));
    const argv = local('changed-run');
    argv[3] = changed;
    const { code, out } = await run(argv);
    expect(code).toBe(0);
    expect(out).toMatch(/differs from the profile run changed-run was exported under/);
    expect(JSON.parse(await read('changed-run', 'report.json'))).toMatchObject({ profileChanged: true });
  });

  it('refuses a run that is missing, changed since its export, or another run', async () => {
    expect((await run(local('nothing-here'))).err).toMatch(/has no manifest.json: export it first/);

    await exportTo('tampered-run');
    const cards = join(dir, 'tampered-run', 'raw/cards.jsonl');
    await writeFile(cards, `${await readFile(cards, 'utf8')}\n`);
    const tampered = await run(local('tampered-run'));
    expect(tampered.code).toBe(1);
    expect(tampered.err).toMatch(/raw\/cards.jsonl doesn't match the manifest's sha256/);

    await exportTo('first-run');
    await cp(join(dir, 'first-run'), join(dir, 'copied-run'), { recursive: true });
    const copied = await run(local('copied-run'));
    expect(copied.code).toBe(1);
    expect(copied.err).toMatch(/manifest.json is run first-run, not copied-run/);
  });

  it('refuses a raw file the manifest names but the run lacks', async () => {
    await exportTo('short-run');
    await rm(join(dir, 'short-run', 'raw/attachments.jsonl'));
    await expect(readRawRun(dirSink(join(dir, 'short-run')))).rejects.toThrow(/raw\/attachments.jsonl is missing/);
  });

  it('writes only the report when records are rejected, unless --allow-rejects', async () => {
    const transform: typeof runTransform = (raw, args) => {
      const output = runTransform(raw, args);
      const reject = {
        entity: 'matters' as const,
        path: 'orgs/o/matters/m',
        legacyPath: 'workflows/w/cards/c',
        issues: [{ path: 'title', code: 'too_big', message: 'Too big' }],
      };
      return { ...output, rejected: true, report: { ...output.report, rejects: [reject] } };
    };
    await exportTo('reject-run');
    const refused = await run(local('reject-run'), { transform });
    expect(refused.code).toBe(5);
    expect(refused.err).toMatch(/1 records failed validation .*Nothing else was written/);
    expect(refused.out).toMatch(/Rejected: 1 records/);
    const report = JSON.parse(await read('reject-run', 'report.json')) as { files: object; rejects: unknown[] };
    expect(report.files).toEqual({});
    expect(report.rejects).toHaveLength(1);
    await expect(read('reject-run', 'idmap.jsonl')).rejects.toThrow(/ENOENT/);

    const allowed = await run(local('reject-run', '--allow-rejects'), { transform });
    expect(allowed.code).toBe(0);
    expect(await read('reject-run', 'idmap.jsonl')).not.toBe('');
  });

  it('transforms a delta against its base run, keeping its numbers', async () => {
    await exportTo('base-run');
    expect((await run(local('base-run'))).code).toBe(0);
    await exportTo('delta-run', '2025-02-15T00:00:00.000Z');

    const without = await run(local('delta-run'));
    expect(without.code).toBe(1);
    expect(without.err).toMatch(/--base-run/);

    const missing = await run(local('delta-run', '--base-run', 'no-such-run'));
    expect(missing.err).toMatch(/has no transformed\/matter-numbers.jsonl/);

    const { code, out } = await run(local('delta-run', '--base-run', 'base-run'));
    expect(code).toBe(0);
    expect(out).toMatch(/\(delta\)/);
    const base = new Map(
      (await read('base-run', 'transformed/matters.jsonl'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { path: string; data: { number: string } })
        .map((m) => [m.path, m.data.number]),
    );
    const delta = (await read('delta-run', 'transformed/matters.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; data: { number: string } });
    expect(delta.length).toBeGreaterThan(0);
    for (const matter of delta) expect(matter.data.number).toBe(base.get(matter.path));
    expect(await read('delta-run', 'transformed/matter-numbers.jsonl')).toBe('');
  });

  it('reads and writes the run through the sink it is given', async () => {
    const { files } = await exportFixtureRun({
      profileHash: sha256(await readFile(FIXTURE_PROFILE, 'utf8')),
    });
    const { code, out } = await run(
      ['--run', FIXTURE_RUN_ID, '--profile', FIXTURE_PROFILE, '--target-org', 'new', '--env', 'emulator'],
      { sink: (id) => memorySink(id, files) },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/to memory:\/\/runs\/fixture-run\//);
    expect(files.get('transformed/matters.jsonl')).toBe(
      await readFile(join(GOLDEN, 'transformed/matters.jsonl'), 'utf8'),
    );
  });
});
