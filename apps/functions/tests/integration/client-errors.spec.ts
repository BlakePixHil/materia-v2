import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';

/**
 * FND-21: `system-logClientError` through the emulators. A browser session may report 20 errors a
 * minute; the server enforces it across calls (Firestore `clientErrorLimits/{session}`), so a
 * client that ignores its own limit is still capped.
 */
const PROJECT_ID = 'demo-materia';

let client: FirebaseApp;

// Fictional data only.
const report = (i: number) => ({
  message: `TypeError: Failed to render for jo.bloggs@example.test (${i})`,
  stack: `TypeError: boom\n    at x (http://127.0.0.1:5000/chunk-A.js:1:${i + 100})`,
  route: '/matters/m-1?q=Bloggs',
  version: '0.0.0-dev+0000000',
  userAgent: 'integration-test',
});

const logClientError = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, { accepted: number; dropped: number }>(
    getFunctions(client, 'australia-southeast1'),
    'system-logClientError',
  )(data).then((r) => r.data);

beforeAll(() => {
  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'client-errors-client');
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await deleteApp(client);
});

describe('system-logClientError through the emulators', () => {
  it('accepts reports from a signed-out session and caps each session at 20 a minute', async () => {
    const sessionId = randomUUID();
    const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => report(from + i));
    // Two calls inside one minute (the window could roll over between them; then both fit).
    const first = await logClientError({ sessionId, errors: batch(0, 15) });
    const second = await logClientError({ sessionId, errors: batch(15, 15) });
    expect(first).toEqual({ accepted: 15, dropped: 0 });
    if (second.accepted !== 15) expect(second).toEqual({ accepted: 5, dropped: 10 });
    // Another session has its own allowance.
    await expect(logClientError({ sessionId: randomUUID(), errors: batch(0, 1) })).resolves.toEqual({
      accepted: 1,
      dropped: 0,
    });
  });

  it('rejects a batch over the limit or without a session', async () => {
    const error = (await logClientError({
      sessionId: randomUUID(),
      errors: Array.from({ length: 21 }, (_, i) => report(i)),
    }).catch((e: unknown) => e)) as FunctionsError;
    expect(error.code).toBe('functions/invalid-argument');
    await expect(logClientError({ errors: [report(0)] })).rejects.toMatchObject({ code: 'functions/invalid-argument' });
  });
});
