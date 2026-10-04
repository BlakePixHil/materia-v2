import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { CLERK_MODEL } from '@materia/clerk';
import type { FlagKey } from '@materia/domain';

import { meteringPeriod } from '../../src/clerk/features';
import { firestoreClerkStore } from '../../src/clerk/firestore-store';
import { createClerkGateway, type ClerkRunInput } from '../../src/clerk/gateway';
import { FakeClerkModel, type FakeStep } from '../../src/clerk/providers/fake';
import { createLog } from '../../src/core/log';
import { ClerkModelError } from '../../src/ports';

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

async function resetOrg(orgId: string, data: Record<string, unknown> = {}) {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  await db.doc(`orgs/${orgId}`).set({ name: 'Fictional Clerk Practice', ...data });
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
      costMicros: 5040,
      'feature.hello.calls': 1,
      'feature.hello.tokens': 1250,
      [`user.${UID}.costMicros`]: 5040,
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
      { chunks: [HELLO_JSON], model: 'claude-opus-5' },
    ]);
    expect(await gateway.run(input({ stream: target }))).toMatchObject({ status: 'done', fallbackUsed: true });
    expect((await message(target).get()).data()).toMatchObject({ model: 'claude-opus-5', fallbackUsed: true });
  });
});

describe('clerk-hello through the Functions emulator', () => {
  const hello = (data: Record<string, unknown> = {}) =>
    httpsCallable<Record<string, unknown>, Record<string, unknown>>(
      getFunctions(client, 'australia-southeast1'),
      'clerk-hello',
    )({ requestId: randomUUID(), ...data });

  async function signInMember(uid: string, orgId: string) {
    const adminAuth = getAdminAuth(admin);
    await adminAuth.deleteUser(uid).catch(() => undefined);
    await adminAuth.createUser({ uid, email: `${uid}@example.test`, password: PASSWORD });
    await adminAuth.setCustomUserClaims(uid, { orgId, role: 'lawyer' });
    await db.doc(`orgs/${orgId}/members/${uid}`).set({ role: 'lawyer', status: 'active' });
    await signOut(auth);
    await signInWithEmailAndPassword(auth, `${uid}@example.test`, PASSWORD);
  }

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
