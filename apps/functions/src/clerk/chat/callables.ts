import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  CLERK_CHAT_CALLABLES,
  CLERK_THREAD_TITLE_MAX,
  DocIdSchema,
  DomainError,
  PERMISSIONS,
  RetryClerkMessageInput,
  RoleSchema,
  SendClerkMessageInput,
  SetClerkFeedbackInput,
  clerkAcknowledged,
  orgClerkFeatureOn,
  type RetryClerkMessageResult,
  type SendClerkMessageResult,
  type SetClerkFeedbackResult,
} from '@materia/domain';

import { CHAT_HISTORY_BUDGET_TOKENS, conversationTokens, threadMessages } from './history';
import { CHAT_PROMPT, runChatMessage, type ChatRunDeps, type ChatRunTask } from './run';
import { firestoreChatToolSource } from './tools';
import { defineCallable, type CallableDefinition } from '../../core/callable';
import { isEnabled } from '../../core/flags';
import type { Log } from '../../core/log';
import { defineQueue } from '../../core/tasks';
import { chunkSearch } from '../../documents/ingest/search';
import { chunkDocumentText } from '../../documents/ingest/text';
import { liveMatter, matterPath } from '../../matters/shared';
import type { Clock, Ports } from '../../ports';
import { systemClock } from '../../ports/container';
import { firestoreContextSource } from '../context/firestore-source';
import { clerkContext } from '../context/service';
import { meteringPeriod } from '../features';
import { firestoreClerkStore } from '../firestore-store';
import { assertWithinBudget, BYOK_MISSING_SWITCH } from '../gateway';
import { anthropicKeyPath } from '../keyring';
import { clerkGateway } from '../service';
import type { OrgClerkSettings } from '../store';

type Data = Record<string, unknown>;

/** The queue that writes answers server-side (AI-06): Cloud Tasks, so navigating away doesn't stop one. */
export const CHAT_QUEUE = 'clerk-runMessage';

export const ChatRunTaskSchema = z.object({
  orgId: DocIdSchema,
  threadId: DocIdSchema,
  messageId: DocIdSchema,
  uid: DocIdSchema,
  role: RoleSchema,
  requestId: z.string().min(1).max(100),
});

const threadsPath = (orgId: string) => `orgs/${orgId}/clerkThreads`;

/** A new thread's title: the question's first words, on one line. */
export function threadTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= CLERK_THREAD_TITLE_MAX) return line;
  const cut = line.slice(0, CLERK_THREAD_TITLE_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), CLERK_THREAD_TITLE_MAX / 2)).trimEnd()}…`;
}

/**
 * Says at once why Clerk can't answer, so the Composer can show it and offer the manual path
 * (AI-06): the kill switches, the org's own settings (its "Ask Clerk" switch and the data-use
 * disclosure, AI-13), no usable key, or the month's token budget or spend limit used.
 * The gateway checks all of these again when the answer runs (and the per-user window then).
 */
async function checkAvailable(db: Firestore, orgId: string, clock: Clock): Promise<void> {
  const flags = { orgId, db, clock };
  for (const flag of ['clerk.enabled', 'clerk.features.chat'] as const)
    if (!(await isEnabled(flags, flag)))
      throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: flag });
  const [org, key] = await Promise.all([db.doc(`orgs/${orgId}`).get(), db.doc(anthropicKeyPath(orgId)).get()]);
  const settings = (org.get('settings.clerk') as OrgClerkSettings | undefined) ?? {};
  if (settings.enabled === false)
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: 'org.settings.clerk.enabled' });
  if (!orgClerkFeatureOn(settings, 'chat'))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: 'org.settings.clerk.features.chat' });
  if (!clerkAcknowledged(settings))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: 'org.settings.clerk.acknowledgement' });
  if (!key.exists || !key.get('encryptedApiKey'))
    throw new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: BYOK_MISSING_SWITCH });
  if (key.get('status') === 'invalid')
    throw new DomainError('CLERK_KEY_INVALID', 'Anthropic rejected the org’s API key; an admin must replace it');
  // The month's token budget and spend limit, read and checked as the gateway does.
  const period = meteringPeriod(clock.now());
  assertWithinBudget(settings, await firestoreClerkStore(db).periodUsage(orgId, period), period);
}

/** A thread the caller owns, live, on the matter; anything else is NOT_FOUND (never revealed). */
async function ownThread(db: Firestore, orgId: string, uid: string, threadId: string): Promise<Data> {
  const snap = await db.doc(`${threadsPath(orgId)}/${threadId}`).get();
  const data = snap.data();
  if (!snap.exists || !data || data['ownerUid'] !== uid || (data['deletedAt'] ?? null) !== null)
    throw new DomainError('NOT_FOUND', 'Clerk thread not found', { threadId });
  return data;
}

/** A thread holds one running answer at a time: questions and retries wait for it. */
async function assertIdle(db: Firestore, orgId: string, threadId: string): Promise<void> {
  const running = await db
    .collection(`${threadsPath(orgId)}/${threadId}/messages`)
    .where('status', '==', 'streaming')
    .limit(1)
    .get();
  if (!running.empty) throw new DomainError('CONFLICT', 'Clerk is still answering in this thread', { threadId });
}

/** The fields every new message starts with. */
const messageBase = { citations: [], stopRequested: false, toolCalls: [], suggestionIds: [], privileged: false };

/** The answer `clerk-runMessage` will write: created now, so the client can listen to it at once. */
function pendingAnswer(replyTo: string, meta: Data): Data {
  return {
    ...messageBase,
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    status: 'streaming',
    replyTo,
    promptId: CHAT_PROMPT,
    ...meta,
  };
}

async function enqueueRun(ports: Ports, task: ChatRunTask): Promise<void> {
  await ports.tasks.enqueue(
    CHAT_QUEUE,
    { ...task },
    { dedupeKey: `clerk-chat-${task.orgId}-${task.threadId}-${task.messageId}` },
  );
}

/**
 * `clerk-sendMessage` (AI-06, ADR-044): asks Clerk about a matter and returns at once. It
 * creates the thread (for a first question), the question and the answer (`streaming`), and
 * queues `clerk-runMessage`, which writes the answer server-side while the client listens to the
 * message. A thread that has outgrown the context budget is never trimmed: the question starts a
 * continued thread instead, seeded with a summary. Says at once when Clerk is off, over budget or
 * missing its key.
 */
export const sendMessageDefinition = {
  name: CLERK_CHAT_CALLABLES.send,
  input: SendClerkMessageInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async ({ input, uid, orgId, role, requestId, db, clock, ports, log }): Promise<SendClerkMessageResult> => {
    await checkAvailable(db, orgId, clock);
    liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);

    const threads = db.collection(threadsPath(orgId));
    const at = clock.now();
    const meta = (offsetMs: number) => {
      const when = new Date(at.getTime() + offsetMs);
      return {
        createdAt: when,
        createdBy: uid,
        updatedAt: when,
        updatedBy: uid,
        schemaVersion: 1,
        _requestId: requestId,
      };
    };
    let thread = input.threadId ? threads.doc(input.threadId) : threads.doc();
    let continuedFrom: string | undefined;
    let fresh = !input.threadId;
    let inherited: Data = {};
    if (input.threadId) {
      const existing = await ownThread(db, orgId, uid, input.threadId);
      if (existing['matterId'] !== input.matterId)
        throw new DomainError('INVALID_ARGUMENT', 'This thread is about another matter', { threadId: input.threadId });
      await assertIdle(db, orgId, input.threadId);
      const tokens = conversationTokens(await threadMessages(db, orgId, input.threadId));
      if (tokens >= CHAT_HISTORY_BUDGET_TOKENS) {
        continuedFrom = input.threadId;
        thread = threads.doc();
        fresh = true;
        inherited = {
          title: threadTitle(`${String(existing['title'] ?? 'Clerk')} (continued)`),
          continuedFrom,
          shared: existing['shared'] === true,
          privileged: existing['privileged'] === true,
        };
        log.info('clerk thread continued', { from: continuedFrom, tokens });
      }
    }

    const messages = thread.collection('messages');
    const question = messages.doc();
    const answer = messages.doc();
    const batch = db.batch();
    if (fresh)
      batch.create(thread, {
        title: threadTitle(input.text),
        ownerUid: uid,
        matterId: input.matterId,
        shared: false,
        privileged: false,
        ...inherited,
        lastMessageAt: at,
        deletedAt: null,
        ...meta(0),
      });
    else batch.update(thread, { lastMessageAt: at });
    batch.create(question, {
      ...messageBase,
      role: 'user',
      content: [{ type: 'text', text: input.text }],
      status: 'done',
      ...(input.attachments.length ? { attachments: input.attachments } : {}),
      ...meta(0),
    });
    // A millisecond later, so the answer sorts after its question.
    batch.create(answer, pendingAnswer(question.id, meta(1)));
    await batch.commit();
    await enqueueRun(ports, { orgId, threadId: thread.id, messageId: answer.id, uid, role, requestId });
    log.info('clerk question queued', {
      threadId: thread.id,
      messageId: answer.id,
      attachments: input.attachments.length,
      ...(continuedFrom ? { continuedFrom } : {}),
    });
    return {
      threadId: thread.id,
      userMessageId: question.id,
      messageId: answer.id,
      ...(continuedFrom ? { continuedFrom } : {}),
    };
  },
} satisfies CallableDefinition<typeof SendClerkMessageInput, SendClerkMessageResult>;

/**
 * `clerk-retryMessage` (AI-06): asks again. The earlier answer stays as it was (history is never
 * edited); a new answer to the same question is added after it and written like any other. Only
 * the thread's newest answer can be retried, so the conversation stays one line.
 */
export const retryMessageDefinition = {
  name: CLERK_CHAT_CALLABLES.retry,
  input: RetryClerkMessageInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async ({ input, uid, orgId, role, requestId, db, clock, ports, log }): Promise<RetryClerkMessageResult> => {
    await checkAvailable(db, orgId, clock);
    const thread = await ownThread(db, orgId, uid, input.threadId);
    if (typeof thread['matterId'] === 'string')
      liveMatter(await db.doc(matterPath(orgId, thread['matterId'])).get(), role, thread['matterId']);
    await assertIdle(db, orgId, input.threadId);
    const all = await threadMessages(db, orgId, input.threadId);
    const target = all.find((message) => message.id === input.messageId);
    const replyTo = target?.data['replyTo'];
    if (!target || target.data['role'] !== 'assistant' || typeof replyTo !== 'string')
      throw new DomainError('NOT_FOUND', 'Clerk message not found', { messageId: input.messageId });
    if (all[all.length - 1]?.id !== target.id)
      throw new DomainError('FAILED_PRECONDITION', 'Only the newest answer can be retried', { reason: 'not_latest' });

    const at = clock.now();
    const ref = db.collection(`${threadsPath(orgId)}/${input.threadId}/messages`).doc();
    const batch = db.batch();
    batch.create(
      ref,
      pendingAnswer(replyTo, {
        createdAt: at,
        createdBy: uid,
        updatedAt: at,
        updatedBy: uid,
        schemaVersion: 1,
        _requestId: requestId,
      }),
    );
    batch.update(db.doc(`${threadsPath(orgId)}/${input.threadId}`), { lastMessageAt: at });
    await batch.commit();
    await enqueueRun(ports, { orgId, threadId: input.threadId, messageId: ref.id, uid, role, requestId });
    log.info('clerk retry queued', { threadId: input.threadId, messageId: ref.id, retryOf: input.messageId });
    return { messageId: ref.id };
  },
} satisfies CallableDefinition<typeof RetryClerkMessageInput, RetryClerkMessageResult>;

/**
 * `clerk-setFeedback` (AI-06): the owner's thumbs up or down on an answer, with a reason, stored on
 * the message (`feedback`) and counted per month (`feature.chat.feedback_up`/`_down`) for the
 * evals (AI-12). Changing one's mind moves the count.
 */
export const setFeedbackDefinition = {
  name: CLERK_CHAT_CALLABLES.feedback,
  input: SetClerkFeedbackInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  handler: async ({ input, uid, orgId, db, clock, log }): Promise<SetClerkFeedbackResult> => {
    await ownThread(db, orgId, uid, input.threadId);
    const ref = db.doc(`${threadsPath(orgId)}/${input.threadId}/messages/${input.messageId}`);
    const at = clock.now();
    const metrics = db.doc(`orgs/${orgId}/metrics/${meteringPeriod(at)}`);
    await db.runTransaction(async (tx) => {
      const [snap, month] = await Promise.all([tx.get(ref), tx.get(metrics)]);
      if (!snap.exists || snap.get('role') !== 'assistant')
        throw new DomainError('NOT_FOUND', 'Clerk message not found', { messageId: input.messageId });
      if (snap.get('status') === 'streaming')
        throw new DomainError('FAILED_PRECONDITION', 'Clerk is still answering', { reason: 'streaming' });
      const previous = snap.get('feedback.rating') as string | undefined;
      tx.update(ref, {
        feedback: {
          rating: input.rating,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.comment ? { comment: input.comment } : {}),
          by: uid,
          at,
        },
        updatedAt: at,
        updatedBy: uid,
      });
      if (previous === input.rating) return;
      const values: Record<string, FieldValue> = {
        [`feature.chat.feedback_${input.rating}`]: FieldValue.increment(1),
        ...(previous ? { [`feature.chat.feedback_${previous}`]: FieldValue.increment(-1) } : {}),
      };
      const created = month.exists
        ? { updatedAt: at, updatedBy: 'system' }
        : {
            period: meteringPeriod(at),
            createdAt: at,
            createdBy: 'system',
            updatedAt: at,
            updatedBy: 'system',
            schemaVersion: 1,
          };
      tx.set(metrics, { ...created, values }, { merge: true });
    });
    log.info('clerk feedback', { messageId: input.messageId, rating: input.rating, reason: input.reason ?? null });
    return { messageId: input.messageId };
  },
} satisfies CallableDefinition<typeof SetClerkFeedbackInput, SetClerkFeedbackResult>;

/** The answer-writing dependencies on Firestore and the container's ports. */
export function chatRunDeps(db: Firestore, ports: Ports, log: Log, clock: Clock = systemClock): ChatRunDeps {
  return {
    db,
    clock,
    log,
    gateway: clerkGateway({ db, ports, clock }),
    context: clerkContext({ db, embedding: ports.embedding }),
    tools: {
      context: firestoreContextSource(db),
      records: firestoreChatToolSource(db),
      chunks: chunkSearch({ db, embedding: ports.embedding }),
      documentText: chunkDocumentText(db),
    },
    flag: (orgId, key) => isEnabled({ orgId, db, clock }, key),
  };
}

export const sendMessage = defineCallable(sendMessageDefinition);
export const retryMessage = defineCallable(retryMessageDefinition);
export const setFeedback = defineCallable(setFeedbackDefinition);

/**
 * `clerk-runMessage`: writes one answer (`runChatMessage`). A second attempt only happens when the
 * first died (timeout, lost instance): it ends the answer as an error rather than calling the
 * model again.
 */
export const runMessage = defineQueue({
  name: CHAT_QUEUE,
  input: ChatRunTaskSchema,
  retry: { maxAttempts: 2, minBackoffSeconds: 30 },
  timeoutSeconds: 540,
  memory: '512MiB',
  handler: async (task, { db, ports, log, attempt }) => {
    await runChatMessage(chatRunDeps(db, ports, log), task, attempt);
  },
});
