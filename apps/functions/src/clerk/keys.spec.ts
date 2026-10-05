import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import { createClerkGateway } from './gateway';
import { anthropicKeyPath, firestoreKeyring, KEY_CACHE_TTL_MS } from './keyring';
import { getApiKeyStatusDefinition, removeApiKeyDefinition, setApiKeyDefinition, setModelDefinition } from './keys';
import { FakeClerkModel } from './providers/fake';
import { MemoryClerkStore } from './testing';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { ClerkModelError } from '../ports';
import { FakeClock, FakeKms, fakePorts } from '../ports/fakes';

const ORG = 'org-byok';
const KEY = 'sk-ant-api03-fictionalKEYvalue0000000000001234';
const OTHER_KEY = 'sk-ant-api03-fictionalKEYvalue000000000000noopus9876';

function world(orgData: Record<string, unknown> = {}) {
  const store = memoryFirestore({ [`orgs/${ORG}`]: { name: 'Fictional BYOK Legal', retentionYears: 7, ...orgData } });
  const clock = new FakeClock(new Date('2026-10-05T00:00:00Z'));
  const model = new FakeClerkModel();
  const kms = new FakeKms();
  const lines: unknown[] = [];
  const results: unknown[] = [];
  const deps: CallableDeps = {
    db: () => store.db,
    clock,
    ports: () => fakePorts({ clerkModel: model, clerkKms: kms, clock }),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async (_orgId, _requestId, result) => void results.push(result),
      abandon: async () => undefined,
    },
    sink: (severity, message, entry) => void lines.push({ severity, message, entry }),
  };
  const recent = () => ({ auth_time: Math.floor(clock.now().getTime() / 1000) });
  const call = <O>(
    def: CallableDefinition<never, O>,
    data: Record<string, unknown>,
    role: Role = 'owner',
    token: Record<string, unknown> = recent(),
  ) =>
    runCallable(
      def as unknown as CallableDefinition<never, O>,
      {
        data: { requestId: randomUUID(), ...data },
        auth: { uid: `u-${role}`, token: { orgId: ORG, role, ...token } },
      },
      deps,
    );
  const doc = (path: string) => store.docs.get(path);
  const audits = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);
  return { store, clock, model, kms, lines, results, call, doc, audits, recent };
}

const def = <O>(d: unknown) => d as CallableDefinition<never, O>;
const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as HttpsError,
  );

beforeEach(() => clearRetentionCache());

describe('clerk-setApiKey', () => {
  it('validates, encrypts and stores the key with last4, and audits without key material', async () => {
    const w = world();
    const result = await w.call(def(setApiKeyDefinition), { apiKey: `  ${KEY.slice(0, 20)}\n${KEY.slice(20)}  ` });
    expect(result).toEqual({ last4: '1234', validatedAt: '2026-10-05T00:00:00.000Z', opusAvailable: true });

    const stored = w.doc(anthropicKeyPath(ORG));
    expect(stored).toMatchObject({ provider: 'anthropic', status: 'valid', last4: '1234', setBy: 'u-owner' });
    expect(stored?.['encryptedApiKey']).toEqual(expect.stringMatching(/^fakekms\./));
    // The KMS round trip, bound to the document path.
    expect(w.kms.calls).toEqual([{ op: 'encrypt', aad: anthropicKeyPath(ORG) }]);
    expect(await w.kms.decrypt(stored?.['encryptedApiKey'] as string, anthropicKeyPath(ORG))).toBe(KEY);

    const [entry] = w.audits();
    expect(entry).toMatchObject({ action: 'clerk.api_key_set', data: { last4: '1234', opusAvailable: true } });

    // Neither the plaintext nor the ciphertext in any log line, response or audit entry.
    const ciphertext = stored?.['encryptedApiKey'] as string;
    for (const leak of [KEY, ciphertext, KEY.slice(7, 30)]) {
      expect(JSON.stringify(w.lines)).not.toContain(leak);
      expect(JSON.stringify(result)).not.toContain(leak);
      expect(JSON.stringify(w.results)).not.toContain(leak);
      expect(JSON.stringify(w.audits())).not.toContain(leak);
    }
  });

  it('never saves a key Anthropic rejects (CLERK_KEY_INVALID) or can’t check (CLERK_UNAVAILABLE)', async () => {
    const w = world();
    const invalid = await errorOf(
      w.call(def(setApiKeyDefinition), { apiKey: 'sk-ant-api03-fictional-invalid-0000000000' }),
    );
    expect(invalid?.details).toMatchObject({ code: 'CLERK_KEY_INVALID' });
    expect(invalid?.code).toBe('failed-precondition');
    const down = await errorOf(
      w.call(def(setApiKeyDefinition), { apiKey: 'sk-ant-api03-fictional-unreachable-00000' }),
    );
    expect(down?.details).toMatchObject({ code: 'CLERK_UNAVAILABLE' });
    expect(w.doc(anthropicKeyPath(ORG))).toBeUndefined();
    expect(JSON.stringify(w.lines)).not.toContain('fictional-invalid');
  });

  it('rejects anything that doesn’t look like an Anthropic key before calling the API', async () => {
    const w = world();
    const spy = vi.spyOn(w.model, 'listModels');
    for (const apiKey of ['sk-proj-notanthropic000000000000000', 'sk-ant-short', 'hello world']) {
      const error = await errorOf(w.call(def(setApiKeyDefinition), { apiKey }));
      expect(error?.details).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(JSON.stringify(error)).not.toContain(apiKey.replace(/\s/g, ''));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('needs an owner or admin with a sign-in in the last five minutes', async () => {
    const w = world();
    for (const role of ['lawyer', 'paralegal', 'readonly'] as const) {
      const error = await errorOf(w.call(def(setApiKeyDefinition), { apiKey: KEY }, role));
      expect(error?.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(await w.call(def(setApiKeyDefinition), { apiKey: KEY }, 'admin')).toMatchObject({ last4: '1234' });
    const stale = { auth_time: Math.floor(w.clock.now().getTime() / 1000) - 6 * 60 };
    const error = await errorOf(w.call(def(setApiKeyDefinition), { apiKey: KEY }, 'owner', stale));
    expect(error?.details).toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('last write wins: both saves are audited and the gateway reads the latest', async () => {
    const w = world();
    await w.call(def(setApiKeyDefinition), { apiKey: KEY }, 'owner');
    await w.call(def(setApiKeyDefinition), { apiKey: OTHER_KEY }, 'admin');
    expect(w.doc(anthropicKeyPath(ORG))).toMatchObject({ last4: '9876', setBy: 'u-admin' });
    expect(w.audits().map((entry) => entry['action'])).toEqual(['clerk.api_key_set', 'clerk.api_key_set']);
    const key = await firestoreKeyring(w.store.db, w.kms).resolve(ORG);
    expect(key).toMatchObject({ state: 'ok', apiKey: OTHER_KEY });
  });

  it('moves the org back to Sonnet 5.5 when the new key can’t see Opus 5.5', async () => {
    const w = world({ settings: { clerk: { model: 'claude-opus-5-5' } } });
    const result = await w.call(def(setApiKeyDefinition), { apiKey: OTHER_KEY });
    expect(result).toMatchObject({ opusAvailable: false, modelReset: true });
    expect(w.doc(`orgs/${ORG}`)).toMatchObject({ settings: { clerk: { model: 'claude-sonnet-5-5' } } });
  });
});

describe('clerk-removeApiKey, clerk-setModel and clerk-getApiKeyStatus', () => {
  it('removes the key and audits it; a second remove is a no-op', async () => {
    const w = world();
    await w.call(def(setApiKeyDefinition), { apiKey: KEY });
    expect(await w.call(def(removeApiKeyDefinition), {})).toEqual({ removed: true });
    expect(w.doc(anthropicKeyPath(ORG))).toBeUndefined();
    expect(w.audits().at(-1)).toMatchObject({ action: 'clerk.api_key_removed', data: { last4: '1234' } });
    expect(await w.call(def(removeApiKeyDefinition), {})).toEqual({ removed: false });
    const error = await errorOf(w.call(def(removeApiKeyDefinition), {}, 'lawyer'));
    expect(error?.details).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('shows owners and admins the status, never the key; lawyers can’t read it', async () => {
    const w = world();
    expect(await w.call(def(getApiKeyStatusDefinition), {})).toEqual({ set: false, model: 'claude-sonnet-5-5' });
    await w.call(def(setApiKeyDefinition), { apiKey: KEY });
    const status = await w.call(def(getApiKeyStatusDefinition), {}, 'admin');
    expect(status).toEqual({
      set: true,
      status: 'valid',
      last4: '1234',
      setAt: '2026-10-05T00:00:00.000Z',
      validatedAt: '2026-10-05T00:00:00.000Z',
      opusAvailable: true,
      model: 'claude-sonnet-5-5',
    });
    expect(JSON.stringify(status)).not.toContain('fakekms');
    const error = await errorOf(w.call(def(getApiKeyStatusDefinition), {}, 'lawyer'));
    expect(error?.details).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('switches the model, audits real changes and refuses Opus for a key without it', async () => {
    const w = world();
    expect(await w.call(def(setModelDefinition), { model: 'claude-opus-5-5' })).toEqual({ model: 'claude-opus-5-5' });
    expect(w.doc(`orgs/${ORG}`)).toMatchObject({ settings: { clerk: { model: 'claude-opus-5-5' } } });
    expect(w.audits()).toEqual([
      expect.objectContaining({
        action: 'clerk.model_changed',
        data: { from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' },
      }),
    ]);
    await w.call(def(setModelDefinition), { model: 'claude-opus-5-5' });
    expect(w.audits()).toHaveLength(1);

    await w.call(def(setApiKeyDefinition), { apiKey: OTHER_KEY });
    const refused = await errorOf(w.call(def(setModelDefinition), { model: 'claude-opus-5-5' }));
    expect(refused?.details).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'opus_unavailable' });
    const lawyer = await errorOf(w.call(def(setModelDefinition), { model: 'claude-sonnet-5-5' }, 'lawyer'));
    expect(lawyer?.details).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('firestoreKeyring', () => {
  it('decrypts once per key version, picks up a rotated key at once and marks only that version invalid', async () => {
    const w = world();
    let now = 0;
    const keyring = firestoreKeyring(w.store.db, w.kms, () => now);
    expect(await keyring.resolve(ORG)).toEqual({ state: 'missing' });
    await w.call(def(setApiKeyDefinition), { apiKey: KEY });
    const first = await keyring.resolve(ORG);
    await keyring.resolve(ORG);
    expect(w.kms.calls.filter((c) => c.op === 'decrypt')).toHaveLength(1);
    now += KEY_CACHE_TTL_MS + 1;
    await keyring.resolve(ORG);
    expect(w.kms.calls.filter((c) => c.op === 'decrypt')).toHaveLength(2);

    await w.call(def(setApiKeyDefinition), { apiKey: OTHER_KEY });
    const second = await keyring.resolve(ORG);
    expect(second).toMatchObject({ state: 'ok', apiKey: OTHER_KEY });
    // The old key's rejection (a call that started before the rotation) leaves the new key alone.
    await keyring.markInvalid(ORG, (first as { version: string }).version, w.clock.now());
    expect(w.doc(anthropicKeyPath(ORG))?.['status']).toBe('valid');
    await keyring.markInvalid(ORG, (second as { version: string }).version, w.clock.now());
    expect(w.doc(anthropicKeyPath(ORG))?.['status']).toBe('invalid');
    expect(await keyring.resolve(ORG)).toEqual({ state: 'invalid' });
  });

  it('feeds the gateway: a rejected stored key gives CLERK_KEY_INVALID and marks the integration invalid', async () => {
    const w = world({ flags: { 'clerk.enabled': true } });
    await w.call(def(setApiKeyDefinition), { apiKey: KEY });
    const model = new FakeClerkModel([{ error: new ClerkModelError('auth', 'rejected', 401) }]);
    const gateway = createClerkGateway({
      model,
      store: new MemoryClerkStore(),
      keyring: firestoreKeyring(w.store.db, w.kms),
      flag: async () => true,
      sleep: async () => undefined,
    });
    const log = createLog({ fn: 'test' }, () => undefined);
    await expect(
      gateway.run({
        ctx: { orgId: ORG, uid: 'u-lawyer', role: 'lawyer', requestId: 'r', log, clock: w.clock },
        feature: 'hello',
        promptId: 'hello',
        vars: { name: 'the team', promptRef: 'hello@1.0.0' },
      }),
    ).rejects.toMatchObject({ code: 'CLERK_KEY_INVALID' });
    expect(model.requests[0]?.credentials).toEqual({ orgId: ORG, apiKey: KEY });
    expect(w.doc(anthropicKeyPath(ORG))).toMatchObject({ status: 'invalid' });
    expect(await w.call(def(getApiKeyStatusDefinition), {})).toMatchObject({ set: true, status: 'invalid' });
  });
});
