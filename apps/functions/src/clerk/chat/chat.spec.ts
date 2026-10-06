import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import {
  CLERK_CHAT_DRAFT_TOOLS,
  CLERK_CHAT_TOOLS,
  CLERK_DISCLOSURE_VERSION,
  type RetryClerkMessageResult,
  type Role,
  type SendClerkMessageResult,
} from '@materia/domain';

import {
  CHAT_QUEUE,
  ChatRunTaskSchema,
  chatRunDeps,
  retryMessageDefinition,
  sendMessageDefinition,
  setFeedbackDefinition,
  threadTitle,
} from './callables';
import { CHAT_HISTORY_BUDGET_TOKENS } from './history';
import { DRAFT_RATIONALE, runChatMessage, type ChatRunDeps } from './run';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../core/flags';
import { createLog } from '../../core/log';
import { memoryFirestore } from '../../orgs/testing';
import { ClerkModelError, type ClerkModelRequest } from '../../ports';
import { FakeClock, FakeKms, FakeTaskQueue, fakePorts } from '../../ports/fakes';
import { createContextBuilder } from '../context/build-context';
import { firestoreContextSource } from '../context/firestore-source';
import {
  CANARY,
  DOCUMENT_TEXT,
  fixtureMatter,
  HITS,
  matterData,
  MATTER,
  ORG,
  OTHER_MATTER,
  USERS,
} from '../context/fixtures';
import { charEstimateCounter } from '../context/ports';
import { FakeChunkSearch, FakeDocumentText } from '../context/testing';
import { anthropicKeyPath } from '../keyring';
import { FakeClerkModel, type FakeStep } from '../providers/fake';
import type { StoredExchange } from '../store';

/** Unit tests for the Clerk chat panel's backend (AI-06). Every org, person and matter is fictional. */

type Data = Record<string, unknown>;

const NOW = new Date('2026-10-05T00:00:00.000Z');
const FLAGS = { 'clerk.enabled': true, 'clerk.features.chat': true, 'clerk.features.suggestions': true };
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const uidOf = (role: Role) =>
  role === 'paralegal' ? USERS.paralegal : role === 'readonly' ? USERS.readonly : USERS.lawyer;

/** The AI-03 fixture practice on the in-memory Firestore, with a sealed (fictional) key. */
async function world(
  options: { script?: FakeStep[]; flags?: Data; settings?: Data; extra?: Record<string, Data> } = {},
) {
  const kms = new FakeKms();
  const sealed = await kms.encrypt('sk-ant-fictional-chat-unit-test-0000', anthropicKeyPath(ORG));
  const matter = fixtureMatter();
  const M = `orgs/${ORG}/matters`;
  const initial: Record<string, Data> = {
    [`orgs/${ORG}`]: {
      name: 'Fictional Ashdown Legal',
      timezone: 'Australia/Melbourne',
      flags: options.flags ?? FLAGS,
      settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION, ...options.settings } },
    },
    [anthropicKeyPath(ORG)]: {
      provider: 'anthropic',
      uid: null,
      status: 'valid',
      scopes: [],
      encryptedApiKey: sealed.ciphertext,
      kmsKeyVersion: sealed.keyVersion,
      last4: '0000',
    },
    [`orgs/${ORG}/contacts/c-executor`]: { ...meta, kind: 'person', givenNames: 'Morgan', familyName: 'Ashdown' },
    [`orgs/${ORG}/contacts/c-beneficiary`]: { ...meta, kind: 'person', givenNames: 'Quinn', familyName: 'Ashdown' },
    [`${M}/${MATTER}`]: { ...matter.data, privileged: false, deletedAt: null },
    [`${M}/${OTHER_MATTER}`]: { ...matterData({ number: 'M-2026-0043' }), privileged: false, deletedAt: null },
    ...options.extra,
  };
  for (const [role, uid] of [
    ['lawyer', USERS.lawyer],
    ['paralegal', USERS.paralegal],
    ['readonly', USERS.readonly],
  ] as const)
    initial[`orgs/${ORG}/members/${uid}`] = { ...meta, role, status: 'active', displayName: `Fictional ${role}` };
  for (const collection of ['parties', 'events', 'deadlines', 'tasks', 'notes', 'documents'] as const)
    for (const [id, data] of Object.entries(matter[collection] ?? {}))
      initial[`${M}/${MATTER}/${collection}/${id}`] = data;

  clearFlagCaches();
  const store = memoryFirestore(initial);
  const clock = new FakeClock(NOW);
  const model = new FakeClerkModel(options.script ?? []);
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ clerkModel: model, clerkKms: kms, tasks, clock });
  const log = createLog({ fn: 'test' }, () => undefined);
  const chunks = new FakeChunkSearch(HITS);
  const documentText = new FakeDocumentText(DOCUMENT_TEXT);
  const base = chatRunDeps(store.db, ports, log, clock);
  const deps: ChatRunDeps = {
    ...base,
    context: createContextBuilder({
      source: firestoreContextSource(store.db),
      chunks,
      documentText,
      tokens: charEstimateCounter,
    }),
    tools: { ...base.tools, chunks, documentText },
  };
  const callableDeps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: CallableDefinition<never, T>, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: uidOf(role), token: { orgId: ORG, role } } },
      callableDeps(),
    );
  const send = (data: Data, role: Role = 'lawyer') =>
    call<SendClerkMessageResult>(sendMessageDefinition as never, { matterId: MATTER, ...data }, role);
  const retry = (data: Data, role: Role = 'lawyer') =>
    call<RetryClerkMessageResult>(retryMessageDefinition as never, data, role);
  const feedback = (data: Data, role: Role = 'lawyer') => call(setFeedbackDefinition as never, data, role);
  /** Runs the next queued answer, as Cloud Tasks would. */
  const runNext = async (attempt = 0) => {
    const job = tasks.queued.shift();
    if (!job) throw new Error('nothing queued');
    expect(job.queue).toBe(CHAT_QUEUE);
    return runChatMessage(deps, ChatRunTaskSchema.parse(job.payload), attempt);
  };
  const ask = async (text: string, data: Data = {}, role: Role = 'lawyer') => {
    clock.advance(60_000);
    const sent = await send({ text, ...data }, role);
    const outcome = await runNext();
    return { ...sent, outcome };
  };
  const threadPath = (threadId: string) => `orgs/${ORG}/clerkThreads/${threadId}`;
  const thread = (threadId: string) => store.docs.get(threadPath(threadId)) as Data;
  const message = (threadId: string, id: string) => store.docs.get(`${threadPath(threadId)}/messages/${id}`) as Data;
  const exchange = (threadId: string, id: string) =>
    (store.docs.get(`${threadPath(threadId)}/messages/${id}/private/raw`) as Data | undefined)?.['exchangeJson'] as
      string | undefined;
  const text = (data: Data) => ((data['content'] as { text: string }[])[0] as { text: string }).text;
  /** The chat calls (not the proposals or summary steps). */
  const chatRequests = () => model.requests.filter((request) => request.tools?.length);
  return {
    store,
    clock,
    model,
    tasks,
    deps,
    send,
    retry,
    feedback,
    runNext,
    ask,
    thread,
    message,
    exchange,
    text,
    chatRequests,
  };
}

async function failure(promise: Promise<unknown>): Promise<HttpsError & { details: Data }> {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details: Data };
  }
  throw new Error('expected the call to fail');
}

const blocksOf = (request: ClerkModelRequest | undefined, index: number) =>
  (request?.messages[index]?.content ?? []) as Data[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('threadTitle', () => {
  it('is the question on one line, cut at a word', () => {
    expect(threadTitle('  Who is\nthe executor?  ')).toBe('Who is the executor?');
    const long = threadTitle(`What ${'fictional words '.repeat(20)}`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('clerk-sendMessage and clerk-runMessage', () => {
  it('creates a private thread, the question and a streaming answer, then writes the answer server-side', async () => {
    const w = await world();
    const sent = await w.send({ text: 'Who is the executor?' });
    expect(w.thread(sent.threadId)).toMatchObject({
      title: 'Who is the executor?',
      ownerUid: USERS.lawyer,
      matterId: MATTER,
      shared: false,
      deletedAt: null,
    });
    expect(w.message(sent.threadId, sent.userMessageId)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Who is the executor?' }],
      status: 'done',
      privileged: false,
    });
    // The client listens to this message at once; nothing has been asked of the model yet.
    expect(w.message(sent.threadId, sent.messageId)).toMatchObject({
      role: 'assistant',
      status: 'streaming',
      replyTo: sent.userMessageId,
      suggestionIds: [],
    });
    expect(w.model.requests).toHaveLength(0);
    expect(w.tasks.queued[0]?.options.dedupeKey).toBe(`clerk-chat-${ORG}-${sent.threadId}-${sent.messageId}`);
    const job = structuredClone(w.tasks.queued[0]);

    expect(await w.runNext()).toBe('answered');
    const answer = w.message(sent.threadId, sent.messageId);
    expect(answer).toMatchObject({ status: 'done', promptId: 'chat@1.1.0', manifest: { scope: { kind: 'matter' } } });
    expect(w.text(answer)).toBe('Fake Clerk reply.');
    // Read and drafting tools offered, none forced; the context first, the question last.
    const [chat] = w.chatRequests();
    expect(chat?.tools?.map((tool) => tool.name)).toEqual([...CLERK_CHAT_TOOLS, ...CLERK_CHAT_DRAFT_TOOLS]);
    expect(chat?.messages).toHaveLength(1);
    expect(JSON.stringify(blocksOf(chat, 0).at(-1))).toContain('Who is the executor?');
    expect(w.exchange(sent.threadId, sent.messageId)).toBeDefined();
    // A redelivered task finds the answer finished and does nothing.
    if (job) w.tasks.queued.push(job);
    const calls = w.model.requests.length;
    expect(await w.runNext()).toBe('skipped');
    expect(w.model.requests).toHaveLength(calls);
  });

  it('runs the tools the model picks, shows each while it works, and cites what they returned', async () => {
    const w = await world({
      script: [
        {
          chunks: ['Let me check. '],
          toolUses: [
            { name: 'search_documents', input: { query: 'residue' } },
            { name: 'get_deadlines', input: {} },
            { name: 'get_document_text', input: { documentId: 'd-other', pages: [1] } },
          ],
        },
        { chunks: ['The residue goes to Quinn Ashdown.'] },
      ],
    });
    const sent = await w.send({ text: 'Who gets the residue?' }, 'paralegal');
    const seen: Data[][] = [];
    const unsubscribe = (
      w.store.db.doc(`orgs/${ORG}/clerkThreads/${sent.threadId}/messages/${sent.messageId}`) as unknown as {
        onSnapshot: (next: (snap: { get: (field: string) => unknown }) => void) => () => void;
      }
    ).onSnapshot((snap) => seen.push(snap.get('toolCalls') as Data[]));
    expect(await w.runNext()).toBe('answered');
    unsubscribe();

    const answer = w.message(sent.threadId, sent.messageId);
    expect(answer['status']).toBe('done');
    expect(w.text(answer)).toBe('Let me check. \n\nThe residue goes to Quinn Ashdown.');
    expect(answer['toolCalls']).toEqual([
      { id: 'fake-tool-1-1', name: 'search_documents', status: 'done' },
      { id: 'fake-tool-1-2', name: 'get_deadlines', status: 'done' },
      { id: 'fake-tool-1-3', name: 'get_document_text', status: 'error' },
    ]);
    expect(seen.some((calls) => calls?.some((call) => call['status'] === 'running'))).toBe(true);

    const [, second] = w.chatRequests();
    const results = blocksOf(second, 2);
    expect(results.map((block) => block['type'])).toEqual(['tool_result', 'tool_result', 'tool_result']);
    const serialised = JSON.stringify(results);
    expect(serialised).toContain('materia:document/d-will/v2/page/2');
    expect(serialised).toContain('Advertise notice of intended distribution');
    expect(serialised).toContain('Fictional Act s 1');
    // Another matter's document, and privileged material for a paralegal, never reach the model.
    expect(results[2]).toMatchObject({ isError: true });
    expect(serialised).not.toContain('Other matter text');
    expect(JSON.stringify(w.model.requests)).not.toContain(CANARY);
    expect(answer['privileged']).toBe(false);
    // What the tools showed is in the manifest (ids only).
    expect((answer['manifest'] as Data)['records']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'deadline', id: 'rule-caveat' })]),
    );
  });

  it('stops after six tool rounds and has the model answer with what it has', async () => {
    const rounds: FakeStep[] = Array.from({ length: 7 }, () => ({ toolUses: [{ name: 'get_parties' }] }));
    const w = await world({ script: [...rounds, { chunks: ['Morgan Ashdown is the executor.'] }] });
    const sent = await w.ask('Who are the parties?');
    const answer = w.message(sent.threadId, sent.messageId);
    expect(answer['status']).toBe('done');
    expect(answer['toolCalls'] as unknown[]).toHaveLength(6);
    const requests = w.chatRequests();
    expect(requests).toHaveLength(8);
    expect(JSON.stringify(requests[7]?.messages.at(-1))).toContain('Tool limit reached');
  });

  it('marks the answer and its thread privileged when it draws on privileged material (Clerk rule 6)', async () => {
    const w = await world({ script: [{ toolUses: [{ name: 'search_documents', input: { query: 'advice' } }] }] });
    const sent = await w.ask('What did counsel advise?');
    expect(w.message(sent.threadId, sent.messageId)['privileged']).toBe(true);
    expect(w.thread(sent.threadId)['privileged']).toBe(true);
    expect((w.message(sent.threadId, sent.messageId)['manifest'] as Data)['privileged']).toBe(true);
  });

  it('turns proposals into suggestions linked from the answer, citing only sources Clerk saw', async () => {
    const w = await world({
      script: [
        { chunks: ['Certified copies are still needed.'] },
        {
          chunks: [
            JSON.stringify({
              proposals: [
                {
                  kind: 'task',
                  payload: { title: 'Request certified copies of the death certificate', priority: 'medium' },
                  rationale: 'The answer says copies are still needed.',
                  citations: [
                    { documentId: 'd-will', page: 1, quote: 'This is the last will of Rowan Ashdown.' },
                    { documentId: 'd-invented', page: 1, quote: 'Not a real document' },
                  ],
                },
              ],
            }),
          ],
        },
      ],
    });
    const sent = await w.ask('What is left to do?', {}, 'paralegal');
    const ids = w.message(sent.threadId, sent.messageId)['suggestionIds'] as string[];
    expect(ids).toHaveLength(1);
    const suggestion = w.store.docs.get(`orgs/${ORG}/matters/${MATTER}/suggestions/${ids[0]}`) as Data;
    expect(suggestion).toMatchObject({
      kind: 'task',
      status: 'proposed',
      privileged: false,
      promptId: 'chat-proposals',
      promptVersion: '1.0.0',
    });
    expect(suggestion['citations']).toEqual([
      expect.objectContaining({ kind: 'document', documentId: 'd-will', docVersion: 2, page: 1 }),
    ]);
    // The proposals step is structured output over the same question and answer.
    const proposals = w.model.requests.find((request) => request.output?.name === 'chatProposals');
    expect(proposals?.tools).toBeUndefined();
    expect(JSON.stringify(proposals?.messages)).toContain('Certified copies are still needed.');
  });

  it('asks for no proposals when suggestions are switched off', async () => {
    const w = await world({ flags: { ...FLAGS, 'clerk.features.suggestions': false } });
    const sent = await w.ask('[fake:propose] Anything to do?');
    expect(w.message(sent.threadId, sent.messageId)['suggestionIds']).toEqual([]);
    expect(w.model.requests.some((request) => request.output)).toBe(false);
    // Nor drafting tools (AI-06b).
    expect(w.chatRequests()[0]?.tools?.map((tool) => tool.name)).toEqual([...CLERK_CHAT_TOOLS]);
  });

  describe('drafting from a direct request (AI-06b)', () => {
    const NOTE = 'Called Morgan Ashdown about the house valuation; they will send it Friday.';
    const drafting = (): FakeStep[] => [
      { toolUses: [{ name: 'draft_note', input: { text: NOTE } }] },
      { chunks: ['I’ve drafted that file note: it is waiting below for you to confirm.'] },
    ];

    it('drafts the note as a suggestion linked from the answer, and skips the proposals step', async () => {
      const w = await world({ script: drafting() });
      // A paralegal: nothing privileged in what Clerk saw, so neither is the draft.
      const sent = await w.ask(`Add a file note saying ${NOTE}`, {}, 'paralegal');
      const answer = w.message(sent.threadId, sent.messageId);
      expect(answer['status']).toBe('done');
      expect(answer['toolCalls']).toEqual([expect.objectContaining({ name: 'draft_note', status: 'done' })]);
      const ids = answer['suggestionIds'] as string[];
      expect(ids).toHaveLength(1);
      const suggestion = w.store.docs.get(`orgs/${ORG}/matters/${MATTER}/suggestions/${ids[0]}`) as Data;
      expect(suggestion).toMatchObject({
        kind: 'note',
        status: 'proposed',
        payload: { bodyMd: NOTE, pinned: false },
        rationale: DRAFT_RATIONALE,
        privileged: false,
        promptId: 'chat',
        promptVersion: '1.1.0',
        dedupeKey: expect.stringMatching(new RegExp(`^ask:${sent.userMessageId}:note:`)),
      });
      // Clerk was told what happened; nothing else was proposed.
      expect(JSON.stringify(w.chatRequests()[1]?.messages)).toContain('waiting below your answer');
      expect(w.model.requests.some((request) => request.output?.name === 'chatProposals')).toBe(false);
      // Nothing is on the matter until the person accepts it.
      expect([...w.store.docs.keys()].filter((key) => key.includes(`/matters/${MATTER}/notes/`))).toEqual(
        Object.keys(fixtureMatter().notes ?? {}).map((id) => `orgs/${ORG}/matters/${MATTER}/notes/${id}`),
      );
    });

    it('never drafts twice for the same question, and tells Clerk so', async () => {
      const w = await world({ script: [...drafting(), ...drafting()] });
      const first = await w.ask(`Add a file note saying ${NOTE}`);
      const retried = await w.retry({ threadId: first.threadId, messageId: first.messageId });
      expect(await w.runNext()).toBe('answered');
      expect(w.message(first.threadId, retried.messageId)['suggestionIds']).toEqual([]);
      expect(JSON.stringify(w.chatRequests()[3]?.messages)).toContain('already exists for this question');
      const notes = [...w.store.docs.keys()].filter((key) => key.includes(`/matters/${MATTER}/suggestions/`));
      expect(notes).toHaveLength(1);
    });

    it('keeps a draft linked when the answer fails after drafting', async () => {
      const w = await world({
        script: [drafting()[0] as FakeStep, { error: new ClerkModelError('bad_request', 'bad', 400) }],
      });
      const sent = await w.ask(`Add a file note saying ${NOTE}`, {}, 'paralegal');
      expect(sent.outcome).toBe('failed');
      const answer = w.message(sent.threadId, sent.messageId);
      expect(answer['status']).toBe('error');
      expect(answer['suggestionIds']).toHaveLength(1);
    });

    it('marks a draft privileged when the thread already is (Clerk rule 6)', async () => {
      const w = await world({
        script: [
          { toolUses: [{ name: 'search_documents', input: { query: 'advice' } }] },
          { chunks: ['Counsel advised on the claim.'] },
          { chunks: ['{"proposals":[]}'] },
          ...drafting(),
        ],
      });
      const first = await w.ask('What did counsel advise?');
      expect(w.thread(first.threadId)['privileged']).toBe(true);
      const sent = await w.ask(`Add a file note saying ${NOTE}`, { threadId: first.threadId });
      const [id] = w.message(sent.threadId, sent.messageId)['suggestionIds'] as string[];
      expect(w.store.docs.get(`orgs/${ORG}/matters/${MATTER}/suggestions/${id}`)).toMatchObject({ privileged: true });
    });
  });

  it('shows a refusal honestly and proposes nothing', async () => {
    const w = await world({ script: [{ chunks: ['I can’t help with that request.'], stopReason: 'refusal' }] });
    const sent = await w.ask('Draft a threatening letter.');
    const answer = w.message(sent.threadId, sent.messageId);
    expect(answer['status']).toBe('refused');
    expect(w.text(answer)).toBe('I can’t help with that request.');
    expect(w.model.requests).toHaveLength(1);
  });

  it('runs /summarise with its task line, and only the available commands', async () => {
    const w = await world();
    await w.ask('/summarise');
    const [chat] = w.chatRequests();
    const question = JSON.stringify(blocksOf(chat, 0).at(-1));
    expect(question).toContain('used /summarise');
  });

  it('stops when asked, keeping what was written, and proposes nothing', async () => {
    const w = await world({
      script: [{ chunks: Array.from({ length: 60 }, (_, i) => `word${i} `), delayMs: 5 }],
    });
    const sent = await w.send({ text: 'Tell me everything.' });
    const running = w.runNext();
    const path = `orgs/${ORG}/clerkThreads/${sent.threadId}/messages/${sent.messageId}`;
    while (!w.text(w.message(sent.threadId, sent.messageId))) await sleep(5);
    await w.store.db.doc(path).update({ stopRequested: true });
    expect(await running).toBe('answered');
    const answer = w.message(sent.threadId, sent.messageId);
    expect(answer['status']).toBe('stopped');
    expect(w.text(answer)).toMatch(/^word0 /);
    expect(w.model.requests).toHaveLength(1);
  });

  it('settles a stop requested before the answer starts, and ends a redelivered answer as an error', async () => {
    const w = await world();
    const sent = await w.send({ text: 'First question.' });
    await w.store.db.doc(`orgs/${ORG}/clerkThreads/${sent.threadId}/messages/${sent.messageId}`).update({
      stopRequested: true,
    });
    expect(await w.runNext()).toBe('skipped');
    expect(w.message(sent.threadId, sent.messageId)['status']).toBe('stopped');

    const again = await w.send({ text: 'Second question.', threadId: sent.threadId });
    expect(await w.runNext(1)).toBe('failed');
    expect(w.message(again.threadId, again.messageId)).toMatchObject({
      status: 'error',
      error: { code: 'CLERK_UNAVAILABLE' },
    });
    expect(w.model.requests).toHaveLength(0);
  });

  it('says at once when Clerk is off, has no key or is over budget, and records a rate limit on the answer', async () => {
    const off = await world({ flags: { ...FLAGS, 'clerk.features.chat': false } });
    expect((await failure(off.send({ text: 'Hello?' }))).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'clerk.features.chat',
    });
    const orgOff = await world({ settings: { enabled: false } });
    expect((await failure(orgOff.send({ text: 'Hello?' }))).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'org.settings.clerk.enabled',
    });
    const chatOff = await world({ settings: { features: { chat: false } } });
    expect((await failure(chatOff.send({ text: 'Hello?' }))).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'org.settings.clerk.features.chat',
    });
    const unacknowledged = await world({ settings: { ackVersion: undefined } });
    expect((await failure(unacknowledged.send({ text: 'Hello?' }))).details).toMatchObject({
      code: 'CLERK_DISABLED',
      switch: 'org.settings.clerk.acknowledgement',
    });
    const noKey = await world();
    noKey.store.docs.delete(anthropicKeyPath(ORG));
    expect((await failure(noKey.send({ text: 'Hello?' }))).details['code']).toBe('CLERK_DISABLED');
    const spent = await world({
      settings: { monthlyTokenBudget: 1000 },
      extra: { [`orgs/${ORG}/metrics/clerk-2026-10`]: { period: 'clerk-2026-10', values: { tokens: 1000 } } },
    });
    expect((await failure(spent.send({ text: 'Hello?' }))).details['code']).toBe('CLERK_BUDGET_EXCEEDED');

    const busy = await world({
      extra: {
        [`orgs/${ORG}/counters/clerk-rate-${USERS.lawyer}`]: { hits: Array.from({ length: 30 }, () => Date.now()) },
      },
    });
    const sent = await busy.ask('Hello?');
    expect(sent.outcome).toBe('failed');
    expect(busy.message(sent.threadId, sent.messageId)).toMatchObject({
      status: 'error',
      error: { code: 'CLERK_RATE_LIMITED' },
    });
  });

  it('keeps a thread to its matter, and other people’s threads private', async () => {
    const w = await world();
    const sent = await w.ask('Who is the executor?');
    expect(
      (await failure(w.send({ text: 'And this one?', threadId: sent.threadId, matterId: OTHER_MATTER }))).details[
        'code'
      ],
    ).toBe('INVALID_ARGUMENT');
    expect((await failure(w.send({ text: 'Mine now?', threadId: sent.threadId }, 'paralegal'))).details['code']).toBe(
      'NOT_FOUND',
    );
    expect((await failure(w.send({ text: 'Hello?' }, 'readonly'))).details['code']).toBe('PERMISSION_DENIED');
  });

  it('takes one question at a time per thread', async () => {
    const w = await world();
    const sent = await w.send({ text: 'First question.' });
    expect((await failure(w.send({ text: 'Second question.', threadId: sent.threadId }))).details['code']).toBe(
      'CONFLICT',
    );
  });
});

describe('conversation history', () => {
  it('replays every earlier turn byte for byte: thinking, tool calls and results, never edited', async () => {
    const w = await world({
      script: [
        {
          thinking: 'Fictional reasoning about the will.',
          chunks: ['Checking. '],
          toolUses: [{ name: 'search_documents', input: { query: 'executor' } }],
        },
        { thinking: 'The passage names the executor.', chunks: ['Morgan Ashdown is the executor.'] },
        { chunks: ['{"proposals":[]}'] },
        { thinking: 'A follow-up.', chunks: ['The residue goes to Quinn Ashdown.'] },
        { chunks: ['{"proposals":[]}'] },
        { chunks: ['Nothing else is outstanding.'] },
      ],
    });
    const first = await w.ask('Who is the executor?');
    const firstStored = w.exchange(first.threadId, first.messageId) as string;
    const [q1a, q1b] = w.chatRequests();
    // What was stored is exactly what was sent and received (cache markers aside).
    const stored = JSON.parse(firstStored) as StoredExchange;
    const strip = (blocks: readonly unknown[]) =>
      blocks.map((block) => {
        const copy = { ...(block as Data) };
        delete copy['cache'];
        return copy;
      });
    expect(stored.user).toEqual(strip(q1a?.messages[0]?.content ?? []));
    expect(stored.turns).toEqual([
      ...(q1b?.messages.slice(1) ?? []),
      { role: 'assistant', content: stored.turns.at(-1)?.content },
    ]);
    expect(JSON.stringify(stored.turns.at(-1)?.content)).toContain('The passage names the executor.');

    await w.ask('And the residue?', { threadId: first.threadId });
    const q2 = w.chatRequests()[2];
    const replayed = [{ role: 'user', content: stored.user }, ...stored.turns];
    expect(JSON.stringify(q2?.messages.slice(0, replayed.length))).toBe(JSON.stringify(replayed));
    expect(q2?.messages).toHaveLength(replayed.length + 1);

    await w.ask('Anything else?', { threadId: first.threadId });
    const q3 = w.chatRequests()[3];
    // The earlier turns are sent again unchanged: the conversation only ever grows at the end.
    expect(JSON.stringify(q3?.messages.slice(0, replayed.length))).toBe(JSON.stringify(replayed));
    expect(w.exchange(first.threadId, first.messageId)).toBe(firstStored);
    expect(q3?.messages).toHaveLength(replayed.length + 3);
  });

  it('retries as a new answer, leaves the old one as it was, and replays only the newest answer', async () => {
    const w = await world({
      script: [
        { chunks: ['First attempt.'] },
        { chunks: ['{"proposals":[]}'] },
        { chunks: ['Second attempt.'] },
        { chunks: ['{"proposals":[]}'] },
        { chunks: ['Follow-up answer.'] },
      ],
    });
    const first = await w.ask('Who is the executor?');
    const before = structuredClone(w.message(first.threadId, first.messageId));
    expect((await failure(w.retry({ threadId: first.threadId, messageId: first.userMessageId }))).details['code']).toBe(
      'NOT_FOUND',
    );
    w.clock.advance(60_000);
    const retried = await w.retry({ threadId: first.threadId, messageId: first.messageId });
    expect(await w.runNext()).toBe('answered');
    expect(w.message(first.threadId, first.messageId)).toEqual(before);
    expect(w.message(first.threadId, retried.messageId)).toMatchObject({
      replyTo: first.userMessageId,
      status: 'done',
    });
    expect(w.text(w.message(first.threadId, retried.messageId))).toBe('Second attempt.');
    // Only the newest answer can be retried.
    expect((await failure(w.retry({ threadId: first.threadId, messageId: first.messageId }))).details['code']).toBe(
      'FAILED_PRECONDITION',
    );

    await w.ask('And the residue?', { threadId: first.threadId });
    const followUp = w.chatRequests().at(-1);
    const serialised = JSON.stringify(followUp?.messages);
    expect(serialised).toContain('Second attempt.');
    expect(serialised).not.toContain('First attempt.');
    expect(followUp?.messages).toHaveLength(3);
  });

  it('continues a thread that outgrew the budget in a new one, seeded with a summary, never trimming', async () => {
    const w = await world({
      script: [
        { chunks: ['A long answer.'], usage: { inputTokens: CHAT_HISTORY_BUDGET_TOKENS } },
        { chunks: ['{"proposals":[]}'] },
        { chunks: ['Summary: the executor is Morgan Ashdown (fictional).'] },
        { chunks: ['Continued answer.'] },
      ],
    });
    const first = await w.ask('Who is the executor?');
    const firstThread = structuredClone(w.thread(first.threadId));
    const next = await w.ask('And the residue?', { threadId: first.threadId });
    expect(next.continuedFrom).toBe(first.threadId);
    expect(next.threadId).not.toBe(first.threadId);
    expect(w.thread(next.threadId)).toMatchObject({
      title: 'Who is the executor? (continued)',
      continuedFrom: first.threadId,
      matterId: MATTER,
      ownerUid: USERS.lawyer,
    });
    expect(w.thread(first.threadId)).toEqual(firstThread);

    const summary = w.model.requests[2];
    expect(summary?.tools).toBeUndefined();
    expect(JSON.stringify(summary?.messages)).toContain('Person: Who is the executor?');
    const continued = w.chatRequests().at(-1);
    expect(continued?.messages).toHaveLength(1);
    const question = JSON.stringify(blocksOf(continued, 0));
    expect(question).toContain('conversation_summary');
    expect(question).toContain('the executor is Morgan Ashdown');
    expect(w.text(w.message(next.threadId, next.messageId))).toBe('Continued answer.');
  });
});

describe('clerk-setFeedback', () => {
  it('stores the owner’s rating and reason on the answer and counts it for the month', async () => {
    const w = await world();
    const sent = await w.ask('Who is the executor?');
    await w.feedback({ threadId: sent.threadId, messageId: sent.messageId, rating: 'down', reason: 'missing_sources' });
    expect(w.message(sent.threadId, sent.messageId)['feedback']).toMatchObject({
      rating: 'down',
      reason: 'missing_sources',
      by: USERS.lawyer,
    });
    const metrics = w.store.docs.get(`orgs/${ORG}/metrics/clerk-2026-10`) as Data;
    expect((metrics['values'] as Data)['feature.chat.feedback_down']).toBe(1);

    expect(
      (await failure(w.feedback({ threadId: sent.threadId, messageId: sent.userMessageId, rating: 'up' }))).details[
        'code'
      ],
    ).toBe('NOT_FOUND');
    expect(
      (await failure(w.feedback({ threadId: sent.threadId, messageId: sent.messageId, rating: 'up' }, 'paralegal')))
        .details['code'],
    ).toBe('NOT_FOUND');
  });

  it('waits for the answer to finish', async () => {
    const w = await world();
    const sent = await w.send({ text: 'Who is the executor?' });
    expect(
      (await failure(w.feedback({ threadId: sent.threadId, messageId: sent.messageId, rating: 'up' }))).details['code'],
    ).toBe('FAILED_PRECONDITION');
  });
});
