import type { Firestore } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';
import * as z from 'zod';

import { DomainError, PERMISSIONS } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps, type CallableInput } from './callable';
import type { IdempotencyStore } from './idempotency';
import type { LogSink } from './log';
import { FakeClock, fakePorts } from '../ports/fakes';

const REQUEST_ID = '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e';

/** An in-memory idempotency store with the same semantics as the Firestore one. */
function memoryIdempotency(): IdempotencyStore & { records: Map<string, { status: string; result?: unknown }> } {
  const records = new Map<string, { status: string; result?: unknown }>();
  return {
    records,
    async begin(orgId, requestId) {
      const record = records.get(`${orgId}/${requestId}`);
      if (record?.status === 'done') return { replay: true, result: record.result };
      if (record) throw new DomainError('REQUEST_IN_PROGRESS', 'running');
      records.set(`${orgId}/${requestId}`, { status: 'pending' });
      return { replay: false };
    },
    async complete(orgId, requestId, result) {
      records.set(`${orgId}/${requestId}`, { status: 'done', result });
    },
    async abandon(orgId, requestId) {
      records.delete(`${orgId}/${requestId}`);
    },
  };
}

function setup(overrides: Partial<CallableDeps> = {}) {
  const logs: { severity: string; message: string; entry: Record<string, unknown> }[] = [];
  const sink: LogSink = (severity, message, entry) => logs.push({ severity, message, entry });
  const clock = new FakeClock();
  const idempotency = memoryIdempotency();
  const deps: CallableDeps = {
    db: () => ({}) as Firestore,
    clock,
    ports: () => fakePorts({ clock }),
    memberLookup: async (_orgId, uid) => uid !== 'suspended-uid',
    idempotency,
    sink,
    ...overrides,
  };
  return { deps, logs, idempotency, clock };
}

const Input = z.object({ requestId: z.uuid().optional(), message: z.string().min(1) });

const def = (
  over: Partial<CallableDefinition<typeof Input, unknown>> = {},
): CallableDefinition<typeof Input, unknown> => ({
  name: 'test-echo',
  input: Input,
  roles: PERMISSIONS['matter.edit'],
  handler: ({ input, uid, orgId, role, requestId, clock }) => ({
    message: input.message,
    uid,
    orgId,
    role,
    requestId,
    at: clock.now().toISOString(),
  }),
  ...over,
});

const request = (
  data: Record<string, unknown>,
  claims: Record<string, unknown> | null = { orgId: 'org-a', role: 'lawyer' },
  uid = 'lawyer-uid',
): CallableInput => ({
  data,
  auth: claims ? { uid, token: claims } : undefined,
});

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError;
  }
  throw new Error('expected a rejection');
}

const codeOf = (error: HttpsError) => (error.details as { code?: string } | undefined)?.code;

describe('runCallable', () => {
  it('runs the handler with the resolved context', async () => {
    const { deps, logs } = setup();
    const result = await runCallable(def(), request({ message: 'hello' }), deps);
    expect(result).toMatchObject({
      message: 'hello',
      uid: 'lawyer-uid',
      orgId: 'org-a',
      role: 'lawyer',
      at: '2026-03-14T00:00:00.000Z',
    });
    expect(logs.at(-1)).toMatchObject({
      message: 'ok',
      entry: { fn: 'test-echo', orgId: 'org-a', uid: 'lawyer-uid', role: 'lawyer' },
    });
  });

  it('requires authentication', async () => {
    const error = await rejection(runCallable(def(), request({ message: 'x' }, null), setup().deps));
    expect([error.code, codeOf(error)]).toEqual(['unauthenticated', 'UNAUTHENTICATED']);
  });

  it('requires an org and a valid role claim', async () => {
    for (const claims of [{}, { orgId: 'org-a' }, { orgId: 'org-a', role: 'emperor' }, { orgId: '', role: 'owner' }]) {
      const error = await rejection(runCallable(def(), request({ message: 'x' }, claims), setup().deps));
      expect(codeOf(error)).toBe('ORG_CLAIM_MISSING');
    }
  });

  it('flags a stale org claim so the client refreshes and retries', async () => {
    const error = await rejection(runCallable(def(), request({ message: 'x', orgId: 'org-b' }), setup().deps));
    expect([error.code, codeOf(error)]).toEqual(['failed-precondition', 'ORG_CLAIM_MISMATCH']);
  });

  it('denies roles outside the definition', async () => {
    const error = await rejection(
      runCallable(def(), request({ message: 'x' }, { orgId: 'org-a', role: 'readonly' }), setup().deps),
    );
    expect([error.code, codeOf(error)]).toEqual(['permission-denied', 'PERMISSION_DENIED']);
  });

  it('denies a member whose membership is not active', async () => {
    const error = await rejection(
      runCallable(def(), request({ message: 'x' }, undefined, 'suspended-uid'), setup().deps),
    );
    expect(codeOf(error)).toBe('MEMBER_INACTIVE');
  });

  it('rejects invalid input with field paths, after the auth checks', async () => {
    const error = await rejection(runCallable(def(), request({ message: '' }), setup().deps));
    expect(error.code).toBe('invalid-argument');
    expect((error.details as { fields: Record<string, string[]> }).fields).toHaveProperty('message');
  });

  it('idempotent callables need a UUID requestId', async () => {
    for (const data of [{ message: 'x' }, { message: 'x', requestId: 'not-a-uuid' }]) {
      const error = await rejection(runCallable(def({ idempotent: true }), request(data), setup().deps));
      expect(codeOf(error)).toBe(data.requestId ? 'INVALID_ARGUMENT' : 'REQUEST_ID_REQUIRED');
    }
  });

  it('replays the stored result for a repeated requestId', async () => {
    const { deps, clock, logs } = setup();
    const first = await runCallable(
      def({ idempotent: true }),
      request({ message: 'once', requestId: REQUEST_ID }),
      deps,
    );
    clock.advance(60_000);
    const second = await runCallable(
      def({ idempotent: true }),
      request({ message: 'once', requestId: REQUEST_ID }),
      deps,
    );
    expect(second).toEqual(first);
    expect(logs.some((l) => l.message === 'replayed')).toBe(true);
  });

  it('releases the idempotency key when the handler fails, so a retry runs', async () => {
    const { deps, idempotency } = setup();
    let calls = 0;
    const flaky = def({
      idempotent: true,
      handler: () => {
        calls += 1;
        if (calls === 1) throw new DomainError('UNAVAILABLE', 'try again');
        return { ok: true };
      },
    });
    const error = await rejection(runCallable(flaky, request({ message: 'x', requestId: REQUEST_ID }), deps));
    expect(codeOf(error)).toBe('UNAVAILABLE');
    expect(idempotency.records.size).toBe(0);
    await expect(runCallable(flaky, request({ message: 'x', requestId: REQUEST_ID }), deps)).resolves.toEqual({
      ok: true,
    });
  });

  it('maps a thrown DomainError to its HttpsError code', async () => {
    const failing = def({
      handler: () => {
        throw new DomainError('FAILED_PRECONDITION', 'Matter is closed', { matterId: 'm1' });
      },
    });
    const error = await rejection(runCallable(failing, request({ message: 'x' }), setup().deps));
    expect([error.code, error.message, error.details]).toEqual([
      'failed-precondition',
      'Matter is closed',
      { matterId: 'm1', code: 'FAILED_PRECONDITION' },
    ]);
  });

  it('hides unexpected errors behind INTERNAL and logs no personal data', async () => {
    const { deps, logs } = setup();
    const crashing = def({
      handler: () => {
        throw new Error('Crash while saving Margaret Whitfield');
      },
    });
    const error = await rejection(runCallable(crashing, request({ message: 'x' }), deps));
    expect([error.code, error.message, codeOf(error)]).toEqual(['internal', 'Internal error', 'INTERNAL']);
    expect(JSON.stringify(logs)).not.toContain('Whitfield');
    expect(logs.find((l) => l.message === 'unhandled error')?.severity).toBe('error');
  });

  it('validates the output when an output schema is given', async () => {
    const bad = def({ output: z.object({ count: z.number() }), handler: () => ({ count: 'many' }) as never });
    const error = await rejection(runCallable(bad, request({ message: 'x' }), setup().deps));
    expect(error.code).toBe('internal');
    const good = def({ output: z.object({ count: z.number() }), handler: () => ({ count: 2 }) });
    await expect(runCallable(good, request({ message: 'x' }), setup().deps)).resolves.toEqual({ count: 2 });
  });
});
