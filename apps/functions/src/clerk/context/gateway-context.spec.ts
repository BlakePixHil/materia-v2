import { createLog } from '../../core/log';
import { FakeClock } from '../../ports/fakes';
import { createClerkGateway } from '../gateway';
import { FakeClerkModel } from '../providers/fake';
import { MemoryClerkStore, MemoryKeyring } from '../testing';
import { createContextBuilder } from './build-context';
import { CANARY, DOCUMENT_TEXT, fixtureOrgs, HITS, MATTER, ORG, USERS } from './fixtures';
import { CONTEXT_POLICIES } from './policy';
import { charEstimateCounter } from './ports';
import { FakeChunkSearch, FakeDocumentText, MemoryContextSource } from './testing';

const HELLO_JSON = JSON.stringify({ greeting: 'Hello there.', promptRef: 'hello@1.0.0' });

/** The gateway with a built context (AI-03): layout, privilege and truncation on the result and message. */
function setup(budgetTokens: number = CONTEXT_POLICIES.chat.budgetTokens, citationText?: FakeDocumentText) {
  const clock = new FakeClock(new Date('2026-10-04T22:30:00Z'));
  const log = createLog({ fn: 'test' }, () => undefined);
  const model = new FakeClerkModel([{ chunks: [HELLO_JSON] }]);
  const store = new MemoryClerkStore();
  const gateway = createClerkGateway({
    model,
    store,
    keyring: new MemoryKeyring(),
    flag: async () => true,
    sleep: async () => undefined,
    ...(citationText ? { citationText } : {}),
  });
  const builder = createContextBuilder({
    source: new MemoryContextSource(fixtureOrgs()),
    chunks: new FakeChunkSearch(HITS),
    documentText: new FakeDocumentText(DOCUMENT_TEXT),
    tokens: charEstimateCounter,
    policies: { ...CONTEXT_POLICIES, chat: { budgetTokens, scopes: ['matter'] } },
  });
  const ctx = (role: 'lawyer' | 'paralegal') => ({
    orgId: ORG,
    uid: USERS[role],
    role,
    requestId: 'req-1',
    log,
    clock,
  });
  return { model, store, gateway, builder, ctx };
}

describe('ClerkGateway with a built context', () => {
  it('puts the system prompt and matter facts first, then documents and excerpts, then notices and the question', async () => {
    const { model, gateway, builder, ctx } = setup();
    const context = await builder.buildContext({
      ctx: ctx('lawyer'),
      scope: { matterId: MATTER },
      feature: 'chat',
      attachments: ['d-will', 'd-scanning'],
      query: 'Who gets the residue?',
    });
    await gateway.run({
      ctx: ctx('lawyer'),
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the team', promptRef: 'hello@1.0.0' },
      context,
    });
    const request = model.requests[0];
    expect(request?.system.startsWith('You are Clerk, the assistant inside Materia')).toBe(true);
    expect(request?.system).toContain('This is a connectivity check');
    const content = request?.messages[0]?.content as { type: string; text?: string; cache?: boolean }[];
    expect(content.map((block) => block.type)).toEqual(['text', 'document', 'search_result', 'text', 'text']);
    expect(content[0]?.text).toContain('<matter_facts');
    expect(content.map((block) => !!block.cache)).toEqual([true, false, false, false, false]);
    expect(content[3]?.text).toContain('1 document still processing');
    expect(content[4]?.text).toContain('Say hello to the team');
  });

  it('returns and stores the manifest; a privileged source makes the reply privileged', async () => {
    const { gateway, builder, ctx, store } = setup();
    const context = await builder.buildContext({
      ctx: ctx('lawyer'),
      scope: { matterId: MATTER },
      feature: 'chat',
      query: 'prospects',
    });
    const result = await gateway.run({
      ctx: ctx('lawyer'),
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the team', promptRef: 'hello@1.0.0' },
      context,
      stream: { threadId: 't-1', messageId: 'm-1' },
    });
    expect(result).toMatchObject({
      privileged: true,
      truncated: null,
      manifest: { scope: { kind: 'matter', matterId: MATTER } },
    });
    expect(store.messages.get('t-1/m-1')?.manifest).toEqual(context.manifest);
  });

  it('surfaces truncation on the result, and a paralegal’s request carries no privileged text', async () => {
    const { model, gateway, builder, ctx } = setup(1_000);
    const context = await builder.buildContext({
      ctx: ctx('paralegal'),
      scope: { matterId: MATTER },
      feature: 'chat',
      attachments: ['d-will'],
      query: 'prospects',
    });
    const result = await gateway.run({
      ctx: ctx('paralegal'),
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the team', promptRef: 'hello@1.0.0' },
      context,
    });
    expect(result.privileged).toBe(false);
    expect(result.truncated).toMatchObject({ droppedDocs: 1 });
    expect(JSON.stringify(model.requests)).not.toContain(CANARY);
  });

  it('verifies a matter reply’s citations against the chunks: fabricated quotes are flagged and counted', async () => {
    const { model, gateway, builder, ctx, store } = setup(undefined, new FakeDocumentText(DOCUMENT_TEXT));
    const context = await builder.buildContext({
      ctx: ctx('lawyer'),
      scope: { matterId: MATTER },
      feature: 'chat',
      query: 'Who gets the residue?',
    });
    const residue = context.searchResults.findIndex((chunk) => chunk.documentId === 'd-will' && chunk.page === 2);
    expect(residue).toBeGreaterThanOrEqual(0);
    model.push({
      chunks: ['Quinn Ashdown takes the residue.'],
      citations: [
        {
          type: 'search_result_location',
          search_result_index: residue,
          cited_text: 'I give the residue to Quinn Ashdown.',
        },
        {
          type: 'search_result_location',
          search_result_index: residue,
          cited_text: 'I give my boat to Quinn Ashdown.',
        },
      ],
    });
    // The setup's scripted hello reply goes first; the cited answer is the second call.
    await gateway.run({
      ctx: ctx('lawyer'),
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the team', promptRef: 'hello@1.0.0' },
    });
    const result = await gateway.run({
      ctx: ctx('lawyer'),
      feature: 'chat',
      promptId: 'chat-answer',
      vars: { today: 'Monday 5 October 2026', role: 'lawyer', matterContext: '', question: 'Who gets the residue?' },
      context,
      stream: { threadId: 't-1', messageId: 'm-1' },
    });
    expect(result.citations).toEqual([
      { kind: 'document', documentId: 'd-will', docVersion: 2, page: 2, quote: 'I give the residue to Quinn Ashdown.' },
      {
        kind: 'document',
        documentId: 'd-will',
        docVersion: 2,
        page: 2,
        quote: 'I give my boat to Quinn Ashdown.',
        verified: false,
      },
    ]);
    const final = store.messages.get('t-1/m-1')?.final;
    expect(final?.text).toBe('Quinn Ashdown takes the residue.[1, 2]');
    expect(final?.citations).toEqual(result.citations);
    expect(store.meters.at(-1)?.entry.citations).toEqual({ verified: 1, unverified: 1 });
  });
});
