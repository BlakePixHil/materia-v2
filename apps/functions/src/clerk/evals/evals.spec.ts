import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  EVALS_DIR,
  EvalOutageError,
  fixturePages,
  loadSuite,
  type CaseRequest,
  type EvalCase,
} from '@materia/clerk/evals';

import { fakeModel, main, parseArgs, selectSuites } from './cli';
import {
  caseDocuments,
  caseVariables,
  createEvalExecutor,
  evalKeyring,
  judgeItems,
  matterContext,
  promptPlaceholders,
  textSpans,
} from './executor';
import { ClerkModelError, type ClerkModelPort, type ClerkModelRequest, type ClerkModelResult } from '../../ports';
import { FakeClerkModel, matterBriefStep } from '../providers/fake';

// Fake providers only: no network, and every fixture is fictional.

const privilege = loadSuite('privilege');
const willSuite = loadSuite('will-extraction');

function caseById(id: string): EvalCase {
  const found = [...privilege.cases, ...willSuite.cases, ...loadSuite('chat').cases].find((c) => c.id === id);
  if (!found) throw new Error(id);
  return found;
}

function request(evalCase: EvalCase, over: Partial<CaseRequest> = {}): CaseRequest {
  const suite = evalCase.id.startsWith('we-') ? willSuite.config : privilege.config;
  return { suite, evalCase, promptRef: suite.promptId, feature: suite.feature, run: 1, ...over };
}

function userBlocks(model: FakeClerkModel): { type: string; text?: string }[] {
  return model.requests[0]?.messages[0]?.content as { type: string; text?: string }[];
}

/** A paralegal case with privileged material, and its lawyer control. */
const restricted = privilege.cases.find(
  (c) => c.role === 'paralegal' && c.documents.some((d) => d.privileged) && c.notes.some((n) => n.privileged),
) as EvalCase;

describe('the eval executor', () => {
  it('keeps privileged documents and notes out of a paralegal’s request, as production does', async () => {
    const model = new FakeClerkModel();
    const outcome = await createEvalExecutor({ model, apiKey: 'sk-ant-fake', modelId: 'claude-sonnet-5-5' })(
      request(restricted),
    );
    expect(outcome).toMatchObject({ status: 'done', text: 'Fake Clerk reply.' });
    const sent = JSON.stringify(model.requests[0]);
    for (const canary of privilege.gold.get(restricted.id)?.canaries ?? []) expect(sent).not.toContain(canary);
    expect(userBlocks(model).filter((b) => b.type === 'document')).toHaveLength(
      restricted.documents.filter((d) => !d.privileged).length,
    );

    const lawyer = { ...restricted, role: 'lawyer' as const };
    expect(caseDocuments(lawyer)).toHaveLength(restricted.documents.length);
    expect(matterContext(lawyer)).toContain(restricted.notes.find((n) => n.privileged)?.text);
    expect(matterContext(restricted)).not.toContain(restricted.notes.find((n) => n.privileged)?.text);
  });

  it('keeps privileged passages out of what the chat tools hand a paralegal', async () => {
    const secret = restricted.documents.find((d) => d.privileged) as EvalCase['documents'][number];
    const query = fixturePages(EVALS_DIR, secret.fixture).join(' ').slice(0, 400);
    const run = async (evalCase: EvalCase) => {
      const model = new FakeClerkModel([
        { toolUses: [{ name: 'search_documents', input: { query } }] },
        { chunks: ['Done.'] },
      ]);
      await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })(request(evalCase));
      expect(model.requests).toHaveLength(2);
      return JSON.stringify(model.requests[1]?.messages.slice(-1));
    };
    const toolResult = await run(restricted);
    for (const canary of privilege.gold.get(restricted.id)?.canaries ?? []) expect(toolResult).not.toContain(canary);
    expect(toolResult).not.toContain(secret.id);
    // The control: a lawyer's search reaches the same document.
    expect(await run({ ...restricted, role: 'lawyer' })).toContain(secret.id);
  });

  it('records what a chat answer drafts (AI-06b), without saving anything', async () => {
    const model = new FakeClerkModel([
      {
        toolUses: [
          { name: 'draft_note', input: { text: 'Called Alistair about the valuation.' } },
          { name: 'draft_task', input: { title: 'Call the valuer', dueDate: '2026-03-21' } },
        ],
      },
      { chunks: ['Drafted both: confirm them below.'] },
    ]);
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })(
      request(caseById('chat-015')),
    );
    expect(outcome.drafts).toEqual([
      { kind: 'note', text: 'Called Alistair about the valuation.' },
      { kind: 'task', text: 'Call the valuer · 2026-03-21' },
    ]);
    expect(JSON.stringify(model.requests[1]?.messages.slice(-1))).toContain('waiting below your answer');
  });

  it('drafts letters as production does (AI-10): privileged material stays out of a third-party letter', async () => {
    const drafting = loadSuite('drafting');
    const run = async (id: string) => {
      const evalCase = drafting.cases.find((c) => c.id === id) as EvalCase;
      const model = new FakeClerkModel();
      const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })({
        suite: drafting.config,
        evalCase,
        promptRef: evalCase.promptId ?? drafting.config.promptId,
        feature: drafting.config.feature,
        run: 1,
      });
      return { outcome, sent: JSON.stringify(model.requests[0]) };
    };
    const canaries = drafting.gold.get('draft-004')?.canaries ?? [];
    expect(canaries.length).toBeGreaterThan(0);

    const third = await run('draft-004');
    expect(third.outcome.status).toBe('done');
    expect(third.outcome.text).toContain('[[TO CONFIRM:');
    expect(third.sent).toContain('## Drafting a letter');
    expect(third.sent).toContain('Keane & Doyle Lawyers (other side solicitor on the matter)');
    expect(third.sent).toContain('Australian English');
    for (const canary of canaries) expect(third.sent).not.toContain(canary);
    // The control: a letter to the client may draw on the same privileged advice.
    expect((await run('draft-015')).sent).toContain(canaries[0]);

    expect((await run('draft-008')).sent).toContain('Not on the matter: fee arrangement');
    const rewrite = await run('draft-016');
    expect(rewrite.sent).toContain('## Rewriting part of a letter');
    expect(rewrite.sent).toContain('Firmer, and quote her account number');
  });

  it('forces the model under test, with no availability fallbacks', async () => {
    const model = new FakeClerkModel([{ error: new ClerkModelError('overloaded') }], () => ({
      error: new ClerkModelError('overloaded'),
    }));
    const execute = createEvalExecutor({
      model,
      apiKey: 'k',
      modelId: 'claude-opus-5-5',
      sleep: async () => undefined,
    });
    await expect(execute(request(restricted))).rejects.toBeInstanceOf(EvalOutageError);
    // The gateway's own retries, all on the model under test.
    expect(new Set(model.requests.map((r) => r.model))).toEqual(new Set(['claude-opus-5-5']));
    expect(model.requests).toHaveLength(3);
  });

  it('reports a provider 400 as a defect, not an outage', async () => {
    const model = new FakeClerkModel([{ error: new ClerkModelError('bad_request', 'bad', 400) }]);
    const execute = createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' });
    await expect(execute(request(restricted))).rejects.toMatchObject({ code: 'CLERK_UNAVAILABLE:bad_request' });
    const busy = new FakeClerkModel(Array.from({ length: 3 }, () => ({ error: new ClerkModelError('rate_limited') })));
    await expect(
      createEvalExecutor({ model: busy, apiKey: 'k', modelId: 'claude-sonnet-5-5', sleep: async () => undefined })(
        request(restricted),
      ),
    ).rejects.toMatchObject({ code: 'CLERK_BUSY:rate_limited' });
  });

  it('scores a read-only user’s refusal by the gateway as an empty answer', async () => {
    const readonly = privilege.cases.find((c) => c.role === 'readonly') as EvalCase;
    const model = new FakeClerkModel();
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })(request(readonly));
    expect(outcome).toMatchObject({ status: 'denied', text: '', costMicros: 0 });
    expect(model.requests).toHaveLength(0);
  });

  it('sends PDFs as PDFs and text with page offsets, and validates structured output', async () => {
    const pdfCase = willSuite.cases.find((c) => c.documents.some((d) => d.fixture.endsWith('.pdf'))) as EvalCase;
    const [doc] = caseDocuments(pdfCase);
    expect(doc?.source.kind).toBe('pdf');
    const textCase = willSuite.cases.find((c) => c.documents.every((d) => d.fixture.endsWith('.txt'))) as EvalCase;
    expect(caseDocuments(textCase)[0]?.pageOffsets?.[0]).toBe(0);

    const model = new FakeClerkModel([{ chunks: ['{"not":"a will"}'] }]);
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })(request(textCase));
    expect(outcome.status).toBe('invalid_output');
    expect(model.requests[0]?.output?.name).toBe('willExtraction');
  });

  it('frames classification text by page, as ingestion does (AI-04)', () => {
    const textCase = willSuite.cases.find((c) => c.documents.every((d) => d.fixture.endsWith('.txt'))) as EvalCase;
    const [doc] = caseDocuments(textCase, undefined, 'classification');
    expect(doc?.source).toMatchObject({ kind: 'text', text: expect.stringMatching(/^--- Page 1 ---\n/) });
  });

  it('passes only the variables a prompt uses', () => {
    expect(promptPlaceholders('will-extract@0.1.1')).toEqual(['today']);
    expect(Object.keys(caseVariables('chat-answer@0.1.0', restricted)).sort()).toEqual([
      'matterContext',
      'question',
      'role',
      'today',
    ]);
    expect(() => caseVariables('eval-citation-judge@1.0.0', restricted)).toThrow(/no value for \{\{items\}\}/);
  });

  it('fails loudly if the eval key is rejected', async () => {
    const keyring = evalKeyring('k');
    expect(await keyring.resolve('org')).toEqual({ state: 'ok', apiKey: 'k', version: 'eval' });
    await expect(keyring.markInvalid('org', 'eval', new Date())).rejects.toThrow(/CLERK_EVALS_API_KEY/);
  });
});

describe('citations and the judge', () => {
  const chat = caseById('chat-001');
  const quote = 'appoint';
  const willText = caseDocuments(chat)[0]?.source as { kind: 'text'; text: string };
  const start = willText.text.indexOf(quote);
  const content = [
    { type: 'thinking', thinking: '' },
    {
      type: 'text',
      text: 'The executors are named in clause 2.',
      citations: [
        {
          type: 'char_location',
          document_index: 0,
          cited_text: quote,
          start_char_index: start,
          end_char_index: start + 7,
        },
      ],
    },
    { type: 'text', text: ' Anything else?', citations: null },
  ];

  /** A port that answers with cited text, then with the judge's verdicts. */
  function citingModel(): ClerkModelPort & { requests: ClerkModelRequest[] } {
    const requests: ClerkModelRequest[] = [];
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return {
      requests,
      listModels: async () => [],
      async run(req): Promise<ClerkModelResult> {
        requests.push(req);
        if (req.output?.name === 'citationJudge') {
          const text = JSON.stringify({ verdicts: [{ index: 0, supported: true }] });
          return {
            model: req.model,
            stopReason: 'end_turn',
            text,
            citations: [],
            usage,
            content: [],
            serverFallback: false,
          };
        }
        return {
          model: req.model,
          stopReason: 'end_turn',
          text: 'The executors are named in clause 2. Anything else?',
          citations: content.flatMap((b) => ('citations' in b ? (b.citations ?? []) : [])),
          usage,
          content,
          serverFallback: false,
        };
      },
    };
  }

  it('offers a file’s key dates through production’s checks, leaving out what the matter records', async () => {
    const events = loadSuite('events-from-file');
    const evalCase = events.cases.find((c) => c.id === 'evf-005') as EvalCase;
    const outcome = await createEvalExecutor({ model: fakeModel(), apiKey: 'k', modelId: 'claude-sonnet-5-5' })({
      suite: events.config,
      evalCase,
      promptRef: events.config.promptId,
      feature: 'eventsExtraction',
      run: 1,
    });
    // The fake lists the filing too (its note states it); the matter already records it, so it isn't offered.
    expect((outcome.parsed as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual([
      'probate_filed',
      'caveat_lodged',
    ]);
    expect(outcome.proposedEvents).toEqual([{ kind: 'caveat_lodged', date: '2026-03-03' }]);
  });

  it('offers letters through production’s checks (AI-10b): only this matter’s types, to its parties', async () => {
    const suite = loadSuite('chat-proposals');
    const evalCase = suite.cases.find((c) => c.id === 'cp-001') as EvalCase;
    const letter = (typeId: string, partyIds: string[], instructions = '') => ({
      kind: 'letter',
      payload: { typeId, partyIds, instructions },
      rationale: 'The grant has issued.',
      citations: [],
    });
    const proposals = [
      letter('grant-notification', ['p-beneficiary-1', 'p-beneficiary-2', 'p-nobody-9'], 'Say the grant issued.'),
      // Not a letter Clerk drafts on a probate matter, and not a letter at all.
      letter('larke-v-nugus', []),
      letter('made-up', []),
      // The general letter needs instructions.
      letter('letter', []),
    ];
    const model = new FakeClerkModel([{ chunks: [JSON.stringify({ proposals })] }]);
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })({
      suite: suite.config,
      evalCase,
      promptRef: suite.config.promptId,
      feature: 'chatProposals',
      run: 1,
    });
    expect(outcome.status).toBe('done');
    expect(outcome.proposals).toEqual([
      {
        kind: 'letter',
        text: 'grant-notification · Say the grant issued.',
        typeId: 'grant-notification',
        partyIds: ['p-beneficiary-1', 'p-beneficiary-2'],
      },
    ]);
    const sent = JSON.stringify(model.requests[0]?.messages);
    expect(sent).toContain('- grant-notification: ');
    expect(sent).not.toContain('larke-v-nugus');
    expect(sent).toContain('Who do we need to tell?');
    expect(sent).toContain('Megan Ashby and Paul Ashby, should be told');
  });

  it('writes a matter brief from production’s facts and checks, without privileged records (AI-06c)', async () => {
    const briefs = loadSuite('matter-brief');
    const evalCase = briefs.cases.find((c) => c.id === 'mb-003') as EvalCase;
    const model = new FakeClerkModel([], matterBriefStep);
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5' })({
      suite: briefs.config,
      evalCase,
      promptRef: briefs.config.promptId,
      feature: 'matterBrief',
      run: 1,
    });
    // The fake writes one line per fact it is given: the claim deadline and the letter, nothing privileged.
    expect(outcome.brief).toEqual({
      written: 2,
      kept: 2,
      refs: ['deadline:dl-claim', 'document:doc-letter'],
    });
    const sent = JSON.stringify(model.requests);
    for (const canary of briefs.gold.get('mb-003')?.canaries ?? []) expect(sent).not.toContain(canary);
    expect(sent).toContain('kind=\\"brief\\"');
  });

  it('splits the reply into cited and uncited spans', () => {
    expect(textSpans(content)).toEqual([
      { text: 'The executors are named in clause 2.', cited: true },
      { text: ' Anything else?', cited: false },
    ]);
  });

  it('maps API citations to quotes and runs the judge when asked', async () => {
    const model = citingModel();
    const chatSuite = loadSuite('chat').config;
    const outcome = await createEvalExecutor({ model, apiKey: 'k', modelId: 'claude-sonnet-5-5', judge: true })({
      suite: chatSuite,
      evalCase: chat,
      promptRef: chatSuite.promptId,
      feature: 'chat',
      run: 1,
    });
    expect(outcome.citations).toEqual([{ documentId: chat.documents[0]?.id, page: 1, quote }]);
    expect(outcome.judge).toMatchObject({ supported: 1, judged: 1 });
    expect(outcome.judge?.costMicros).toBeGreaterThan(0);
    const judgeRequest = model.requests[1];
    expect(judgeRequest?.messages[0]?.content).toHaveLength(1);
    expect(JSON.stringify(judgeRequest)).toContain('Claim: The executors are named in clause 2.');
  });

  it('builds judge items only for citations it can place', () => {
    expect(judgeItems(content, [], new Map())).toEqual([]);
    const items = judgeItems(
      content,
      [{ kind: 'document', documentId: 'd', docVersion: 1, quote }],
      new Map([['d', ['the page']]]),
    );
    expect(items[0]).toContain('Page text: the page');
  });

  it('gives the judge every page of a quote that runs over a page break', () => {
    const padded = [
      { type: 'text', text: 'The gift lapses.', citations: [{ type: 'page_location', cited_text: ` ${quote}\n` }] },
    ];
    const items = judgeItems(
      padded,
      [{ kind: 'document', documentId: 'd', docVersion: 1, page: 2, pageEnd: 3, quote }],
      new Map([['d', ['one', 'two', 'three', 'four']]]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('Page text: two\nthree');
  });
});

describe('the eval CLI', () => {
  const io = (env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        env,
        stdout: (line: string) => void out.push(line),
        stderr: (line: string) => void err.push(line),
        now: () => new Date('2026-03-20T00:00:00Z'),
        sleep: async () => undefined,
      },
    };
  };

  it('parses its options', () => {
    expect(parseArgs(['--feature=chat', '--subset', '--model=claude-opus-5-5', '--runs=2', '--judge'])).toMatchObject({
      feature: 'chat',
      subset: true,
      model: 'claude-opus-5-5',
      runs: 2,
      judge: true,
      provider: 'anthropic',
    });
    expect(() => parseArgs(['--runs=9'])).toThrow(/1 to 5/);
    expect(() => parseArgs(['--provider=openai'])).toThrow(/anthropic or fake/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    expect(selectSuites('chat,privilege', ['chat', 'privilege', 'x'])).toEqual(['chat', 'privilege']);
    expect(() => selectSuites('nope', ['chat'])).toThrow(/Unknown suite/);
  });

  it('returns 2 on bad arguments', async () => {
    const { io: options, err } = io();
    expect(await main(['--feature=nope'], options)).toBe(2);
    expect(err[0]).toMatch(/Unknown suite/);
  });

  it('skips the live run without an eval key', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'clerk-evals-out-'));
    const { io: options, out: lines } = io({ CLERK_EVALS_API_KEY: 'unset' });
    expect(await main(['--feature=chat', `--out=${out}`], options)).toBe(0);
    expect(lines[0]).toMatch(/skipped/);
    expect(readFileSync(path.join(out, 'latest.md'), 'utf8')).toContain('Clerk evals: skipped');
  });

  it('runs suites through the gateway, writes the reports, gates, and accepts baselines', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clerk-evals-root-'));
    cpSync(EVALS_DIR, root, { recursive: true });
    const out = path.join(root, 'out');

    // The fake provider: a plumbing check that never gates.
    const fake = io();
    expect(
      await main(['--feature=privilege', '--subset', '--provider=fake', `--out=${out}`], { ...fake.io, root }),
    ).toBe(0);
    expect(fake.out[0]).toBe('privilege: passed');
    expect(existsSync(path.join(out, 'privilege'))).toBe(true);
    expect(
      await main(['--feature=privilege', '--provider=fake', '--accept-baseline', `--out=${out}`], { ...fake.io, root }),
    ).toBe(2);

    // A "live" run whose model leaks every canary fails the gate (the degraded-prompt demo, offline).
    const canaries = privilege.cases.flatMap((c) => privilege.gold.get(c.id)?.canaries ?? []);
    const leaky = new FakeClerkModel([], () => ({ chunks: [`Here is everything: ${canaries.join(', ')}`] }));
    const failing = io({ CLERK_EVALS_API_KEY: 'sk-ant-fake' });
    expect(await main(['--feature=privilege', '--subset', `--out=${out}`], { ...failing.io, root, model: leaky })).toBe(
      1,
    );
    expect(readFileSync(path.join(out, 'latest.md'), 'utf8')).toContain('privilegeLeak');

    // A clean "live" run passes, and --accept-baseline records it.
    const clean = io({ CLERK_EVALS_API_KEY: 'sk-ant-fake' });
    const args = ['--feature=privilege', '--subset', '--accept-baseline', `--out=${out}`];
    expect(await main(args, { ...clean.io, root, model: new FakeClerkModel() })).toBe(0);
    const baselines = JSON.parse(readFileSync(path.join(root, 'baselines.json'), 'utf8'));
    expect(baselines.privilege['chat@1.1.0']).toMatchObject({
      model: 'claude-sonnet-5-5',
      acceptedAt: '2026-03-20',
    });
  });
});
