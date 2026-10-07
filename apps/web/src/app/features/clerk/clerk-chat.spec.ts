import type { InMemoryFirestore } from '@materia/data-access/repository';
import { DomainError } from '@materia/domain';

import {
  answerError,
  CHAT_COMMANDS,
  MANUAL_PATH,
  messageNote,
  messageState,
  retryable,
  scopeLabel,
  workingLabel,
  type ChatMessage,
} from './clerk-chat-view';
import { CLERK_DISABLED_COPY } from '../../core/error-copy';
import { resetPerformanceMonitoring, startPerformanceMonitoring } from '../../core/observability/perf';
import { storedDocument } from '../documents/testing';
import {
  cleanUpOverlays,
  MATTER,
  ME,
  meta,
  openMatter,
  ORG,
  PRIYA,
  type FakeCallable,
  type OpenOptions,
} from '../matter-detail/testing';

/** The Clerk chat panel (AI-06): the ⌘J panel on a matter, against fake `clerk-*` callables. Fictional data only. */

afterEach(cleanUpOverlays);

const FLAGS = { 'clerk.enabled': true, 'clerk.features.chat': true, 'clerk.features.suggestions': true };
const THREADS = `orgs/${ORG}/clerkThreads`;
type Seed = Record<string, unknown>;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 1, minute));

function threadDoc(data: Seed = {}): Seed {
  return {
    title: 'Who is the executor?',
    ownerUid: ME,
    matterId: 'm-whitfield',
    shared: false,
    privileged: false,
    lastMessageAt: at(1),
    deletedAt: null,
    ...meta,
    ...data,
  };
}

function messageDoc(role: 'user' | 'assistant', text: string, data: Seed = {}): Seed {
  return {
    role,
    content: [{ type: 'text', text }],
    citations: [],
    status: 'done',
    stopRequested: false,
    toolCalls: [],
    suggestionIds: [],
    privileged: false,
    ...meta,
    createdAt: at(1),
    ...data,
  };
}

/** `clerk-*` as the server answers at once: the question and a streaming answer (written later by the test). */
function chatCallables(): Record<string, FakeCallable> {
  let n = 0;
  return {
    'clerk-sendMessage': (data, fs) => {
      n++;
      const threadId = (data['threadId'] as string | undefined) ?? `t-new-${n}`;
      if (!data['threadId']) fs.set(`${THREADS}/${threadId}`, threadDoc({ title: String(data['text']) }));
      const base = `${THREADS}/${threadId}/messages`;
      fs.set(`${base}/q-${n}`, messageDoc('user', String(data['text']), { createdAt: at(10 + n) }));
      fs.set(
        `${base}/a-${n}`,
        messageDoc('assistant', '', { status: 'streaming', replyTo: `q-${n}`, createdAt: at(10 + n) }),
      );
      return { threadId, userMessageId: `q-${n}`, messageId: `a-${n}` };
    },
    'clerk-retryMessage': (data, fs) => {
      const id = `a-retry-${++n}`;
      fs.set(
        `${THREADS}/${String(data['threadId'])}/messages/${id}`,
        messageDoc('assistant', '', { status: 'streaming', replyTo: 'q-1', createdAt: at(30) }),
      );
      return { messageId: id };
    },
    'clerk-setFeedback': (data) => ({ messageId: data['messageId'] }),
  };
}

async function open(options: OpenOptions = {}) {
  const page = await openMatter(undefined, {
    flags: FLAGS,
    ...options,
    callables: { ...chatCallables(), ...options.callables },
    configure: (fs, port) => {
      fs.set(`${MATTER}/documents/doc-will`, storedDocument('doc-will', 'Will of Fictional Whitfield.pdf'));
      options.configure?.(fs, port);
    },
  });
  await page.press('j', { ctrlKey: true });
  await page.stable(10);
  const panel = () => page.body.querySelector<HTMLElement>('#clerk-panel');
  const composer = () => panel()?.querySelector<HTMLTextAreaElement>('mt-composer textarea');
  const ask = async (text: string) => {
    const input = composer();
    if (!input) throw new Error('No composer');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await page.stable(10);
  };
  /** The server writing the answer. */
  const answer = async (path: string, data: Seed) => {
    page.firestore.set(path, { ...page.firestore.get(path), ...data });
    await page.stable(10);
  };
  return { ...page, panel, composer, ask, answer };
}

describe('clerk chat view', () => {
  const message = (data: Seed) => ({ id: 'a', ...messageDoc('assistant', 'x', data) }) as unknown as ChatMessage;

  it('labels the scope with its attachments', () => {
    expect(scopeLabel('M-2026-0142', 0)).toBe('M-2026-0142');
    expect(scopeLabel('M-2026-0142', 1)).toBe('M-2026-0142 · 1 attachment');
    expect(scopeLabel('M-2026-0142', 3)).toBe('M-2026-0142 · 3 attachments');
  });

  it('lists /summarise and /draft, and the commands still to come as disabled', () => {
    expect(CHAT_COMMANDS.filter((command) => !command.disabled).map((command) => command.name)).toEqual([
      'summarise',
      'draft',
    ]);
    expect(CHAT_COMMANDS.filter((command) => command.disabled).map((command) => command.name)).toEqual([
      'chronology',
      'timeline',
    ]);
  });

  it('shows the running tool, and says plainly when an answer was refused or cut short', () => {
    expect(
      workingLabel(message({ status: 'streaming', toolCalls: [{ name: 'search_documents', status: 'running' }] })),
    ).toBe('Searching documents…');
    expect(workingLabel(message({ status: 'done', toolCalls: [{ name: 'get_tasks', status: 'running' }] }))).toBeNull();
    expect(messageState(message({ status: 'refused' }))).toBe('done');
    expect(messageNote(message({ status: 'refused' }))).toContain('declined');
    expect(messageNote(message({ status: 'truncated' }))).toContain('length limit');
    expect(messageState(message({ status: 'invalid_output' }))).toBe('error');
    expect(answerError(message({ status: 'error', error: { code: 'CLERK_RATE_LIMITED' } }))).toContain(
      'asked Clerk a lot',
    );
  });

  it('offers Retry on the newest finished answer only', () => {
    const first = message({});
    const last = { ...message({}), id: 'b' } as ChatMessage;
    expect(retryable([first, last], last)).toBe(true);
    expect(retryable([first, last], first)).toBe(false);
    expect(retryable([{ ...last, status: 'streaming' } as ChatMessage], { ...last, status: 'streaming' })).toBe(false);
  });
});

describe('Clerk chat panel', () => {
  it('asks about the matter and shows the answer as it streams, with the tool Clerk is using', async () => {
    const page = await open();
    expect(page.text(page.panel())).toContain('Ask Clerk about M-2026-0142');
    expect(page.text(page.panel()?.querySelector('mt-composer'))).toContain('Asking about M-2026-0142');

    await page.ask('Who is the executor?');
    expect(page.calls('clerk-sendMessage')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', text: 'Who is the executor?', attachments: [] }),
    ]);
    expect(page.text(page.panel()?.querySelector('mt-user-message'))).toBe('Who is the executor?');
    expect(page.text(page.panel())).toContain('Reading the matter…');

    const path = `${THREADS}/t-new-1/messages/a-1`;
    await page.answer(path, { toolCalls: [{ id: 'x', name: 'search_documents', status: 'running' }] });
    expect(page.text(page.panel()?.querySelector('mt-clerk-working'))).toContain('Searching documents…');
    expect(page.panel()?.querySelector('mt-composer button[aria-label="Stop"]')).not.toBeNull();

    await page.answer(path, {
      toolCalls: [{ id: 'x', name: 'search_documents', status: 'done' }],
      content: [{ type: 'text', text: 'Avery Quill is the executor.' }],
    });
    expect(page.panel()?.querySelector('mt-clerk-working')).toBeNull();
    await page.answer(path, { status: 'done' });
    expect(page.text(page.panel()?.querySelector('mt-clerk-message'))).toContain('Avery Quill is the executor.');
    expect(page.buttons('Copy', page.panel() ?? undefined)).toHaveLength(1);
    expect(page.buttons('Retry', page.panel() ?? undefined)).toHaveLength(1);
  });

  it.each([
    ['clerk.features.chat', CLERK_DISABLED_COPY.featureKillSwitch],
    ['clerk.enabled', CLERK_DISABLED_COPY.killSwitch],
  ])('says when %s is off on Materia’s side, so nobody hunts through Settings for it', async (flag, copy) => {
    const page = await open({ flags: { ...FLAGS, [flag]: false } });
    const note = page.text(page.panel()?.querySelector('[data-clerk-off]'));
    expect(note).toContain(copy);
    expect(note).toContain(MANUAL_PATH);
  });

  it('times Clerk’s first words from Send and from Retry, and not an answer that ends without any', async () => {
    const traces: string[] = [];
    startPerformanceMonitoring(async () => (name) => void (name === 'clerk_first_token' && traces.push(name)));
    try {
      const page = await open();
      await page.ask('Who is the executor?');
      await page.answer(`${THREADS}/t-new-1/messages/a-1`, {
        toolCalls: [{ id: 'x', name: 'search_documents', status: 'running' }],
      });
      expect(traces).toEqual([]);
      await page.answer(`${THREADS}/t-new-1/messages/a-1`, { content: [{ type: 'text', text: 'Avery' }] });
      expect(traces).toEqual(['clerk_first_token']);
      await page.answer(`${THREADS}/t-new-1/messages/a-1`, {
        status: 'done',
        content: [{ type: 'text', text: 'Avery Quill.' }],
      });
      expect(traces).toEqual(['clerk_first_token']);

      await page.click('Retry', page.panel() ?? undefined);
      await page.answer(`${THREADS}/t-new-1/messages/a-retry-2`, {
        status: 'error',
        error: { code: 'CLERK_RATE_LIMITED' },
      });
      expect(traces).toEqual(['clerk_first_token']);
    } finally {
      resetPerformanceMonitoring();
    }
  });

  it('stops an answer by setting stopRequested', async () => {
    const page = await open();
    await page.ask('Tell me everything.');
    await page.click('Stop', page.panel() ?? undefined);
    expect(page.firestore.get(`${THREADS}/t-new-1/messages/a-1`)?.['stopRequested']).toBe(true);
    await page.answer(`${THREADS}/t-new-1/messages/a-1`, {
      status: 'stopped',
      content: [{ type: 'text', text: 'Partial answer' }],
    });
    expect(page.text(page.panel())).toContain('Stopped. This answer is incomplete.');
  });

  it('retries as a new answer and rates an answer down with a reason', async () => {
    const page = await open();
    await page.ask('Who is the executor?');
    await page.answer(`${THREADS}/t-new-1/messages/a-1`, {
      status: 'done',
      content: [{ type: 'text', text: 'Avery Quill.' }],
    });
    await page.click('Not helpful', page.panel() ?? undefined);
    await page.click('Missing or wrong sources', page.panel() ?? undefined);
    expect(page.calls('clerk-setFeedback')).toEqual([
      expect.objectContaining({ threadId: 't-new-1', messageId: 'a-1', rating: 'down', reason: 'missing_sources' }),
    ]);
    await page.click('Retry', page.panel() ?? undefined);
    expect(page.calls('clerk-retryMessage')).toEqual([
      expect.objectContaining({ threadId: 't-new-1', messageId: 'a-1' }),
    ]);
    // The earlier answer is still there; the new one is answering.
    expect(page.text(page.panel())).toContain('Avery Quill.');
    expect(page.panel()?.querySelector('mt-composer button[aria-label="Stop"]')).not.toBeNull();
  });

  it('attaches documents and shows them in the scope chip', async () => {
    const page = await open();
    await page.click('Attach a file', page.panel() ?? undefined);
    page.panel()?.querySelector<HTMLElement>('mt-checkbox button')?.click();
    await page.stable(10);
    expect(page.text(page.panel()?.querySelector('mt-composer'))).toContain('Asking about M-2026-0142 · 1 attachment');
    await page.ask('What does the will say?');
    expect(page.calls('clerk-sendMessage')[0]).toMatchObject({ attachments: ['doc-will'] });
  });

  it('says why Clerk can’t answer and points to the manual way', async () => {
    const page = await open({
      callables: {
        'clerk-sendMessage': () => {
          throw new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk budget used', { period: 'clerk-2026-10' });
        },
      },
    });
    await page.ask('Who is the executor?');
    expect(page.text(page.panel())).toContain('used this month’s Clerk allowance');
    expect(page.text(page.panel())).toContain('Documents, Deadlines and Tasks tabs');
    expect(page.composer()?.disabled).toBe(true);
    // The question is given back, so nothing typed is lost.
    expect(page.composer()?.value).toBe('Who is the executor?');
  });

  it('shows a refusal honestly and an answer’s proposed suggestion as a card', async () => {
    const page = await open({
      configure: (fs: InMemoryFirestore) => {
        fs.set(`${THREADS}/t-1`, threadDoc());
        fs.set(`${THREADS}/t-1/messages/q-1`, messageDoc('user', 'Draft a threatening letter.'));
        fs.set(
          `${THREADS}/t-1/messages/a-1`,
          messageDoc('assistant', 'I can’t help with that request.', { status: 'refused', replyTo: 'q-1' }),
        );
        fs.set(`${THREADS}/t-1/messages/q-2`, messageDoc('user', 'What is left to do?', { createdAt: at(2) }));
        fs.set(
          `${THREADS}/t-1/messages/a-2`,
          messageDoc('assistant', 'Certified copies are still needed.', {
            replyTo: 'q-2',
            createdAt: at(2),
            suggestionIds: ['s-1'],
          }),
        );
        fs.set(`${MATTER}/suggestions/s-1`, {
          kind: 'task',
          payload: { title: 'Request certified copies of the death certificate', priority: 'medium' },
          citations: [],
          rationale: 'Copies are still needed (fictional).',
          status: 'proposed',
          promptId: 'chat-proposals',
          promptVersion: '1.0.0',
          model: 'test-model',
          privileged: false,
          basis: 'b-1',
          basisParts: {},
          dedupeKey: 'task:copies',
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          orgId: ORG,
          matterId: 'm-whitfield',
          ...meta,
          createdBy: 'clerk',
        });
      },
    });
    await page.click('Threads', page.panel() ?? undefined);
    await page.click('Who is the executor?', page.panel()?.querySelector('#mt-clerk-threads') ?? undefined);
    await page.stable(10);
    expect(page.text(page.panel())).toContain('I can’t help with that request.');
    expect(page.text(page.panel())).toContain('Clerk declined to answer this.');
    expect(page.text(page.panel()?.querySelector('mt-suggestion-card'))).toContain(
      'Request certified copies of the death certificate',
    );
  });

  it('lists threads shared with the matter team, read-only to everyone but their owner', async () => {
    const page = await open({
      configure: (fs: InMemoryFirestore) => {
        fs.set(`${THREADS}/t-mine`, threadDoc({ title: 'My question', lastMessageAt: at(5) }));
        fs.set(`${THREADS}/t-shared`, threadDoc({ title: 'Priya’s question', ownerUid: PRIYA, shared: true }));
        fs.set(`${THREADS}/t-private`, threadDoc({ title: 'Priya’s private question', ownerUid: PRIYA }));
        fs.set(`${THREADS}/t-shared/messages/q-1`, messageDoc('user', 'What is due next?'));
      },
    });
    await page.click('Threads', page.panel() ?? undefined);
    const list = page.panel()?.querySelector('#mt-clerk-threads');
    expect(page.text(list)).toContain('My question');
    const shared = [...(list?.querySelectorAll('button') ?? [])].find((b) =>
      page.text(b).startsWith('Priya’s question'),
    );
    expect(page.text(shared?.querySelector('mt-badge'))).toBe('Shared');
    expect(page.text(list)).not.toContain('private');
    await page.click('Priya’s question', list ?? undefined);
    expect(page.text(page.panel())).toContain('What is due next?');
    expect(page.composer()?.disabled).toBe(true);
    expect(page.panel()?.querySelector('mt-switch')).toBeNull();
  });

  it('shares a thread with the matter team', async () => {
    const page = await open({
      configure: (fs: InMemoryFirestore) => fs.set(`${THREADS}/t-mine`, threadDoc({ title: 'My question' })),
    });
    await page.click('Threads', page.panel() ?? undefined);
    await page.click('My question', page.panel()?.querySelector('#mt-clerk-threads') ?? undefined);
    page.panel()?.querySelector<HTMLElement>('mt-switch button, mt-switch [role="switch"]')?.click();
    await page.stable(10);
    expect(page.firestore.get(`${THREADS}/t-mine`)?.['shared']).toBe(true);
  });

  it('opens Clerk drafting from /draft with what follows as the instructions (AI-10)', async () => {
    const page = await open({ flags: { ...FLAGS, 'clerk.features.drafting': true } });
    await page.ask('/draft ask the bank for the balance at the date of death');
    await page.stable(10);
    expect(page.calls('clerk-sendMessage')).toEqual([]);
    expect(page.router.url).toBe(
      '/matters/m-whitfield/drafts/new?instructions=ask%20the%20bank%20for%20the%20balance%20at%20the%20date%20of%20death',
    );
    expect(page.panel()).toBeNull();
  });

  it('says drafting is off rather than sending /draft as a question', async () => {
    const page = await open();
    await page.ask('/draft a letter to the bank');
    expect(page.calls('clerk-sendMessage')).toEqual([]);
    expect(page.text(page.panel())).toContain('Clerk drafting isn’t turned on for your practice.');
    expect(page.composer()?.value).toBe('/draft a letter to the bank');
  });
});
