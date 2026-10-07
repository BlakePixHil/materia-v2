import {
  FILES_BUCKET,
  LEGACY_FILES,
  RUN_BUCKET,
  TARGET_PROJECT,
  formatChecks,
  preflightCommand,
  runPreflight,
} from './preflight.ts';
import type { PreflightDeps } from './preflight.ts';

const READER = 'legacy-migration-reader@matt-r-1fe15.iam.gserviceaccount.com';
const RUNNER = 'migration-runner@materia-v2-prod.iam.gserviceaccount.com';

interface Call {
  url: string;
  method: string;
  token: string;
  body?: { permissions?: string[] };
}

/**
 * A fake Google API: `grants` maps a token to the permissions it holds per resource (a bucket name,
 * a service account email, a project id, or `clamav`). Resources not listed answer 404.
 */
function fakeApis(grants: Record<string, Record<string, readonly string[]>>, providers = ['google.com']) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const body = init?.body ? (JSON.parse(String(init.body)) as { permissions?: string[] }) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', token, ...(body ? { body } : {}) });
    const mine = grants[token] ?? {};
    const answer = (resource: string, asked: readonly string[]) => {
      const granted = mine[resource];
      if (!granted) return new Response('not found', { status: 404 });
      return Response.json({ permissions: asked.filter((p) => granted.includes(p)) });
    };
    const bucket = /\/storage\/v1\/b\/([^/]+)\/iam\/testPermissions\?(.*)$/.exec(url);
    if (bucket) {
      const asked = new URLSearchParams(bucket[2]).getAll('permissions');
      return answer(decodeURIComponent(bucket[1] ?? ''), asked);
    }
    const asked = body?.permissions ?? [];
    const account = /serviceAccounts\/([^:]+):testIamPermissions$/.exec(url);
    if (account) return answer(account[1] ?? '', asked);
    if (url.endsWith('/services/clamav:testIamPermissions')) return answer('clamav', asked);
    const project = /cloudresourcemanager.googleapis.com\/v1\/projects\/([^:]+):testIamPermissions$/.exec(url);
    if (project) return answer(project[1] ?? '', asked);
    if (url.includes('/defaultSupportedIdpConfigs')) {
      return Response.json({
        defaultSupportedIdpConfigs: providers.map((id) => ({
          name: `projects/1/defaultSupportedIdpConfigs/${id}`,
          enabled: true,
        })),
      });
    }
    if (url.endsWith('/config') || url.includes('/oauthIdpConfigs')) return Response.json({});
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const tokens = (fetchImpl: typeof fetch, writer = 'operator'): PreflightDeps => ({
  fetch: fetchImpl,
  operator: async () => 'operator',
  writer: async () => writer,
  reader: async () => 'reader',
});

/** What a ready dev rehearsal holds: the operator does everything, the reader only reads. */
const READY_DEV = {
  operator: {
    [READER]: ['iam.serviceAccounts.getAccessToken'],
    'materia-v2-dev-migration': RUN_BUCKET,
    'matt-r-1fe15.firebasestorage.app': LEGACY_FILES,
    'materia-v2-dev-files': FILES_BUCKET,
    clamav: ['run.routes.invoke'],
    'materia-v2-dev': TARGET_PROJECT,
  },
  reader: {
    'matt-r-1fe15': [
      'datastore.entities.get',
      'datastore.entities.list',
      'storage.objects.get',
      'storage.objects.list',
      'firebaseauth.users.get',
    ],
    'matt-r-1fe15.firebasestorage.app': [],
  },
};

describe('runPreflight', () => {
  it('passes when every account holds what its steps need, and only asks IAM', async () => {
    const apis = fakeApis(READY_DEV);
    const checks = await runPreflight(tokens(apis.fetch), { env: 'dev' });
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ['act as the legacy reader', true],
      ['legacy reader is read-only', true],
      ['write the run', true],
      ['read the legacy files', true],
      ['write the files', true],
      ['call the scanner', true],
      ['import the account and load', true],
      ['Google sign-in', true],
    ]);
    // Nothing but permission tests and the sign-in config: no record, file or account is read.
    for (const call of apis.calls) {
      expect(call.url).toMatch(
        /testIamPermissions|\/iam\/testPermissions\?|identitytoolkit\.googleapis\.com\/admin\/v2\/projects\/materia-v2-dev\//,
      );
    }
    // The legacy project is only ever asked with the reader's token.
    const legacy = apis.calls.filter((call) => call.url.includes('projects/matt-r-1fe15:'));
    expect(legacy.map((call) => call.token)).toEqual(['reader']);
  });

  it('names what is missing and how to grant it, and keeps going after a failure', async () => {
    const apis = fakeApis(
      {
        operator: {
          ...READY_DEV.operator,
          'matt-r-1fe15.firebasestorage.app': [],
          'materia-v2-dev-files': ['storage.objects.get', 'storage.objects.list'],
        },
        reader: READY_DEV.reader,
      },
      [],
    );
    const checks = await runPreflight(tokens(apis.fetch), { env: 'dev' });
    const failed = checks.filter((check) => !check.ok);
    expect(failed.map((check) => check.name)).toEqual(['read the legacy files', 'write the files', 'Google sign-in']);
    expect(failed[0]?.detail).toContain(
      'lacks storage.objects.get, storage.objects.list on matt-r-1fe15.firebasestorage.app',
    );
    expect(failed[0]?.detail).toContain('roles/storage.objectViewer');
    expect(failed[1]?.detail).toContain('lacks storage.objects.create, storage.objects.delete, storage.objects.update');
    expect(failed[2]?.detail).toContain('Google sign-in is off in materia-v2-dev');
    expect(failed.every((check) => !check.later)).toBe(true);
  });

  it('fails when the legacy reader could write, and skips its check when it can’t be impersonated', async () => {
    const writes = fakeApis({
      operator: READY_DEV.operator,
      reader: {
        ...READY_DEV.reader,
        'matt-r-1fe15': [...READY_DEV.reader['matt-r-1fe15'], 'datastore.entities.update'],
      },
    });
    const readOnly = (await runPreflight(tokens(writes.fetch), { env: 'dev' })).find(
      (check) => check.name === 'legacy reader is read-only',
    );
    expect(readOnly).toMatchObject({ ok: false });
    expect(readOnly?.detail).toContain('it can write (datastore.entities.update)');

    const noImpersonation = fakeApis({ operator: { ...READY_DEV.operator, [READER]: [] }, reader: READY_DEV.reader });
    const checks = await runPreflight(tokens(noImpersonation.fetch), { env: 'dev' });
    expect(checks[0]).toMatchObject({ name: 'act as the legacy reader', ok: false });
    expect(checks.some((check) => check.name === 'legacy reader is read-only')).toBe(false);
    expect(noImpersonation.calls.some((call) => call.token === 'reader')).toBe(false);
  });

  it('checks prod as the runner, and leaves the legacy bucket grant for the cutover', async () => {
    const apis = fakeApis({
      operator: {
        [RUNNER]: ['iam.serviceAccounts.getAccessToken'],
        [READER]: ['iam.serviceAccounts.getAccessToken'],
        clamav: ['run.routes.invoke'],
        'materia-v2-prod': TARGET_PROJECT,
        'materia-v2-prod-migration': RUN_BUCKET,
        'materia-v2-prod-files': ['storage.objects.get', 'storage.objects.list'],
      },
      runner: {
        'materia-v2-prod-migration': RUN_BUCKET,
        'materia-v2-prod-files': FILES_BUCKET,
        'matt-r-1fe15.firebasestorage.app': [],
      },
      reader: READY_DEV.reader,
    });
    const checks = await runPreflight(tokens(apis.fetch, 'runner'), { env: 'prod', writerAccount: RUNNER });
    expect(checks[0]).toMatchObject({ name: 'act as the writer', ok: true });
    const legacy = checks.find((check) => check.name === 'read the legacy files');
    expect(legacy).toMatchObject({ ok: false, later: 'the cutover copy' });
    expect(legacy?.detail).toContain(RUNNER);
    // The load and the rollback use the run and the files as you, not as the runner.
    expect(checks.filter((check) => !check.ok && !check.later)).toEqual([
      expect.objectContaining({
        name: 'roll back the files',
        detail: expect.stringContaining(
          'your account lacks storage.objects.create, storage.objects.delete, storage.objects.update on materia-v2-prod-files',
        ),
      }),
    ]);
    expect(checks.find((check) => check.name === 'load and roll back the run')).toMatchObject({ ok: true });
    expect(formatChecks(checks).find((line) => line.includes('read the legacy files'))).toMatch(
      /^· .*\(needed for the cutover copy\)$/,
    );
  });

  it('reports a missing resource or an API error as a failed check', async () => {
    const noScanner = Object.fromEntries(
      Object.entries(READY_DEV.operator).filter(([resource]) => resource !== 'clamav'),
    );
    const apis = fakeApis({ operator: noScanner, reader: READY_DEV.reader });
    const checks = await runPreflight(tokens(apis.fetch), { env: 'dev' });
    expect(checks.find((check) => check.name === 'call the scanner')?.detail).toBe(
      "clamav (materia-v2-dev) doesn't exist",
    );
    const loggedOut = async () => Promise.reject(new Error('gcloud: not logged in'));
    const broken = await runPreflight(
      { ...tokens(apis.fetch), operator: loggedOut, writer: loggedOut },
      { env: 'dev' },
    );
    expect(broken.every((check) => !check.ok)).toBe(true);
    expect(broken[0]?.detail).toContain('gcloud: not logged in');
  });
});

describe('preflightCommand', () => {
  const run = async (argv: string[], grants: Parameters<typeof fakeApis>[0]) => {
    const out: string[] = [];
    const err: string[] = [];
    const apis = fakeApis(grants);
    const code = await preflightCommand(
      argv,
      (line) => out.push(line),
      (line) => err.push(line),
      ({ writer }) => tokens(apis.fetch, writer ? 'runner' : 'operator'),
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('exits 0 when ready, 5 when a check fails, and 1 without an environment', async () => {
    const ready = await run(['--env', 'dev'], READY_DEV);
    expect(ready.code).toBe(0);
    expect(ready.out).toContain('Ready: every step can run against materia-v2-dev.');

    const failing = await run(['--env', 'dev'], { operator: {}, reader: {} });
    expect(failing.code).toBe(5);
    expect(failing.err).toMatch(/\d+ of \d+ checks failed/);

    expect((await run([], READY_DEV)).code).toBe(1);
    expect((await run(['--env', 'staging'], READY_DEV)).code).toBe(1);
    expect((await run(['--help'], READY_DEV)).code).toBe(0);
  });
});
