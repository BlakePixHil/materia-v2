import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REQUIRED_READS } from './audit/iam.ts';
import { auditCommand, checkProfileCommand, runAudit, tokenSource, type AuditDeps } from './audit.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from './legacy/fixtures.ts';
import { memoryReader, type LegacyReader } from './legacy/reader.ts';
import type { IamTester } from './legacy/rest.ts';

const { docs, objects } = loadLegacyFixtures();

function grants(project: string[], bucket: string[] = []): IamTester {
  return {
    project: async (asked) => asked.filter((p) => project.includes(p)),
    bucket: async (asked) => asked.filter((p) => bucket.includes(p)),
  };
}

function deps(iam: IamTester, reader: LegacyReader = memoryReader(docs, objects)) {
  const written = new Map<string, string>();
  const reads: string[] = [];
  const spied: LegacyReader = {
    get: (path) => (reads.push(path), reader.get(path)),
    list: (path) => (reads.push(path), reader.list(path)),
    query: (...args) => (reads.push(args[0]), reader.query(...args)),
    objects: (prefix) => (reads.push(prefix), reader.objects(prefix)),
    authUser: async () => ({
      found: true,
      providers: ['google.com'],
      hasPassword: false,
      mfaEnrolled: false,
      disabled: false,
      emailVerified: true,
    }),
  };
  const auditDeps: AuditDeps = {
    reader: spied,
    iam,
    write: async (path, content) => void written.set(path, content),
    now: () => new Date('2026-10-06T09:00:00Z'),
    log: () => undefined,
  };
  return { auditDeps, written, reads };
}

const args = { uid: FIXTURE_UIDS.subject, out: 'out', project: 'legacy-p', bucket: 'legacy-b' };

describe('runAudit', () => {
  it('refuses write-capable credentials before reading anything', async () => {
    const { auditDeps, written, reads } = deps(grants([...REQUIRED_READS, 'datastore.entities.delete']));
    await expect(runAudit(args, auditDeps)).rejects.toThrow(/Refusing to audit/);
    expect(reads).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('writes the JSON and Markdown reports with read-only credentials', async () => {
    const { auditDeps, written } = deps(grants([...REQUIRED_READS, 'firebaseauth.users.get']));
    const report = await runAudit(args, auditDeps);
    expect([...written.keys()]).toEqual([join('out', 'audit-report.json'), join('out', 'audit-report.md')]);
    expect(JSON.parse(written.get(join('out', 'audit-report.json')) ?? '')).toEqual(report);
    expect(report.generatedAt).toBe('2026-10-06T09:00:00.000Z');
    expect(report.source.readOnly?.writes).toEqual([]);
    expect(report.auth?.providers).toEqual(['google.com']);
  });

  it('skips Auth when the credentials cannot read it', async () => {
    const { auditDeps } = deps(grants([...REQUIRED_READS]));
    expect((await runAudit(args, auditDeps)).auth).toBeNull();
  });
});

describe('auditCommand', () => {
  const quiet = { log: () => undefined, error: () => undefined };
  afterEach(() => vi.unstubAllGlobals());

  it('prints help, and needs a uid', async () => {
    expect(await auditCommand(['--help'], quiet.log, quiet.error)).toBe(0);
    expect(await auditCommand([], quiet.log, quiet.error)).toBe(1);
  });

  it('exits 3 when IAM says the credentials can write (a fake IAM response)', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      asked.push(url);
      const body = init.body ? (JSON.parse(String(init.body)) as { permissions: string[] }) : undefined;
      return new Response(JSON.stringify({ permissions: body?.permissions ?? [] }), { status: 200 });
    });
    vi.stubEnv('MIGRATION_ACCESS_TOKEN', 'fake');
    const errors: string[] = [];
    expect(
      await auditCommand(['--uid', 'u1', '--project', 'p', '--bucket', 'b'], quiet.log, (e) => errors.push(e)),
    ).toBe(3);
    expect(errors[0]).toMatch(/Refusing to audit: these credentials can write/);
    expect(asked.every((url) => url.includes('testIamPermissions') || url.includes('/iam/testPermissions'))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('tokenSource', () => {
  it('uses MIGRATION_ACCESS_TOKEN when it is set', async () => {
    expect(await tokenSource({ adc: false, impersonate: 'x' }, { MIGRATION_ACCESS_TOKEN: 'from-env' })()).toBe(
      'from-env',
    );
  });
});

describe('checkProfileCommand', () => {
  const profile = `${FIXTURE_DIR}mapping-profile.json`;
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);

  it('validates a profile on its own', async () => {
    expect(await checkProfileCommand(['--profile', profile], log, log)).toBe(0);
    expect(await checkProfileCommand([], log, log)).toBe(1);
    expect(await checkProfileCommand(['--help'], log, log)).toBe(0);
  });

  it('checks a profile against an audit report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-01-'));
    const { auditDeps, written } = deps(grants([...REQUIRED_READS]));
    await runAudit(args, auditDeps);
    const reportPath = join(dir, 'audit-report.json');
    await writeFile(reportPath, written.get(join('out', 'audit-report.json')) ?? '');
    expect(await checkProfileCommand(['--profile', profile, '--report', reportPath], log, log)).toBe(0);

    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.workflows[0].swimlanes.push({ id: 'new', title: 'A new column' });
    await writeFile(reportPath, JSON.stringify(report));
    lines.length = 0;
    expect(await checkProfileCommand(['--profile', profile, '--report', reportPath], log, log)).toBe(1);
    expect(lines.join('\n')).toContain('no mapping for swimlane "Wills & powers" › "A new column"');
  });

  it('rejects an invalid profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-01-'));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ version: 1 }));
    lines.length = 0;
    expect(await checkProfileCommand(['--profile', bad], log, log)).toBe(1);
    expect(lines[0]).toContain('is not a valid mapping profile');
  });
});
