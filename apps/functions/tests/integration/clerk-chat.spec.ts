import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { CLERK_DISCLOSURE_VERSION, type Role } from '@materia/domain';

import { chatRunDeps } from '../../src/clerk/chat/callables';
import { runChatMessage } from '../../src/clerk/chat/run';
import { meteringPeriod } from '../../src/clerk/features';
import { anthropicKeyPath } from '../../src/clerk/keyring';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import type { StoredExchange } from '../../src/clerk/store';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { createLog } from '../../src/core/log';
import { FakeKms, fakePorts } from '../../src/ports/fakes';

/**
 * AI-06 acceptance tests through the emulators, against the fake model (fictional data only):
 * `clerk-sendMessage` queues the answer and returns at once, `clerk-runMessage` (Cloud Tasks)
 * writes it with the read-only tools and proposals, Stop, Retry and feedback; and, in-process on
 * the Firestore emulator, the earlier turns replayed byte for byte after a round trip through
 * Firestore.
 */
const PROJECT_ID = 'demo-materia';
const PASSWORD = 'fictional-password-1';
const ORG = 'org-clerk-chat';
const OFF_ORG = 'org-clerk-chat-off';
const MATTER = 'm-chat';
const ORG_KEY = 'sk-ant-api03-fictional-chat-key-0000';
const FLAGS = { 'clerk.enabled': true, 'clerk.features.chat': true, 'clerk.features.suggestions': true };
const kms = new FakeKms();

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

type Data = Record<string, unknown>;

const log = createLog({ fn: 'clerk-chat-integration' }, () => undefined);

async function resetOrg(orgId: string, flags: Data = FLAGS) {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  // An admin has acknowledged the data-use disclosure (AI-13), so Clerk may read the matter.
  await db.doc(`orgs/${orgId}`).set({
    name: 'Fictional Chat Practice',
    timezone: 'Australia/Melbourne',
    flags,
    settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION } },
  });
  const sealed = await kms.encrypt(ORG_KEY, anthropicKeyPath(orgId));
  await db.doc(anthropicKeyPath(orgId)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: ORG_KEY.slice(-4),
    opusAvailable: true,
  });
  const at = new Date();
  await db.doc(`orgs/${orgId}/matters/${MATTER}`).set({
    number: 'M-2026-0142',
    title: 'Estate of Fictional Harrow',
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    privileged: false,
    deletedAt: null,
    createdAt: at,
    createdBy: 'seed',
    updatedAt: at,
    updatedBy: 'seed',
    schemaVersion: 1,
  });
  await db.doc(`orgs/${orgId}/matters/${MATTER}/deadlines/d-notice`).set({
    orgId,
    matterId: MATTER,
    title: 'Advertise notice of intended distribution',
    dueDate: '2026-12-01',
    kind: 'statutory',
    critical: true,
    status: 'upcoming',
    reminders: [],
    pastOnCreation: false,
    createdAt: at,
    createdBy: 'seed',
    updatedAt: at,
    updatedBy: 'seed',
    schemaVersion: 1,
  });
}

async function signInMember(uid: string, orgId: string, role: Role = 'lawyer') {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email: `${uid}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uid, { orgId, role });
  await db.doc(`orgs/${orgId}/members/${uid}`).set({ role, status: 'active' });
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uid}@example.test`, PASSWORD);
}

const fn =
  <O>(name: string) =>
  (data: Data = {}) =>
    httpsCallable<Data, O>(getFunctions(client, 'australia-southeast1'), name)({ requestId: randomUUID(), ...data });
const send = fn<{ threadId: string; userMessageId: string; messageId: string }>('clerk-sendMessage');
const retry = fn<{ messageId: string }>('clerk-retryMessage');
const feedback = fn<{ messageId: string }>('clerk-setFeedback');

const messagePath = (threadId: string, messageId: string, orgId = ORG) =>
  `orgs/${orgId}/clerkThreads/${threadId}/messages/${messageId}`;
const read = async (path: string) => (await db.doc(path).get()).data() ?? {};
const text = (data: Data) => ((data['content'] as { text?: string }[] | undefined)?.[0]?.text ?? '') as string;

async function poll<T>(get: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await get();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await get();
  }
  return value;
}
const settled = (path: string) =>
  poll(
    () => read(path),
    (data) => data['status'] !== 'streaming',
  );

async function callError(promise: Promise<unknown>): Promise<[string | undefined, string | undefined]> {
  try {
    await promise;
    return [undefined, undefined];
  } catch (caught) {
    const error = caught as FunctionsError;
    return [error.code, (error.details as { code?: string } | undefined)?.code];
  }
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'clerk-chat-integration-admin');
  db = getAdminFirestore(admin);
  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'clerk-chat-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  setRemoteFlagLoader(async () => ({}));
});

afterAll(async () => {
  setRemoteFlagLoader();
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('Clerk chat through the Functions emulator', () => {
  beforeEach(() => resetOrg(ORG));

  it('answers server-side with the tools, proposes a task, retries and takes feedback', async () => {
    await signInMember('clerk-chat-lawyer', ORG);
    const { data: sent } = await send({ matterId: MATTER, text: '[fake:tools] [fake:propose] Who is the executor?' });
    expect((await read(`orgs/${ORG}/clerkThreads/${sent.threadId}`))['ownerUid']).toBe('clerk-chat-lawyer');

    const answer = await settled(messagePath(sent.threadId, sent.messageId));
    expect(answer).toMatchObject({ status: 'done', replyTo: sent.userMessageId, promptId: 'chat@1.0.0' });
    expect(text(answer)).toBe('Let me check the matter. \n\nFake Clerk reply after checking the matter.');
    expect(answer['toolCalls']).toEqual([
      expect.objectContaining({ name: 'search_documents', status: 'done' }),
      expect.objectContaining({ name: 'get_deadlines', status: 'done' }),
    ]);
    const withProposals = await poll(
      () => read(messagePath(sent.threadId, sent.messageId)),
      (data) => ((data['suggestionIds'] as string[] | undefined) ?? []).length > 0,
    );
    const [suggestionId] = withProposals['suggestionIds'] as string[];
    expect(await read(`orgs/${ORG}/matters/${MATTER}/suggestions/${suggestionId}`)).toMatchObject({
      kind: 'task',
      status: 'proposed',
      promptId: 'chat-proposals',
      payload: { title: 'Request certified copies of the death certificate' },
    });
    const raw = await read(`${messagePath(sent.threadId, sent.messageId)}/private/raw`);
    const exchange = JSON.parse(raw['exchangeJson'] as string) as StoredExchange;
    expect(exchange.turns.map((turn) => turn.role)).toEqual(['assistant', 'user', 'assistant']);

    // Retry: a new answer to the same question; the first is left as it was.
    const { data: retried } = await retry({ threadId: sent.threadId, messageId: sent.messageId });
    const second = await settled(messagePath(sent.threadId, retried.messageId));
    expect(second).toMatchObject({ status: 'done', replyTo: sent.userMessageId });
    expect(text(await read(messagePath(sent.threadId, sent.messageId)))).toBe(text(answer));

    await feedback({ threadId: sent.threadId, messageId: retried.messageId, rating: 'down', reason: 'not_helpful' });
    expect((await read(messagePath(sent.threadId, retried.messageId)))['feedback']).toMatchObject({
      rating: 'down',
      reason: 'not_helpful',
      by: 'clerk-chat-lawyer',
    });
    await feedback({ threadId: sent.threadId, messageId: retried.messageId, rating: 'up' });
    const metrics = await read(`orgs/${ORG}/metrics/${meteringPeriod(new Date())}`);
    expect(metrics['values']).toMatchObject({ 'feature.chat.feedback_up': 1, 'feature.chat.feedback_down': 0 });
  });

  it('stops when asked, keeping what was written', async () => {
    await signInMember('clerk-chat-lawyer', ORG);
    const { data: sent } = await send({ matterId: MATTER, text: '[fake:slow] Tell me everything.' });
    const path = messagePath(sent.threadId, sent.messageId);
    await poll(
      () => read(path),
      (data) => text(data).length > 0,
    );
    await db.doc(path).update({ stopRequested: true });
    const stopped = await settled(path);
    expect(stopped['status']).toBe('stopped');
    expect(text(stopped)).toMatch(/^word1 /);
  });

  it('says at once when Clerk chat is switched off, and keeps other people out of a thread', async () => {
    await resetOrg(OFF_ORG, { 'clerk.enabled': true });
    await signInMember('clerk-chat-off', OFF_ORG);
    expect(await callError(send({ matterId: MATTER, text: 'Hello?' }))).toEqual([
      'functions/failed-precondition',
      'CLERK_DISABLED',
    ]);

    await signInMember('clerk-chat-lawyer', ORG);
    const { data: sent } = await send({ matterId: MATTER, text: 'Who is the executor?' });
    await settled(messagePath(sent.threadId, sent.messageId));
    await signInMember('clerk-chat-paralegal', ORG, 'paralegal');
    expect(await callError(send({ matterId: MATTER, threadId: sent.threadId, text: 'Mine now?' }))).toEqual([
      'functions/not-found',
      'NOT_FOUND',
    ]);
  });
});

describe('Clerk chat history on Firestore', () => {
  beforeEach(async () => {
    clearFlagCaches();
    await resetOrg(ORG);
    await db.doc(`orgs/${ORG}/members/u-history`).set({ role: 'lawyer', status: 'active' });
  });

  /** A question and its pending answer, as `clerk-sendMessage` writes them. */
  async function question(threadId: string, words: string, at: Date) {
    const thread = db.doc(`orgs/${ORG}/clerkThreads/${threadId}`);
    const meta = { createdBy: 'u-history', updatedBy: 'u-history', updatedAt: at, schemaVersion: 1 };
    if (!(await thread.get()).exists)
      await thread.set({
        title: words,
        ownerUid: 'u-history',
        matterId: MATTER,
        shared: false,
        privileged: false,
        deletedAt: null,
        createdAt: at,
        ...meta,
      });
    const user = thread.collection('messages').doc();
    const answer = thread.collection('messages').doc();
    const base = { citations: [], stopRequested: false, toolCalls: [], suggestionIds: [], privileged: false };
    await user.set({
      ...base,
      role: 'user',
      content: [{ type: 'text', text: words }],
      status: 'done',
      createdAt: at,
      ...meta,
    });
    await answer.set({
      ...base,
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      status: 'streaming',
      replyTo: user.id,
      createdAt: new Date(at.getTime() + 1),
      ...meta,
    });
    return answer.id;
  }

  it('replays the stored turns byte for byte after a round trip through Firestore', async () => {
    const model = new FakeClerkModel([
      {
        thinking: 'Fictional reasoning.',
        chunks: ['Checking. '],
        toolUses: [{ name: 'get_deadlines', input: {} }],
      },
      { thinking: 'The deadline is set.', chunks: ['Notice must be advertised by 1 December 2026.'] },
      { chunks: ['{"proposals":[]}'] },
      { chunks: ['Nothing else is due.'] },
      { chunks: ['{"proposals":[]}'] },
    ]);
    const deps = chatRunDeps(db, fakePorts({ clerkModel: model, clerkKms: kms }), log);
    const threadId = db.collection(`orgs/${ORG}/clerkThreads`).doc().id;
    const task = (messageId: string) => ({
      orgId: ORG,
      threadId,
      messageId,
      uid: 'u-history',
      role: 'lawyer' as const,
      requestId: randomUUID(),
    });

    const first = await question(threadId, 'What is due?', new Date(Date.now() - 60_000));
    const outcome = await runChatMessage(deps, task(first));
    expect(outcome, JSON.stringify((await read(messagePath(threadId, first)))['error'])).toBe('answered');
    const storedJson = (await read(`${messagePath(threadId, first)}/private/raw`))['exchangeJson'] as string;
    const stored = JSON.parse(storedJson) as StoredExchange;

    const second = await question(threadId, 'Anything else?', new Date());
    expect(await runChatMessage(deps, task(second))).toBe('answered');
    const followUp = model.requests.filter((request) => request.tools?.length).at(-1);
    const replayed = [{ role: 'user', content: stored.user }, ...stored.turns];
    expect(JSON.stringify(followUp?.messages.slice(0, replayed.length))).toBe(JSON.stringify(replayed));
    // Exactly what the model returned, thinking and tool calls included.
    expect(JSON.stringify(stored.turns[0]?.content)).toBe(JSON.stringify(model.requests[1]?.messages[1]?.content));
    expect((await read(`${messagePath(threadId, first)}/private/raw`))['exchangeJson']).toBe(storedJson);
  });
});
