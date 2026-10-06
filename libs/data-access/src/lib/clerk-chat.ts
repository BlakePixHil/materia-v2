import {
  CLERK_CHAT_CALLABLES,
  CLERK_THREAD_MESSAGES_MAX,
  ClerkMessage,
  ClerkThread,
  type RetryClerkMessageInput,
  type RetryClerkMessageResult,
  type SendClerkMessageInput,
  type SendClerkMessageResult,
  type SetClerkFeedbackInput,
  type SetClerkFeedbackResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { WithId } from './resources';

/**
 * The org's Clerk threads (`orgs/{orgId}/clerkThreads`, AI-06): read, plus the owner's
 * client-direct rename, share and delete (`ClerkThread.update`: `title` and `shared` only).
 * Threads are created by `clerk-sendMessage`.
 */
export function clerkThreadRepository(): Repository<ClerkThread> {
  return repo((orgId) => `orgs/${orgId}/clerkThreads`, {
    schema: ClerkThread.schema,
    version: ClerkThread.version,
    update: ClerkThread.update,
  });
}

export interface ClerkThreadsQueryOptions {
  uid: string;
  matterId: string;
  /** The owner's threads, or the ones others shared with the matter team. */
  which: 'mine' | 'shared';
  /** Whether the reader has `privileged.view`; without it the rules need `privileged == false`. */
  privilegedVisible: boolean;
}

/**
 * A matter's threads: the reader's own, or the shared ones. Equality filters only (no composite
 * index); `sortThreads` orders them, newest first.
 */
export function clerkThreadsQuery(options: ClerkThreadsQueryOptions): QuerySpec<ClerkThread> {
  return {
    where: [
      ['matterId', '==', options.matterId],
      options.which === 'mine' ? ['ownerUid', '==', options.uid] : ['shared', '==', true],
      ...(options.privilegedVisible ? [] : [['privileged', '==', false] as const]),
    ],
    pageSize: 100,
  };
}

const millis = (value: Date | undefined) => value?.getTime() ?? 0;

/** Threads, most recently active first, each once (the reader's own shared threads are in both lists). */
export function sortThreads(...lists: readonly (readonly WithId<ClerkThread>[])[]): WithId<ClerkThread>[] {
  const byId = new Map<string, WithId<ClerkThread>>();
  for (const list of lists) for (const thread of list) byId.set(thread.id, thread);
  return [...byId.values()].sort(
    (a, b) => millis(b.lastMessageAt ?? b.createdAt) - millis(a.lastMessageAt ?? a.createdAt),
  );
}

/**
 * A thread's messages (`…/clerkThreads/{threadId}/messages`): read, plus the owner's Stop
 * (`ClerkMessage.update`: `stopRequested` only). Messages are written by functions.
 */
export function clerkMessageRepository(threadId: () => string | null): Repository<ClerkMessage> {
  return repo((orgId) => `orgs/${orgId}/clerkThreads/${threadId() ?? '-'}/messages`, {
    schema: ClerkMessage.schema,
    version: ClerkMessage.version,
    update: ClerkMessage.update,
  });
}

/** A thread's messages, all of them (a thread is continued long before this many). */
export function clerkMessagesQuery(options: { privilegedVisible: boolean }): QuerySpec<ClerkMessage> {
  return {
    where: options.privilegedVisible ? [] : [['privileged', '==', false]],
    pageSize: CLERK_THREAD_MESSAGES_MAX,
  };
}

/** Messages oldest first; a question before the answer created with it. */
export function sortMessages(messages: readonly WithId<ClerkMessage>[]): WithId<ClerkMessage>[] {
  return [...messages].sort(
    (a, b) => millis(a.createdAt) - millis(b.createdAt) || (a.role === 'user' ? -1 : 0) - (b.role === 'user' ? -1 : 0),
  );
}

type Input<T> = Omit<T, 'requestId'>;

/** The `clerk-*` chat callables (AI-06), all idempotent. */
export interface ClerkChatCallables {
  /** Asks a question; returns at once with the ids to listen to (the answer streams into its message). */
  send(input: Input<SendClerkMessageInput>, options?: { requestId?: string }): Promise<SendClerkMessageResult>;
  /** Asks again: a new answer to the same question; the old one stays. */
  retry(input: Input<RetryClerkMessageInput>, options?: { requestId?: string }): Promise<RetryClerkMessageResult>;
  feedback(input: Input<SetClerkFeedbackInput>, options?: { requestId?: string }): Promise<SetClerkFeedbackResult>;
}

export function clerkChatCallables(client: Pick<CallableClient, 'call'>): ClerkChatCallables {
  return {
    send: (input, options = {}) =>
      client.call<Input<SendClerkMessageInput>, SendClerkMessageResult>(CLERK_CHAT_CALLABLES.send, input, {
        idempotent: true,
        ...options,
      }),
    retry: (input, options = {}) =>
      client.call<Input<RetryClerkMessageInput>, RetryClerkMessageResult>(CLERK_CHAT_CALLABLES.retry, input, {
        idempotent: true,
        ...options,
      }),
    feedback: (input, options = {}) =>
      client.call<Input<SetClerkFeedbackInput>, SetClerkFeedbackResult>(CLERK_CHAT_CALLABLES.feedback, input, {
        idempotent: true,
        ...options,
      }),
  };
}
