import { addDebugToken, type AppCheckDebugDeps, removeDebugToken, webAppId } from './app-check-debug.ts';

const NOW = Date.UTC(2026, 9, 8, 0, 0);
const APP_ID = '1:123456789:web:abc123';
const TOKENS = 'https://firebaseappcheck.googleapis.com/v1/projects/123456789/apps/1:123456789:web:abc123/debugTokens';

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeDeps(responses: Record<string, unknown>): { deps: AppCheckDebugDeps; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: init.headers as Record<string, string>,
      ...(init.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    const answer = responses[`${method} ${url}`];
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? {}), { status: answer === undefined ? 404 : 200 });
  }) as typeof globalThis.fetch;
  return { deps: { fetch, token: async () => 'access-token', now: () => NOW }, calls };
}

describe('app-check-debug', () => {
  it('finds the project’s one web app', async () => {
    const { deps, calls } = fakeDeps({
      'GET https://firebase.googleapis.com/v1beta1/projects/materia-v2-dev/webApps': {
        apps: [{ appId: APP_ID, state: 'ACTIVE' }],
      },
    });
    await expect(webAppId('materia-v2-dev', deps)).resolves.toBe(APP_ID);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'x-goog-user-project': 'materia-v2-dev',
    });

    const two = fakeDeps({
      'GET https://firebase.googleapis.com/v1beta1/projects/materia-v2-dev/webApps': {
        apps: [{ appId: APP_ID }, { appId: '1:123456789:web:def' }],
      },
    });
    await expect(webAppId('materia-v2-dev', two.deps)).rejects.toThrow(/found 2/);
  });

  it('registers a new debug token, removing ones a failed run left behind', async () => {
    const { deps, calls } = fakeDeps({
      [`GET ${TOKENS}`]: {
        debugTokens: [
          {
            name: 'projects/123456789/apps/x/debugTokens/old',
            displayName: 'demo-lighthouse earlier',
            updateTime: new Date(NOW - 2 * 3_600_000).toISOString(),
          },
          {
            name: 'projects/123456789/apps/x/debugTokens/running',
            displayName: 'demo-lighthouse now',
            updateTime: new Date(NOW - 60_000).toISOString(),
          },
          {
            name: 'projects/123456789/apps/x/debugTokens/blake',
            displayName: 'Blake’s laptop',
            updateTime: new Date(NOW - 9 * 3_600_000).toISOString(),
          },
        ],
      },
      'DELETE https://firebaseappcheck.googleapis.com/v1/projects/123456789/apps/x/debugTokens/old': {},
      [`POST ${TOKENS}`]: { name: 'projects/123456789/apps/x/debugTokens/new' },
    });
    const debug = await addDebugToken('materia-v2-dev', APP_ID, deps);
    expect(debug.name).toBe('projects/123456789/apps/x/debugTokens/new');
    expect(debug.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls.map((c) => `${c.method} ${c.url.split('/debugTokens')[1] ?? ''}`)).toEqual([
      'GET ',
      'DELETE /old',
      'POST ',
    ]);
    expect(calls[2]?.body).toEqual({ displayName: 'demo-lighthouse 2026-10-08T00:00:00.000Z', token: debug.token });
  });

  it('says what failed without the token, and treats an already removed token as removed', async () => {
    const { deps } = fakeDeps({
      [`GET ${TOKENS}`]: { debugTokens: [] },
      [`POST ${TOKENS}`]: new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }),
    });
    const failure = await addDebugToken('materia-v2-dev', APP_ID, deps).catch((error: Error) => error);
    expect(String(failure)).toMatch(/Registering an App Check debug token failed \(403\): .*PERMISSION_DENIED/);
    await expect(removeDebugToken('materia-v2-dev', 'projects/1/apps/x/debugTokens/gone', deps)).resolves.toBe(
      undefined,
    );
    await expect(addDebugToken('materia-v2-dev', 'not-an-app-id', deps)).rejects.toThrow(/Unexpected Firebase app id/);
  });
});
