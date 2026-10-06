import { DomainError } from '@materia/domain';

import { CallableClient, type CallableTransport } from './callable-client';

/** A transport that fails with the queued errors, then succeeds; it records every payload. */
function transport(...failures: unknown[]) {
  const calls: { name: string; data: Record<string, unknown> }[] = [];
  let refreshes = 0;
  const port: CallableTransport = {
    async call<T>(name: string, data: unknown): Promise<T> {
      calls.push({ name, data: data as Record<string, unknown> });
      const failure = failures.shift();
      if (failure) throw failure;
      return { ok: true } as T;
    },
    async refreshClaims() {
      refreshes++;
    },
  };
  return { port, calls, refreshes: () => refreshes };
}

const unavailable = { code: 'functions/unavailable', message: 'down' };
const inProgress = { code: 'functions/aborted', details: { code: 'REQUEST_IN_PROGRESS' } };
const mismatch = { code: 'functions/failed-precondition', details: { code: 'ORG_CLAIM_MISMATCH' } };
let ids = 0;
const options = { newId: () => `req-${++ids}`, delay: async () => undefined };

describe('CallableClient', () => {
  beforeEach(() => (ids = 0));

  it('retries a transient failure with the same requestId', async () => {
    const t = transport(unavailable, inProgress);
    const client = new CallableClient(t.port, options);
    await expect(client.call('matters-archive', { matterId: 'm1' }, { idempotent: true })).resolves.toEqual({
      ok: true,
    });
    expect(t.calls.map((c) => c.data)).toEqual([
      { matterId: 'm1', requestId: 'req-1' },
      { matterId: 'm1', requestId: 'req-1' },
      { matterId: 'm1', requestId: 'req-1' },
    ]);
  });

  it('gives up after its retries and reports a DomainError', async () => {
    const t = transport(unavailable, unavailable, unavailable);
    const client = new CallableClient(t.port, { ...options, retries: 2 });
    const error = await client.call('x', {}, { idempotent: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('UNAVAILABLE');
    expect(t.calls).toHaveLength(3);
  });

  it('never retries a non-idempotent call on a transient failure, and sends no requestId', async () => {
    const t = transport(unavailable);
    const client = new CallableClient(t.port, options);
    await expect(client.call('x', { a: 1 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(t.calls).toEqual([{ name: 'x', data: { a: 1 } }]);
  });

  it('asks the person to confirm it’s them once on REAUTH_REQUIRED, then retries with the same requestId', async () => {
    const reauth = { code: 'functions/unauthenticated', details: { code: 'REAUTH_REQUIRED' } };
    const t = transport(reauth);
    const prompts: boolean[] = [];
    const port = { ...t.port, reauthenticate: async () => (prompts.push(true), true) };
    await new CallableClient(port, options).call('orgs-changeRole', { uid: 'u1' }, { idempotent: true });
    expect(prompts).toHaveLength(1);
    expect(t.calls.map((c) => c.data['requestId'])).toEqual(['req-1', 'req-1']);

    const cancelled = transport(reauth);
    const cancelPort = { ...cancelled.port, reauthenticate: async () => false };
    await expect(new CallableClient(cancelPort, options).call('x', {})).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    expect(cancelled.calls).toHaveLength(1);

    const twice = transport(reauth, reauth);
    const twicePort = { ...twice.port, reauthenticate: async () => true };
    await expect(new CallableClient(twicePort, options).call('x', {})).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
  });

  it('refreshes the claims once on ORG_CLAIM_MISMATCH and retries with the same requestId', async () => {
    const t = transport(mismatch);
    const client = new CallableClient(t.port, options);
    await client.call('orgs-inviteMember', { email: 'e@example.test' }, { idempotent: true });
    expect(t.refreshes()).toBe(1);
    expect(t.calls.map((c) => c.data['requestId'])).toEqual(['req-1', 'req-1']);

    const twice = transport(mismatch, mismatch);
    await expect(new CallableClient(twice.port, options).call('x', {})).rejects.toMatchObject({
      code: 'ORG_CLAIM_MISMATCH',
    });
    expect(twice.refreshes()).toBe(1);
  });

  it('maps HttpsError details to DomainError codes', async () => {
    const t = transport({ code: 'functions/failed-precondition', details: { code: 'LAST_OWNER' } });
    await expect(new CallableClient(t.port, options).call('x', {})).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  it('an action re-uses its requestId when the person retries, and starts a new one after success', async () => {
    const t = transport({ code: 'functions/internal' });
    const client = new CallableClient(t.port, options);
    const archive = client.action<{ matterId: string }, { ok: boolean }>('matters-archive');
    await expect(archive.run({ matterId: 'm1' })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(archive.error()?.code).toBe('INTERNAL');
    expect(archive.requestId()).toBe('req-1');
    const pending = archive.run({ matterId: 'm1' });
    expect(archive.pending()).toBe(true);
    expect(client.busy()).toBe(true);
    await pending;
    expect(archive.pending()).toBe(false);
    expect(archive.error()).toBeNull();
    expect(t.calls.map((c) => c.data['requestId'])).toEqual(['req-1', 'req-1']);
    expect(archive.requestId()).toBeNull();
    await archive.run({ matterId: 'm2' });
    expect(t.calls.at(-1)?.data['requestId']).toBe('req-2');
    archive.reset();
    expect(archive.requestId()).toBeNull();
  });

  it('defaults to random UUIDs and real backoff', async () => {
    vi.useFakeTimers();
    try {
      const t = transport(unavailable);
      const done = new CallableClient(t.port).call('x', {}, { idempotent: true });
      await vi.advanceTimersByTimeAsync(300);
      await done;
      expect(t.calls[0]?.data['requestId']).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.calls[1]?.data['requestId']).toBe(t.calls[0]?.data['requestId']);
    } finally {
      vi.useRealTimers();
    }
  });
});
