import type { Firestore } from 'firebase-admin/firestore';
import type { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

import { echo, echoDefinition } from './echo';
import { runCallable, type CallableDeps } from '../core/callable';
import { FakeClock, fakePorts } from '../ports/fakes';

const enqueue = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../core/tasks', () => ({ enqueue }));

const REQUEST_ID = '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e';

const deps = (): CallableDeps => ({
  db: () => ({}) as Firestore,
  clock: new FakeClock(),
  ports: () => fakePorts(),
  memberLookup: async () => true,
  idempotency: {
    begin: async () => ({ replay: false }),
    complete: async () => undefined,
    abandon: async () => undefined,
  },
  sink: () => undefined,
});

const call = (data: Record<string, unknown>) =>
  runCallable(
    echoDefinition,
    { data: { requestId: REQUEST_ID, ...data }, auth: { uid: 'u1', token: { orgId: 'org-a', role: 'paralegal' } } },
    deps(),
  );

describe('system-echo', () => {
  it('echoes the message with the caller context', async () => {
    await expect(call({ message: 'hello' })).resolves.toEqual({
      message: 'hello',
      uid: 'u1',
      orgId: 'org-a',
      role: 'paralegal',
      requestId: REQUEST_ID,
      at: '2026-03-14T00:00:00.000Z',
    });
  });

  it('enqueues a system-recordEcho task when deferred, deduplicated by requestId', async () => {
    await call({ message: 'later', deferred: true });
    expect(enqueue).toHaveBeenCalledWith(
      'system-recordEcho',
      { orgId: 'org-a', requestId: REQUEST_ID },
      { dedupeKey: REQUEST_ID },
    );
  });

  it('maps the test failures', async () => {
    await expect(call({ message: 'x', fail: 'domain' })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'FAILED_PRECONDITION' },
    });
    const crash = (await call({ message: 'x', fail: 'crash' }).catch((e: unknown) => e)) as HttpsError;
    expect([crash.code, crash.message]).toEqual(['internal', 'Internal error']);
  });

  it('the deployed callable rejects anonymous calls before touching Firestore', async () => {
    await expect(echo.run({ data: { message: 'x' } } as unknown as CallableRequest)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
