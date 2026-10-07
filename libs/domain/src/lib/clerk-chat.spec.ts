import {
  CLERK_CHAT_COMMANDS,
  CLERK_CHAT_DRAFT_TOOLS,
  CLERK_CHAT_TOOLS,
  clerkToolLabel,
  parseClerkCommand,
  parseDraftCommand,
  SendClerkMessageInput,
  SetClerkFeedbackInput,
  SUMMARISE_DEFAULT_QUESTION,
} from './clerk-chat';
import { ClerkMessage, ClerkThread } from './schemas/clerk';

const REQUEST_ID = '9b2f6a0e-4c1d-4e8a-9f3b-2a7c5d1e0f42';

describe('Clerk chat (AI-06)', () => {
  it('reads an available command and leaves the others as plain text', () => {
    expect(parseClerkCommand('/summarise the estate accounts')).toEqual({
      command: 'summarise',
      question: 'the estate accounts',
    });
    expect(parseClerkCommand('  /summarise  ')).toEqual({ command: 'summarise', question: SUMMARISE_DEFAULT_QUESTION });
    expect(parseClerkCommand('/draft a letter to the bank')).toEqual({
      command: null,
      question: '/draft a letter to the bank',
    });
    expect(parseClerkCommand('Who are the executors?')).toEqual({ command: null, question: 'Who are the executors?' });
    expect(CLERK_CHAT_COMMANDS.filter((c) => c.available).map((c) => c.name)).toEqual(['summarise', 'draft']);
  });

  it('reads /draft as instructions for Clerk drafting (AI-10), which never reach the chat', () => {
    expect(parseDraftCommand('/draft  a letter to the bank\nabout the accounts ')).toEqual({
      instructions: 'a letter to the bank\nabout the accounts',
    });
    expect(parseDraftCommand('/draft')).toEqual({ instructions: '' });
    expect(parseDraftCommand('/drafting')).toBeNull();
    expect(parseDraftCommand('Please /draft')).toBeNull();
  });

  it('labels every tool, and anything else as working', () => {
    for (const tool of [...CLERK_CHAT_TOOLS, ...CLERK_CHAT_DRAFT_TOOLS]) expect(clerkToolLabel(tool)).toMatch(/…$/);
    expect(clerkToolLabel('search_documents')).toBe('Searching documents…');
    expect(clerkToolLabel('draft_note')).toBe('Drafting a note…');
    expect(clerkToolLabel('unknown')).toBe('Working…');
  });

  it('validates a question: trimmed, not empty, at most 10 attachments', () => {
    const base = { requestId: REQUEST_ID, matterId: 'm-1', text: '  Who are the executors?  ' };
    expect(SendClerkMessageInput.parse(base)).toMatchObject({ text: 'Who are the executors?', attachments: [] });
    expect(SendClerkMessageInput.safeParse({ ...base, text: '   ' }).success).toBe(false);
    expect(SendClerkMessageInput.safeParse({ ...base, matterId: 'a/b' }).success).toBe(false);
    expect(
      SendClerkMessageInput.safeParse({ ...base, attachments: Array.from({ length: 11 }, (_, i) => `d-${i}`) }).success,
    ).toBe(false);
    expect(
      SetClerkFeedbackInput.safeParse({ requestId: REQUEST_ID, threadId: 't', messageId: 'm', rating: 'sideways' })
        .success,
    ).toBe(false);
  });

  it('lets a client change only a thread’s title and sharing, and a message’s stop request', () => {
    expect(Object.keys(ClerkThread.update.shape).sort()).toEqual(['shared', 'title']);
    expect(Object.keys(ClerkMessage.update.shape)).toEqual(['stopRequested']);
    expect(ClerkMessage.update.safeParse({ feedback: { rating: 'up' } }).success).toBe(false);
    expect(ClerkThread.update.safeParse({ privileged: false }).success).toBe(false);
  });
});
