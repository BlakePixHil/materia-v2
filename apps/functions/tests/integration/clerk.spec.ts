import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { CLERK_DISCLOSURE_VERSION, type FlagKey, type Role } from '@materia/domain';

import { meteringPeriod } from '../../src/clerk/features';
import { firestoreClerkStore } from '../../src/clerk/firestore-store';
import { createClerkGateway, type ClerkRunInput } from '../../src/clerk/gateway';
import { anthropicKeyPath, firestoreKeyring } from '../../src/clerk/keyring';
import { FakeClerkModel, type FakeStep } from '../../src/clerk/providers/fake';
import { createLog } from '../../src/core/log';
import { ClerkModelError } from '../../src/ports';
import { FakeKms } from '../../src/ports/fakes';

/**
 * AI-02 acceptance tests through the emulators, against the fake model (fictional data only):
 * the gateway with its real Firestore store (stream, stop, refusal, truncation, invalid output,
 * rate limit, budget, kill switch, fallback, metering), and `clerk-hello` end to end.
 */
const PROJECT_ID = 'demo-materia';
const PASSWORD = 'fictional-password-1';
const ORG = 'org-clerk-gw';
const HELLO_ORG = 'org-clerk-hello';
const OFF_ORG = 'org-clerk-off';
const UID = 'clerk-lawyer';
/** The org default (AI-02a): Sonnet 5.5. */
const CLERK_MODEL = 'claude-sonnet-5-5';
/** A fictional Anthropic key; the emulator's fake model accepts it (AI-02a). */
const ORG_KEY = 'sk-ant-api03-fictional-integration-key-0000';
/** The emulator's fake KMS is deterministic, so tests can seal keys the functions can open. */
const kms = new FakeKms();
const HELLO_JSON = JSON.stringify({ greeting: 'Hello there.', promptRef: 'hello@1.0.0' });

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const clock = { now: () => new Date() };
const log = createLog({ fn: 'clerk-integration' }, () => undefined);

function gatewayWith(script: FakeStep[], flags: Partial<Record<FlagKey, boolean>> = { 'clerk.enabled': true }) {
  const model = new FakeClerkModel(script);
  const gateway = createClerkGateway({
    model,
    store: firestoreClerkStore(db),
    keyring: firestoreKeyring(db, kms),
    flag: async (_orgId, key) => flags[key] ?? false,
    sleep: async () => undefined,
  });
  return { model, gateway };
}

const input = (over: Partial<ClerkRunInput> = {}): ClerkRunInput => ({
  ctx: { orgId: ORG, uid: UID, role: 'lawyer', requestId: randomUUID(), log, clock },
  feature: 'hello',
  promptId: 'hello',
  vars: { name: 'the team', promptRef: 'hello@1.0.0' },
  ...over,
});

async function newThread(orgId = ORG): Promise<{ threadId: string; messageId: string }> {
  const at = new Date();
  const thread = db.collection(`orgs/${orgId}/clerkThreads`).doc();
  await thread.set({
    title: 'Test thread',
    ownerUid: UID,
    matterId: null,
    shared: false,
    createdAt: at,
    createdBy: UID,
    updatedAt: at,
    updatedBy: UID,
    schemaVersion: 1,
  });
  return { threadId: thread.id, messageId: thread.collection('messages').doc().id };
}

const message = (target: { threadId: string; messageId: string }, orgId = ORG) =>
  db.doc(`orgs/${orgId}/clerkThreads/${target.threadId}/messages/${target.messageId}`);

/** Stores an Anthropic key for the org as `clerk-setApiKey` would (sealed with the fake KMS). */
async function storeKey(orgId: string, apiKey = ORG_KEY, extra: Record<string, unknown> = {}) {
  const sealed = await kms.encrypt(apiKey, anthropicKeyPath(orgId));
  await db.doc(anthropicKeyPath(orgId)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: apiKey.slice(-4),
    opusAvailable: true,
    ...extra,
  });
}

async function resetOrg(orgId: string, data: Record<string, unknown> = {}, options: { key?: boolean } = {}) {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  await db.doc(`orgs/${orgId}`).set({ name: 'Fictional Clerk Practice', ...data });
  if (options.key ?? true) await storeKey(orgId);
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'clerk-integration-admin');
  db = getAdminFirestore(admin);
  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'clerk-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('ClerkGateway on Firestore (fake model)', () => {
  beforeEach(() => resetOrg(ORG));

  it('streams into the message, stores the verbatim turn and meters per feature and user', async () => {
    const target = await newThread();
    const { gateway } = gatewayWith([
      {
        chunks: ['{"greeting":', '"Hello there.",', '"promptRef":"hello@1.0.0"}'],
        usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200 },
      },
    ]);
    const result = await gateway.run(input({ stream: target }));
    expect(result).toMatchObject({ status: 'done', parsed: { greeting: 'Hello there.' } });

    const stored = await message(target).get();
    expect(stored.data()).toMatchObject({
      role: 'assistant',
      status: 'done',
      content: [{ type: 'text', text: HELLO_JSON }],
      promptId: 'hello@1.0.0',
      model: CLERK_MODEL,
      fallbackUsed: false,
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 },
      createdBy: UID,
    });
    const raw = await message(target).collection('private').doc('raw').get();
    expect(JSON.parse(raw.get('contentJson') as string)).toEqual([{ type: 'text', text: HELLO_JSON }]);
    expect((await db.doc(`orgs/${ORG}/clerkThreads/${target.threadId}`).get()).get('lastMessageAt')).toBeDefined();

    const metrics = await db.doc(`orgs/${ORG}/metrics/${meteringPeriod(new Date())}`).get();
    expect(metrics.get('values')).toMatchObject({
      calls: 1,
      tokens: 1250,
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 200,
      costMicros: 2540,
      'feature.hello.calls': 1,
      'feature.hello.tokens': 1250,
      [`user.${UID}.costMicros`]: 2540,
    });
    expect(metrics.get('createdBy')).toBe('system');
  });

  it('never overwrites an existing message (history is append-only)', async () => {
    const target = await newThread();
    const { gateway } = gatewayWith([{ chunks: [HELLO_JSON] }, { chunks: [HELLO_JSON] }]);
    await gateway.run(input({ stream: target }));
    await expect(gateway.run(input({ stream: target }))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('stops when the owner sets stopRequested', async () => {
    const target = await newThread();
    const { gateway } = gatewayWith([{ chunks: Array.from({ length: 40 }, (_, i) => `word${i} `), delayMs: 50 }]);
    const running = gateway.run(input({ stream: target }));
    // Wait for streaming to start, then ask it to stop, as the client would.
    await expect.poll(async () => (await message(target).get()).get('status'), { timeout: 5000 }).toBe('streaming');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await message(target).update({ stopRequested: true });
    const result = await running;
    expect(result.status).toBe('stopped');
    const stored = await message(target).get();
    expect(stored.get('status')).toBe('stopped');
    const text = (stored.get('content') as { text: string }[])[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('word39');
  });

  it.each([
    [{ chunks: ['I can’t help with that.'], stopReason: 'refusal' }, 'refused'],
    [{ chunks: ['{"greeting": "Hel'], stopReason: 'max_tokens' }, 'truncated'],
    [{ chunks: ['not json at all'] }, 'invalid_output'],
  ])('records %o as %s on the message', async (step, status) => {
    const target = await newThread();
    const { gateway } = gatewayWith([step]);
    expect((await gateway.run(input({ stream: target }))).status).toBe(status);
    const stored = await message(target).get();
    expect(stored.get('status')).toBe(status);
    expect((stored.get('content') as { text: string }[])[0]?.text).toBe(step.chunks.join(''));
  });

  it('keeps partial text and marks error when the stream drops', async () => {
    const target = await newThread();
    const { gateway } = gatewayWith([{ chunks: ['Half an'], error: new ClerkModelError('disconnected') }]);
    expect((await gateway.run(input({ stream: target }))).status).toBe('error');
    expect((await message(target).get()).data()).toMatchObject({
      status: 'error',
      content: [{ type: 'text', text: 'Half an' }],
    });
  });

  it('enforces the per-user window from the org settings', async () => {
    await resetOrg(ORG, { settings: { clerk: { enabled: true, userRateLimit: { requests: 2, windowMinutes: 10 } } } });
    const { gateway } = gatewayWith([]);
    await gateway.run(input());
    await gateway.run(input());
    await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_RATE_LIMITED' });
    const counter = await db.doc(`orgs/${ORG}/counters/clerk-rate-${UID}`).get();
    expect(counter.get('hits')).toHaveLength(2);
  });

  it('blocks calls once the monthly budget is used', async () => {
    await resetOrg(ORG, { settings: { clerk: { enabled: true, monthlyTokenBudget: 5000 } } });
    await db
      .doc(`orgs/${ORG}/metrics/${meteringPeriod(new Date())}`)
      .set({ period: meteringPeriod(new Date()), values: { tokens: 5000 } });
    const { gateway, model } = gatewayWith([]);
    await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_BUDGET_EXCEEDED' });
    expect(model.requests).toHaveLength(0);
  });

  it('kill switches: the global flag and the org setting', async () => {
    await expect(gatewayWith([], { 'clerk.enabled': false }).gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
    });
    await resetOrg(ORG, { settings: { clerk: { enabled: false } } });
    await expect(gatewayWith([]).gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: 'org.settings.clerk.enabled' },
    });
  });

  it('falls back to the secondary model and records it on the message', async () => {
    const target = await newThread();
    const overloaded: FakeStep = { error: new ClerkModelError('overloaded', 'x', 529) };
    const { gateway } = gatewayWith([
      overloaded,
      overloaded,
      overloaded,
      { chunks: [HELLO_JSON], model: 'claude-sonnet-5' },
    ]);
    expect(await gateway.run(input({ stream: target }))).toMatchObject({ status: 'done', fallbackUsed: true });
    expect((await message(target).get()).data()).toMatchObject({ model: 'claude-sonnet-5', fallbackUsed: true });
  });
});

async function signInMember(uid: string, orgId: string, role: Role = 'lawyer') {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email: `${uid}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uid, { orgId, role });
  await db.doc(`users/${uid}`).delete();
  await db.doc(`orgs/${orgId}/members/${uid}`).set({ role, status: 'active' });
  // A reset deletes the previous test's member document, and that delete's auth-syncClaims run can
  // clear these claims after they are set. Triggers arrive in order, so once this write's own run
  // has mirrored the membership, the earlier run is done and the claims are the member's.
  for (const started = Date.now(); (await db.doc(`users/${uid}`).get()).get(`memberships.${orgId}.role`) !== role;) {
    if (Date.now() - started > 60_000) throw new Error(`auth-syncClaims never mirrored ${uid} into ${orgId}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uid}@example.test`, PASSWORD);
}

async function callError(promise: Promise<unknown>): Promise<[string | undefined, string | undefined]> {
  try {
    await promise;
    return [undefined, undefined];
  } catch (caught) {
    const error = caught as FunctionsError;
    return [error.code, (error.details as { code?: string } | undefined)?.code];
  }
}

describe('ClerkGateway with each org’s own key (AI-02a)', () => {
  beforeEach(() => resetOrg(ORG));

  it('no key gives CLERK_DISABLED (org.byok.missing)', async () => {
    await resetOrg(ORG, {}, { key: false });
    const { gateway, model } = gatewayWith([]);
    await expect(gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: 'org.byok.missing' },
    });
    expect(model.requests).toHaveLength(0);
  });

  it('a rejected key gives CLERK_KEY_INVALID and marks the integration invalid', async () => {
    const { gateway, model } = gatewayWith([{ error: new ClerkModelError('auth', 'rejected', 401) }]);
    await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_KEY_INVALID' });
    expect(model.requests[0]?.credentials).toEqual({ orgId: ORG, apiKey: ORG_KEY });
    expect((await db.doc(anthropicKeyPath(ORG)).get()).get('status')).toBe('invalid');
    await expect(gatewayWith([]).gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_KEY_INVALID' });
  });

  it('the model setting picks Sonnet 5.5 or Opus 5.5 and the matching fallback chain', async () => {
    const down: FakeStep = { error: new ClerkModelError('server', 'x', 503) };
    const sonnet = gatewayWith([down, down, down, down]);
    await expect(sonnet.gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_UNAVAILABLE' });
    expect(sonnet.model.requests.map((r) => r.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
    ]);

    await resetOrg(ORG, { settings: { clerk: { model: 'claude-opus-5-5' } } });
    const opus = gatewayWith([down, down, down, down, down]);
    await expect(opus.gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_UNAVAILABLE' });
    expect(opus.model.requests.map((r) => r.model)).toEqual([
      'claude-opus-5-5',
      'claude-opus-5-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
    ]);
  });
});

describe('Clerk key callables through the Functions emulator (AI-02a)', () => {
  const KEY_ORG = 'org-clerk-byok';
  const fn =
    <O>(name: string) =>
    (data: Record<string, unknown> = {}) =>
      httpsCallable<Record<string, unknown>, O>(
        getFunctions(client, 'australia-southeast1'),
        name,
      )({
        requestId: randomUUID(),
        ...data,
      });
  const setKey = fn<Record<string, unknown>>('clerk-setApiKey');
  const status = fn<Record<string, unknown>>('clerk-getApiKeyStatus');
  const setModel = fn<Record<string, unknown>>('clerk-setModel');
  const removeKey = fn<Record<string, unknown>>('clerk-removeApiKey');
  const NEW_KEY = 'sk-ant-api03-fictional-callable-key-5678';

  beforeEach(() => resetOrg(KEY_ORG, { flags: { 'clerk.enabled': true } }, { key: false }));

  it('round-trips the key through KMS: saved encrypted, usable by clerk-hello, never returned', async () => {
    await signInMember('clerk-byok-owner', KEY_ORG, 'owner');
    const { data: saved } = await setKey({ apiKey: NEW_KEY });
    expect(saved).toMatchObject({ last4: '5678', opusAvailable: true });

    const stored = (await db.doc(anthropicKeyPath(KEY_ORG)).get()).data() ?? {};
    expect(stored).toMatchObject({ status: 'valid', last4: '5678', setBy: 'clerk-byok-owner' });
    expect(JSON.stringify(stored)).not.toContain(NEW_KEY);
    expect(await kms.decrypt(stored['encryptedApiKey'] as string, anthropicKeyPath(KEY_ORG))).toBe(NEW_KEY);

    const { data: shown } = await status();
    expect(shown).toMatchObject({ set: true, status: 'valid', last4: '5678', model: CLERK_MODEL });
    expect(JSON.stringify(shown)).not.toContain(stored['encryptedApiKey'] as string);

    const audit = await db.collection(`orgs/${KEY_ORG}/audit`).where('action', '==', 'clerk.api_key_set').get();
    expect(audit.docs.map((entry) => entry.get('data'))).toEqual([{ last4: '5678', opusAvailable: true }]);
    expect(JSON.stringify(audit.docs.map((entry) => entry.data()))).not.toContain(NEW_KEY);
    // The audit trigger's own entry for the write drops the ciphertext.
    await vi.waitFor(
      async () => {
        const written = await db
          .collection(`orgs/${KEY_ORG}/audit`)
          .where('entity.collection', '==', 'integrations')
          .get();
        expect(written.size).toBeGreaterThan(0);
        const text = JSON.stringify(written.docs.map((entry) => entry.data()));
        expect(text).not.toContain(stored['encryptedApiKey'] as string);
        expect(text).not.toContain(NEW_KEY);
      },
      { timeout: 10_000, interval: 250 },
    );

    const { data: hello } = await fn<Record<string, unknown>>('clerk-hello')();
    expect(hello).toMatchObject({ status: 'done', model: CLERK_MODEL });
    expect((await setModel({ model: 'claude-opus-5-5' })).data).toEqual({ model: 'claude-opus-5-5' });
    expect((await fn<Record<string, unknown>>('clerk-hello')()).data).toMatchObject({ model: 'claude-opus-5-5' });

    expect((await removeKey()).data).toEqual({ removed: true });
    expect((await db.doc(anthropicKeyPath(KEY_ORG)).get()).exists).toBe(false);
    expect(await callError(fn('clerk-hello')())).toEqual(['functions/failed-precondition', 'CLERK_DISABLED']);
  });

  it('refuses a key Anthropic rejects, and stores nothing', async () => {
    await signInMember('clerk-byok-owner', KEY_ORG, 'owner');
    expect(await callError(setKey({ apiKey: 'sk-ant-api03-fictional-invalid-key-0000' }))).toEqual([
      'functions/failed-precondition',
      'CLERK_KEY_INVALID',
    ]);
    expect((await db.doc(anthropicKeyPath(KEY_ORG)).get()).exists).toBe(false);
  });

  it('roles: a lawyer can’t set or read the key', async () => {
    await storeKey(KEY_ORG);
    await signInMember('clerk-byok-lawyer', KEY_ORG, 'lawyer');
    const calls = [
      () => setKey({ apiKey: NEW_KEY }),
      () => status(),
      () => removeKey(),
      () => setModel({ model: 'claude-opus-5-5' }),
    ];
    for (const call of calls) {
      expect(await callError(call())).toEqual(['functions/permission-denied', 'PERMISSION_DENIED']);
    }
    expect((await db.doc(anthropicKeyPath(KEY_ORG)).get()).get('last4')).toBe(ORG_KEY.slice(-4));
  });
});

describe('Clerk settings through the Functions emulator (AI-13)', () => {
  const SETTINGS_ORG = 'org-clerk-settings';
  const call =
    <O>(name: string) =>
    (data: Record<string, unknown> = {}) =>
      httpsCallable<Record<string, unknown>, O>(
        getFunctions(client, 'australia-southeast1'),
        name,
      )({ requestId: randomUUID(), ...data });
  const updateSettings = call<{ changed: string[] }>('clerk-updateSettings');
  const hello = call<Record<string, unknown>>('clerk-hello');
  const chat = (orgId = SETTINGS_ORG) =>
    gatewayWith([{ chunks: ['Fictional answer.'] }], {
      'clerk.enabled': true,
      'clerk.features.chat': true,
    }).gateway.run(
      input({
        ctx: { orgId, uid: 'clerk-settings-owner', role: 'owner', requestId: randomUUID(), log, clock },
        feature: 'chat',
        promptId: 'chat-answer',
        vars: { today: '2026-10-05', role: 'owner', matterContext: 'None.', question: 'Who are the executors?' },
      }),
    );

  beforeEach(() => resetOrg(SETTINGS_ORG, { flags: { 'clerk.enabled': true } }));

  it('holds every feature until an owner acknowledges the disclosure, then a disabled feature stays blocked', async () => {
    await signInMember('clerk-settings-owner', SETTINGS_ORG, 'owner');
    await expect(chat()).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: 'org.settings.clerk.acknowledgement' },
    });

    expect((await updateSettings({ acknowledgeVersion: CLERK_DISCLOSURE_VERSION })).data.changed).toEqual([
      'acknowledgement',
    ]);
    const clerk = (await db.doc(`orgs/${SETTINGS_ORG}`).get()).get('settings.clerk') as Record<string, unknown>;
    expect(clerk).toMatchObject({ ackVersion: CLERK_DISCLOSURE_VERSION, acknowledgedBy: 'clerk-settings-owner' });
    await expect(chat()).resolves.toMatchObject({ status: 'done' });

    await updateSettings({ features: { chat: false } });
    await expect(chat()).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: 'org.settings.clerk.features.chat' },
    });
    const audit = await db
      .collection(`orgs/${SETTINGS_ORG}/audit`)
      .where('action', '==', 'clerk.settings_changed')
      .get();
    expect(audit.size).toBe(2);
  });

  it('turning Clerk off for the org blocks clerk-hello; a lawyer can’t change settings', async () => {
    await signInMember('clerk-settings-owner', SETTINGS_ORG, 'owner');
    expect((await hello()).data).toMatchObject({ status: 'done' });
    await updateSettings({ enabled: false });
    expect(await callError(hello())).toEqual(['functions/failed-precondition', 'CLERK_DISABLED']);

    await signInMember('clerk-settings-lawyer', SETTINGS_ORG, 'lawyer');
    expect(await callError(updateSettings({ enabled: true }))).toEqual([
      'functions/permission-denied',
      'PERMISSION_DENIED',
    ]);
  });
});

describe('clerk-hello through the Functions emulator', () => {
  const hello = (data: Record<string, unknown> = {}) =>
    httpsCallable<Record<string, unknown>, Record<string, unknown>>(
      getFunctions(client, 'australia-southeast1'),
      'clerk-hello',
    )({ requestId: randomUUID(), ...data });

  it('streams the hello prompt into a new thread with the fake model', async () => {
    await resetOrg(HELLO_ORG, { flags: { 'clerk.enabled': true } });
    await signInMember('clerk-hello-user', HELLO_ORG);
    const { data } = await hello();
    expect(data).toMatchObject({
      status: 'done',
      promptRef: 'hello@1.0.0',
      model: CLERK_MODEL,
      fallbackUsed: false,
      greeting: 'Hello from the fake Clerk model.',
    });
    const reply = await db
      .doc(`orgs/${HELLO_ORG}/clerkThreads/${data['threadId'] as string}/messages/${data['messageId'] as string}`)
      .get();
    expect(reply.data()).toMatchObject({ role: 'assistant', status: 'done', promptId: 'hello@1.0.0' });
    const metrics = await db.doc(`orgs/${HELLO_ORG}/metrics/${meteringPeriod(new Date())}`).get();
    expect(metrics.get('values')).toMatchObject({ calls: 1, 'feature.hello.calls': 1 });
  });

  it('is refused while Clerk is off for the org', async () => {
    await resetOrg(OFF_ORG);
    await signInMember('clerk-off-user', OFF_ORG);
    let error: FunctionsError | undefined;
    try {
      await hello();
    } catch (caught) {
      error = caught as FunctionsError;
    }
    expect([error?.code, (error?.details as { code?: string } | undefined)?.code]).toEqual([
      'functions/failed-precondition',
      'CLERK_DISABLED',
    ]);
  });
});
