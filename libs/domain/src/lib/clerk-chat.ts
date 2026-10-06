import * as z from 'zod';

import { ClerkFeedbackReasonSchema } from './schemas/clerk';
import { DocIdSchema } from './schemas/common';

/**
 * The Clerk chat panel (AI-06, ADR-044): the callables' names and inputs, the `/` commands, the
 * read-only tools Clerk may choose while answering, and their labels. Shared by functions and the
 * web app.
 */

export const CLERK_CHAT_CALLABLES = {
  send: 'clerk-sendMessage',
  retry: 'clerk-retryMessage',
  feedback: 'clerk-setFeedback',
} as const;

/** The longest question a person can send. */
export const CLERK_CHAT_TEXT_MAX = 8_000;
/** Attachments per question (the context builder's own limit, AI-03). */
export const CLERK_CHAT_ATTACHMENTS_MAX = 10;
/** A new thread's title: the question's first words. */
export const CLERK_THREAD_TITLE_MAX = 80;
/** Messages a thread is read with; one is continued (a new thread) long before it holds this many. */
export const CLERK_THREAD_MESSAGES_MAX = 400;

/**
 * The `/` commands. Only `summarise` is built; the others arrive with their tickets (chronology:
 * LIT-06, drafting: AI-10, timeline: INS) and show as "coming soon" until then.
 */
export const CLERK_CHAT_COMMANDS = [
  { name: 'summarise', description: 'Summarise this matter', available: true },
  { name: 'chronology', description: 'Chronology from the documents (coming soon)', available: false },
  { name: 'draft', description: 'Draft a letter or file note (coming soon)', available: false },
  { name: 'timeline', description: 'Key dates as a timeline (coming soon)', available: false },
] as const;
export type ClerkChatCommand = (typeof CLERK_CHAT_COMMANDS)[number]['name'];

/** What `/summarise` asks when nothing follows it. */
export const SUMMARISE_DEFAULT_QUESTION =
  'Summarise this matter: where it stands, what is due next and anything that needs attention.';

/**
 * A question's command, when it starts with an available one (`/summarise the estate`); the rest is
 * the question. Commands that aren't built yet are left as plain text.
 */
export function parseClerkCommand(text: string): { command: ClerkChatCommand | null; question: string } {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = CLERK_CHAT_COMMANDS.find((c) => c.available && c.name === match?.[1]);
  if (!match || !command) return { command: null, question: text.trim() };
  const rest = (match[2] ?? '').trim();
  return { command: command.name, question: rest || SUMMARISE_DEFAULT_QUESTION };
}

/** The read-only tools Clerk may choose while answering (never forced; never a write, rule 3). */
export const CLERK_CHAT_TOOLS = [
  'search_documents',
  'get_deadlines',
  'get_tasks',
  'get_parties',
  'get_time_summary',
  'get_document_text',
] as const;
export type ClerkChatTool = (typeof CLERK_CHAT_TOOLS)[number];

/** The "working" line while a tool runs. */
export const CLERK_TOOL_LABELS: Readonly<Record<ClerkChatTool, string>> = {
  search_documents: 'Searching documents…',
  get_deadlines: 'Checking deadlines…',
  get_tasks: 'Checking tasks…',
  get_parties: 'Looking up parties…',
  get_time_summary: 'Totalling recorded time…',
  get_document_text: 'Reading a document…',
};

export function clerkToolLabel(name: string): string {
  return (CLERK_TOOL_LABELS as Record<string, string>)[name] ?? 'Working…';
}

export const CLERK_FEEDBACK_REASON_LABELS: Readonly<Record<z.infer<typeof ClerkFeedbackReasonSchema>, string>> = {
  inaccurate: 'Inaccurate',
  missing_sources: 'Missing or wrong sources',
  not_helpful: 'Not helpful',
  unsafe: 'Inappropriate or unsafe',
  other: 'Other',
};

export const SendClerkMessageInput = z.object({
  requestId: z.uuid(),
  /** Omitted starts a new thread. */
  threadId: DocIdSchema.optional(),
  matterId: DocIdSchema,
  text: z.string().trim().min(1).max(CLERK_CHAT_TEXT_MAX),
  attachments: z.array(DocIdSchema).max(CLERK_CHAT_ATTACHMENTS_MAX).default([]),
});
export type SendClerkMessageInput = z.input<typeof SendClerkMessageInput>;

/**
 * What `clerk-sendMessage` returns at once: the reply streams into `messageId` while the client
 * listens. `continuedFrom` is set when the thread outgrew the context budget and the question
 * went to a new thread seeded with a summary.
 */
export interface SendClerkMessageResult {
  threadId: string;
  userMessageId: string;
  messageId: string;
  continuedFrom?: string;
}

export const RetryClerkMessageInput = z.object({
  requestId: z.uuid(),
  threadId: DocIdSchema,
  /** The answer to try again: a new answer to the same question is added after it. */
  messageId: DocIdSchema,
});
export type RetryClerkMessageInput = z.input<typeof RetryClerkMessageInput>;
export interface RetryClerkMessageResult {
  messageId: string;
}

export const SetClerkFeedbackInput = z.object({
  requestId: z.uuid(),
  threadId: DocIdSchema,
  messageId: DocIdSchema,
  rating: z.enum(['up', 'down']),
  reason: ClerkFeedbackReasonSchema.optional(),
  comment: z.string().trim().max(500).optional(),
});
export type SetClerkFeedbackInput = z.input<typeof SetClerkFeedbackInput>;
export interface SetClerkFeedbackResult {
  messageId: string;
}
