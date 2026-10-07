import { memorySink } from './export/sink.ts';
import { memoryStore } from './files/testing.ts';
import { FIXTURE_ORG, FIXTURE_UID, fixtureRun } from './load/fixture.ts';
import { memoryAuth, memoryDb } from './load/testing.ts';
import {
  checkEmulator,
  deltaCommand,
  emulatorReadAs,
  loadCommand,
  rollbackCommand,
  verifyCommand,
  type Connect,
} from './load-commands.ts';

const EMULATORS = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
};

/** Everything in memory, as the commands would reach it. */
function world(files = fixtureRun()) {
  const sink = memorySink('run-fixture', files);
  const target = memoryDb();
  const { auth, claims } = memoryAuth({ [FIXTURE_UID]: {} });
  const store = memoryStore();
  let closed = 0;
  const connect: Connect = async () => ({
    sink,
    db: target.db,
    auth,
    files: { store: store.store, bucket: 'materia-v2-dev-files' },
    operator: 'operator@example.com',
    close: async () => void (closed += 1),
  });
  const out: string[] = [];
  const err: string[] = [];
  const io = (extra: { env?: NodeJS.ProcessEnv; ask?: (q: string) => Promise<string> } = {}) => ({
    log: (line: string) => void out.push(line),
    error: (line: string) => void err.push(line),
    env: {},
    connect,
    ...extra,
  });
  return { sink, target, claims, io, out, err, closed: () => closed };
}

describe('materia-migrate load, verify, rollback and delta', () => {
  it('print their usage', async () => {
    for (const command of [loadCommand, verifyCommand, rollbackCommand, deltaCommand]) {
      const w = world();
      expect(await command(['--help'], w.io())).toBe(0);
      expect(w.out.join('\n')).toMatch(/^Usage: materia-migrate (load|verify|rollback|delta) --run/);
    }
  });

  it('refuse bad arguments before connecting', async () => {
    const cases: [string[], RegExp][] = [
      [['--env', 'dev'], /Usage/],
      [['--run', 'r1'], /Usage/],
      [['--run', 'r1', '--env', 'staging'], /--env dev, --env prod or --env emulator/],
      [['--run', '../r1', '--env', 'dev'], /may hold only letters/],
      [['--run', 'r1', '--env', 'dev', '--nope'], /Unknown option/],
    ];
    for (const [argv, message] of cases) {
      const w = world();
      expect(await loadCommand(argv, w.io())).toBe(1);
      expect(w.err.join('\n')).toMatch(message);
      expect(w.closed()).toBe(0);
    }
    const w = world();
    expect(await loadCommand(['--run', 'r1', '--env', 'dev', '--mode', 'delta'], w.io())).toBe(1);
    expect(w.err.join('\n')).toMatch(/--mode takes rehearsal or cutover/);
  });

  it('keep the emulator and real projects apart', async () => {
    expect(checkEmulator('emulator', {})).toMatch(/FIRESTORE_EMULATOR_HOST.*not set/);
    expect(checkEmulator('emulator', EMULATORS)).toBeNull();
    expect(checkEmulator('dev', { FIRESTORE_EMULATOR_HOST: 'x' })).toMatch(/is set: use --env emulator/);
    expect(checkEmulator('prod', {})).toBeNull();
    const w = world();
    expect(await verifyCommand(['--run', 'r1', '--env', 'dev'], w.io({ env: { FIRESTORE_EMULATOR_HOST: 'x' } }))).toBe(
      1,
    );
    expect(w.closed()).toBe(0);
  });

  it('load, verify, delta and roll back a run, with exit codes for each outcome', async () => {
    const w = world();
    const run = ['--run', 'run-fixture', '--env', 'dev'];
    expect(await loadCommand([...run, '--dry-run'], w.io())).toBe(0);
    expect(w.target.writes).toEqual([]);
    expect(await loadCommand(run, w.io())).toBe(0);
    expect(w.target.get(`orgs/${FIXTURE_ORG}/migrations/run-fixture`)).toMatchObject({ mode: 'rehearsal' });
    // No file was copied into this store, so verify fails on it.
    expect(await verifyCommand(run, w.io())).toBe(5);
    expect(w.out.join('\n')).toMatch(/NOT verified: 0 missing, 0 different, 1 file problems/);
    expect(await rollbackCommand([...run, '--dry-run'], w.io())).toBe(0);
    expect(await rollbackCommand([...run, '--keep-org'], w.io())).toBe(0);
    expect(w.target.get(`orgs/${FIXTURE_ORG}`)).toBeDefined();
    expect(w.closed()).toBe(5);
  });

  it('exit 5 when writes fail, and 1 with "nothing written" when refused', async () => {
    const w = world();
    w.target.failOn.add(`orgs/${FIXTURE_ORG}/contacts/c-mig-quill`);
    expect(await loadCommand(['--run', 'run-fixture', '--env', 'dev'], w.io())).toBe(5);
    const prod = world();
    expect(await loadCommand(['--run', 'run-fixture', '--env', 'prod'], prod.io())).toBe(1);
    expect(prod.err.join('\n')).toMatch(/^Refused, nothing written: Writing to prod needs --confirm-prod/);
    expect(await rollbackCommand(['--run', 'run-fixture', '--env', 'prod'], prod.io())).toBe(1);
    expect(prod.err.join('\n')).toMatch(/Refused, nothing deleted: Deleting from prod needs --confirm-prod/);
    // Confirmed by typing the org's name.
    const ask = async () => 'Rivers Estate Law (Fictional)';
    expect(await loadCommand(['--run', 'run-fixture', '--env', 'prod', '--confirm-prod'], prod.io({ ask }))).toBe(0);
    expect(prod.target.get(`orgs/${FIXTURE_ORG}/migrations/run-fixture`)).toMatchObject({ mode: 'cutover' });
  });

  it('delta refuses a run without the export’s list of paths', async () => {
    const w = world();
    expect(await deltaCommand(['--run', 'run-fixture', '--env', 'dev', '--apply-deletes'], w.io())).toBe(1);
    expect(w.err.join('\n')).toMatch(/Refused, nothing written: .*raw\/paths.jsonl/);
    const files = fixtureRun();
    files.set('raw/paths.jsonl', '');
    const ok = world(files);
    expect(await deltaCommand(['--run', 'run-fixture', '--env', 'dev'], ok.io())).toBe(0);
  });
});

describe('emulatorReadAs', () => {
  it('reads each document through the rules with an unsigned token for the person, and returns the refused', async () => {
    const seen: { url: string; token: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const bearer = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      const [header, payload, signature] = bearer.split('.');
      expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'none', typ: 'JWT' });
      expect(signature).toBe('');
      seen.push({
        url,
        token: JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>,
      });
      return new Response('{}', { status: url.includes('secret') ? 403 : 200 });
    }) as typeof fetch;
    const readAs = emulatorReadAs('127.0.0.1:8080', 'demo-materia', fetcher);
    const paths = Array.from({ length: 25 }, (_, i) => `orgs/o/matters/m${i}`);
    const refused = await readAs('uid-1', { orgId: 'o', role: 'owner' }, [...paths, 'orgs/o/secret/s 1']);
    expect(refused).toEqual(['orgs/o/secret/s 1']);
    expect(seen).toHaveLength(26);
    expect(seen.at(-1)?.url).toBe(
      'http://127.0.0.1:8080/v1/projects/demo-materia/databases/(default)/documents/orgs/o/secret/s%201',
    );
    expect(seen[0]?.token).toMatchObject({
      sub: 'uid-1',
      user_id: 'uid-1',
      aud: 'demo-materia',
      iss: 'https://securetoken.google.com/demo-materia',
      orgId: 'o',
      role: 'owner',
      auth_time: expect.any(Number),
    });
  });
});
