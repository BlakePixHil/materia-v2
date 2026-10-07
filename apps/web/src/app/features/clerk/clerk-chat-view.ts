import type { WithId } from '@materia/data-access/repository';
import {
  CLERK_CHAT_COMMANDS,
  clerkToolLabel,
  type ClerkMessage,
  type ClerkThread,
  type ErrorCode,
} from '@materia/domain';
import type { ComposerCommand } from '@materia/ui';
import { inlineText, parseMarkdown, type ClerkMessageState } from '@materia/ui/markdown';

import { errorCodeOf, errorCopy } from '../../core/error-copy';

export type ChatMessage = WithId<ClerkMessage>;
export type ChatThread = WithId<ClerkThread>;

/** The `/` commands as the Composer lists them: the ones not built yet are dimmed ("coming soon"). */
export const CHAT_COMMANDS: readonly ComposerCommand[] = CLERK_CHAT_COMMANDS.map((command) => ({
  name: command.name,
  description: command.description,
  ...(command.available ? {} : { disabled: true }),
}));

/** The Composer's scope chip: "M-2026-0142 · 3 attachments". */
export function scopeLabel(label: string, attachments: number): string {
  if (!attachments) return label;
  return `${label} · ${attachments} attachment${attachments === 1 ? '' : 's'}`;
}

/** A message's text (its text blocks, joined). */
export function messageText(message: Pick<ClerkMessage, 'content'>): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** How `mt-clerk-message` shows an answer. A refusal and a cut-short answer show as finished, with a note. */
export function messageState(message: Pick<ClerkMessage, 'status'>): ClerkMessageState {
  switch (message.status) {
    case 'streaming':
      return 'streaming';
    case 'stopped':
      return 'stopped';
    case 'error':
    case 'invalid_output':
      return 'error';
    default:
      return 'done';
  }
}

/** The note under an answer that finished without a full reply: said plainly, never hidden. */
export function messageNote(message: Pick<ClerkMessage, 'status'>): string | null {
  if (message.status === 'refused') return 'Clerk declined to answer this. Rephrase it, or do it by hand.';
  if (message.status === 'truncated') return 'This answer reached Clerk’s length limit, so it may be incomplete.';
  return null;
}

/** What Clerk is doing while it answers: the running tool ("Searching documents…"), else thinking. */
export function workingLabel(message: Pick<ClerkMessage, 'status' | 'toolCalls'>): string | null {
  if (message.status !== 'streaming') return null;
  const running = [...message.toolCalls].reverse().find((call) => call.status === 'running');
  return running ? clerkToolLabel(running.name) : null;
}

/** Codes after which Clerk can't answer for a while: the panel says why and points to the manual way. */
const UNAVAILABLE: readonly ErrorCode[] = [
  'CLERK_DISABLED',
  'CLERK_BUDGET_EXCEEDED',
  'CLERK_RATE_LIMITED',
  'CLERK_KEY_INVALID',
  'CLERK_BUSY',
  'CLERK_UNAVAILABLE',
];

/** The manual path, shown whenever Clerk can't answer. */
export const MANUAL_PATH =
  'You can still find this yourself: the matter’s Documents, Deadlines and Tasks tabs have everything Clerk reads.';

/** Why an answer failed, in the error copy's words (the server stores only the code and switch). */
export function answerError(message: Pick<ClerkMessage, 'status' | 'error'>): string | undefined {
  if (message.status !== 'error' && message.status !== 'invalid_output') return undefined;
  if (!message.error) return undefined;
  return errorCopy({ details: { code: message.error.code, switch: message.error.switch } });
}

/** Whether an error means Clerk can't answer for now (switched off, over budget, rate limited…). */
export function isUnavailable(error: unknown): boolean {
  return UNAVAILABLE.includes(errorCodeOf(error));
}

/** Whether the Composer stays off after this error (it won't change by asking again soon). */
export function blocksComposer(error: unknown): boolean {
  return ['CLERK_DISABLED', 'CLERK_BUDGET_EXCEEDED', 'CLERK_KEY_INVALID'].includes(errorCodeOf(error));
}

/** The answer still being written, if any (a thread holds one at a time). */
export function streamingAnswer(messages: readonly ChatMessage[]): ChatMessage | null {
  return messages.find((message) => message.role === 'assistant' && message.status === 'streaming') ?? null;
}

/** The answers Retry may be offered on: the newest message, when it's a finished answer. */
export function retryable(messages: readonly ChatMessage[], message: ChatMessage): boolean {
  return message.role === 'assistant' && message.status !== 'streaming' && messages.at(-1)?.id === message.id;
}

/** The longest finished answer read out whole; a longer one is cut at a word (SEC-06). */
export const SPOKEN_ANSWER_MAX = 600;

/** An answer as screen readers hear it: plain sentences, without Markdown or citation markers. */
export function spokenText(markdown: string): string {
  return (
    parseMarkdown(markdown)
      .map((block) => {
        switch (block.type) {
          case 'code':
            return block.text;
          case 'list':
            return block.items.map((item) => inlineText(item)).join('; ');
          default:
            return inlineText(block.children);
        }
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      // A dropped citation marker leaves a space before the full stop.
      .replace(/ ([.,;:!?])/g, '$1')
      .trim()
  );
}

/**
 * What screen readers hear once an answer stops streaming (SEC-06). The conversation isn't a live
 * region while Clerk writes, so the answer isn't read out token by token; when it finishes it is
 * announced once, politely. A failed answer says nothing here: its own alert says why.
 */
export function answerAnnouncement(message: Pick<ClerkMessage, 'status' | 'content'>): string | null {
  switch (message.status) {
    case 'streaming':
    case 'error':
    case 'invalid_output':
      return null;
    case 'stopped':
      return 'Clerk stopped. This answer is incomplete.';
    case 'refused':
      return 'Clerk declined to answer this.';
  }
  const text = spokenText(messageText(message));
  if (!text) return 'Clerk answered.';
  if (text.length <= SPOKEN_ANSWER_MAX) return `Clerk answered: ${text}`;
  const cut = text.slice(0, SPOKEN_ANSWER_MAX).replace(/\s+\S*$/, '');
  return `Clerk answered: ${cut}… The rest is in the conversation.`;
}
