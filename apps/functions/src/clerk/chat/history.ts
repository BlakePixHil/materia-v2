import type { Firestore } from 'firebase-admin/firestore';

import { CLERK_THREAD_MESSAGES_MAX } from '@materia/domain';

import type { ClerkTurn } from '../../ports';
import { escapeFraming } from '../context/framing';
import type { ClerkHistory } from '../gateway';
import type { StoredExchange } from '../store';

type Data = Record<string, unknown>;

/**
 * Tokens a thread may carry before the next question goes to a continued thread seeded with a
 * summary (AI-06). Measured from the newest answer's usage (everything sent plus the reply), so
 * no turn is ever trimmed: the conversation is either replayed whole or continued.
 */
export const CHAT_HISTORY_BUDGET_TOKENS = 150_000;

/** Answers whose exchange can be replayed: finished, with a complete assistant turn. */
const REPLAYABLE = new Set(['done', 'truncated']);

export interface ThreadMessage {
  id: string;
  data: Data;
}

const millis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : 0;
};

/** A thread's messages, oldest first (a question before its answers when created together). */
export async function threadMessages(db: Firestore, orgId: string, threadId: string): Promise<ThreadMessage[]> {
  const snap = await db
    .collection(`orgs/${orgId}/clerkThreads/${threadId}/messages`)
    .orderBy('createdAt')
    .limit(CLERK_THREAD_MESSAGES_MAX)
    .get();
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as Data }))
    .sort(
      (a, b) =>
        millis(a.data['createdAt']) - millis(b.data['createdAt']) ||
        (a.data['role'] === 'user' ? -1 : 0) - (b.data['role'] === 'user' ? -1 : 0),
    );
}

/** The plain text of a message's content blocks. */
export function messageText(data: Data): string {
  return ((data['content'] as { type?: string; text?: string }[] | undefined) ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** Tokens the thread's newest answer used, sent and received: how big the conversation has grown. */
export function conversationTokens(messages: readonly ThreadMessage[]): number {
  for (const message of [...messages].reverse()) {
    const usage = message.data['usage'] as Record<string, number> | undefined;
    if (message.data['role'] !== 'assistant' || !usage) continue;
    return (
      (usage['inputTokens'] ?? 0) +
      (usage['cacheReadTokens'] ?? 0) +
      (usage['cacheWriteTokens'] ?? 0) +
      (usage['outputTokens'] ?? 0)
    );
  }
  return 0;
}

/** Whether the turns end with an assistant turn that asked for no tools (the API needs tool calls answered). */
function complete(turns: readonly ClerkTurn[]): boolean {
  const last = turns[turns.length - 1];
  return (
    last?.role === 'assistant' &&
    !(last.content as { type?: string }[]).some((block) => (block as { type?: string }).type === 'tool_use')
  );
}

/**
 * The conversation before a question (AI-06), from the stored exchanges: for each earlier
 * question, its newest replayable answer (a retry answers the same question again), exactly as it
 * was sent and received. Nothing is edited or trimmed. Exchanges a later turn can't replay are
 * left out whole: unfinished answers, answers stored before AI-06 (no exchange), and answers from
 * another model (a fallback, or the org changed model), whose thinking is bound to that model.
 */
export async function loadHistory(
  db: Firestore,
  orgId: string,
  threadId: string,
  messages: readonly ThreadMessage[],
  options: { before: string; model: string },
): Promise<ClerkHistory & { exchanges: number; skipped: number }> {
  const history: ClerkHistory & { exchanges: number; skipped: number } = {
    turns: [],
    sources: { documents: [], searchResults: [] },
    exchanges: 0,
    skipped: 0,
  };
  const end = messages.findIndex((message) => message.id === options.before);
  const earlier = end < 0 ? messages : messages.slice(0, end);
  const answers = new Map<string, ThreadMessage>();
  for (const message of earlier) {
    const replyTo = message.data['replyTo'];
    if (
      message.data['role'] === 'assistant' &&
      typeof replyTo === 'string' &&
      REPLAYABLE.has(String(message.data['status']))
    )
      answers.set(replyTo, message); // the newest answer wins
  }
  const questions = earlier.filter((message) => message.data['role'] === 'user' && answers.has(message.id));
  const raws = questions.length
    ? await db.getAll(
        ...questions.map((question) =>
          db.doc(
            `orgs/${orgId}/clerkThreads/${threadId}/messages/${(answers.get(question.id) as ThreadMessage).id}/private/raw`,
          ),
        ),
      )
    : [];
  for (const raw of raws) {
    const json = raw.exists ? raw.get('exchangeJson') : undefined;
    const exchange = typeof json === 'string' ? (JSON.parse(json) as StoredExchange) : undefined;
    if (!exchange || exchange.model !== options.model || !complete(exchange.turns)) {
      history.skipped++;
      continue;
    }
    history.turns.push({ role: 'user', content: exchange.user }, ...exchange.turns);
    history.sources.documents.push(...exchange.sources.documents);
    history.sources.searchResults.push(...exchange.sources.searchResults);
    history.exchanges++;
  }
  return history;
}

/** The longest message a summary transcript keeps, and the whole transcript. */
const TRANSCRIPT_MESSAGE_MAX = 6_000;
const TRANSCRIPT_MAX = 200_000;

/**
 * A thread's questions and answers as text for the summary prompt (`chat-summary`), oldest first,
 * each framing tag neutralised. Only what people saw: never the raw turns or the documents.
 */
export function transcript(messages: readonly ThreadMessage[]): string {
  const lines = messages
    .filter((message) => message.data['role'] === 'user' || REPLAYABLE.has(String(message.data['status'])))
    .map((message) => {
      const who = message.data['role'] === 'user' ? 'Person' : 'Clerk';
      const text = messageText(message.data).slice(0, TRANSCRIPT_MESSAGE_MAX);
      return `${who}: ${escapeFraming(text)}`;
    });
  return lines.join('\n\n').slice(-TRANSCRIPT_MAX);
}
