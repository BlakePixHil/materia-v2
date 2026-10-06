import * as z from 'zod';

import type { FlagKey } from '@materia/domain';

import { createLog, type Severity } from '../core/log';
import { ClerkModelError } from '../ports';
import { meteringPeriod } from './features';
import { backoffMs, createClerkGateway, type ClerkRunInput } from './gateway';
import { FakeClock } from '../ports/fakes';
import { FakeClerkModel, type FakeStep } from './providers/fake';
import { MemoryClerkStore, MemoryKeyring } from './testing';

// Most cases run on Opus 5.5, the org's opt-in, so its fallback chain and prices are exercised.
const CLERK_MODEL = 'claude-opus-5-5';
const HELLO_JSON = JSON.stringify({ greeting: 'Hello there.', promptRef: 'hello@1.0.0' });
// A fictional document; the logging test checks none of this text reaches the logs.
const SECRET_DOC = 'Fictional will of Avery Quill: the residue to the Lantern Trust.';

function setup(script: FakeStep[] = [], flags: Partial<Record<FlagKey, boolean>> = { 'clerk.enabled': true }) {
  const model = new FakeClerkModel(script);
  const store = new MemoryClerkStore();
  store.settings = { model: CLERK_MODEL };
  const keyring = new MemoryKeyring();
  const logs: { severity: Severity; message: string; entry: Record<string, unknown> }[] = [];
  const log = createLog({ fn: 'test', requestId: 'req-1', orgId: 'org-a', uid: 'u-1' }, (severity, message, entry) =>
    logs.push({ severity, message, entry }),
  );
  const clock = new FakeClock(new Date('2026-03-14T00:00:00Z'));
  const slept: number[] = [];
  let t = 0;
  const gateway = createClerkGateway({
    model,
    store,
    keyring,
    flag: async (_orgId, key) => flags[key] ?? false,
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
    now: () => (t += 10),
  });
  const input = (over: Partial<ClerkRunInput> = {}): ClerkRunInput => ({
    ctx: { orgId: 'org-a', uid: 'u-1', role: 'lawyer', requestId: 'req-1', log, clock },
    feature: 'hello',
    promptId: 'hello',
    vars: { name: 'the team', promptRef: 'hello@1.0.0' },
    ...over,
  });
  return { model, store, keyring, logs, gateway, input, slept, clock };
}

describe('ClerkGateway', () => {
  it('runs a prompt with structured output, metering and a metadata-only log', async () => {
    const { gateway, input, model, store, logs } = setup([
      { chunks: [HELLO_JSON], usage: { inputTokens: 1000, outputTokens: 50 } },
    ]);
    const result = await gateway.run(input());
    expect(result).toMatchObject({
      status: 'done',
      parsed: { greeting: 'Hello there.', promptRef: 'hello@1.0.0' },
      model: CLERK_MODEL,
      promptRef: 'hello@1.0.0',
      fallbackUsed: false,
      stopReason: 'end_turn',
      costMicros: 5000,
    });
    const request = model.requests[0];
    expect(request).toMatchObject({
      model: CLERK_MODEL,
      effort: 'low',
      maxTokens: 1024,
      serverFallbacks: true,
      timeoutMs: 30_000,
    });
    expect(request?.output?.name).toBe('hello');
    expect(store.meters).toEqual([
      {
        period: 'clerk-2026-03',
        entry: {
          feature: 'hello',
          uid: 'u-1',
          usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costMicros: 5000,
          costEstimated: false,
        },
      },
    ]);
    expect(logs.at(-1)).toMatchObject({
      severity: 'info',
      message: 'clerk call',
      entry: { feature: 'hello', status: 'done', inputTokens: 1000, latencyMs: expect.any(Number) },
    });
  });

  it('never logs prompt or completion text', async () => {
    const completion = 'The residue goes to the Lantern Trust, per clause 7.';
    const { gateway, input, logs } = setup([
      { chunks: [completion] },
      { chunks: ['partial reply about Avery'], error: new ClerkModelError('disconnected') },
      { error: new ClerkModelError('bad_request', 'Provider rejected the request (400)', 400) },
    ]);
    const documents = [
      { documentId: 'doc-1', version: 1, title: 'Will', source: { kind: 'text' as const, text: SECRET_DOC } },
    ];
    await gateway.run(input({ documents, output: z.string() }));
    await gateway.run(input({ documents }));
    await expect(gateway.run(input({ documents }))).rejects.toMatchObject({ code: 'CLERK_UNAVAILABLE' });
    const serialised = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const text of [SECRET_DOC, 'Avery', 'Lantern', 'clause 7', 'Say hello', 'the team', 'You are Clerk']) {
      expect(serialised).not.toContain(text);
    }
  });

  it('streams throttled text into the message and finishes it with citations and the verbatim turn', async () => {
    const { gateway, input, store } = setup([
      {
        chunks: ['The will ', 'names ', 'an executor.'],
        citations: [
          {
            type: 'page_location',
            document_index: 0,
            cited_text: 'I appoint',
            start_page_number: 2,
            end_page_number: 2,
          },
        ],
      },
    ]);
    const result = await gateway.run(
      input({
        output: z.unknown(),
        stream: { threadId: 't-1', messageId: 'm-1' },
        documents: [{ documentId: 'doc-will', version: 3, source: { kind: 'pdf', base64: 'JVBERi0=' } }],
      }),
    );
    expect(result.status).toBe('invalid_output');
    const message = store.messages.get('t-1/m-1');
    expect(message?.writes).toEqual(['The will ', 'The will names ', 'The will names an executor.']);
    expect(message?.final).toMatchObject({
      status: 'invalid_output',
      // The cited claim carries its marker (AI-05); no matter context, so the citation is unchecked.
      text: 'The will names an executor.[1]',
      citations: [{ kind: 'document', documentId: 'doc-will', docVersion: 3, page: 2, quote: 'I appoint' }],
      model: CLERK_MODEL,
      raw: [{ type: 'text', text: 'The will names an executor.' }],
    });
    expect(message?.closed).toBe(true);
  });

  it('puts documents and chunks before the question, with a cache breakpoint on the last one', async () => {
    const { gateway, input, model } = setup([{ chunks: [HELLO_JSON] }]);
    await gateway.run(
      input({
        documents: [{ documentId: 'd1', version: 1, title: 'Will', source: { kind: 'text', text: 'x' } }],
        searchResults: [
          { documentId: 'd2', version: 1, page: 4, title: 'Affidavit p4', source: 'doc:d2#4', text: 'y' },
        ],
      }),
    );
    const content = model.requests[0]?.messages[0]?.content as { type: string; cache?: boolean }[];
    expect(content.map((b) => [b.type, b.cache ?? false])).toEqual([
      ['document', false],
      ['search_result', true],
      ['text', false],
    ]);
  });

  it.each([
    ['refusal', 'refused'],
    ['max_tokens', 'truncated'],
  ])('maps stop reason %s to %s without parsing', async (stopReason, status) => {
    const { gateway, input, store } = setup([{ chunks: ['{"greeting":'], stopReason }]);
    const result = await gateway.run(input());
    expect(result.status).toBe(status);
    expect(result.parsed).toBeUndefined();
    expect(store.meters).toHaveLength(1);
  });

  it('marks structured output that fails validation as invalid_output, with no retry', async () => {
    const { gateway, input, model, logs } = setup([{ chunks: ['{"greeting": 42}'] }]);
    const result = await gateway.run(input());
    expect(result.status).toBe('invalid_output');
    expect(model.requests).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ severity: 'warn', entry: { status: 'invalid_output', invalidIssues: 2 } });
  });

  it.each([
    [{ 'clerk.enabled': false }, {}, 'clerk.enabled'],
    [{ 'clerk.enabled': true }, { feature: 'chat' as const }, 'clerk.features.chat'],
  ])('kill switch: flags %o stop the call before the model', async (flags, over, expected) => {
    const { gateway, input, model, store } = setup([], flags);
    await expect(gateway.run(input(over))).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: expected },
    });
    expect(model.requests).toHaveLength(0);
    expect(store.hits.size).toBe(0);
  });

  it("kill switch: the org's own setting", async () => {
    const { gateway, input, store, model } = setup();
    store.settings = { enabled: false };
    await expect(gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_DISABLED',
      details: { switch: 'org.settings.clerk.enabled' },
    });
    expect(model.requests).toHaveLength(0);
  });

  it('enforces the per-user window (org-configurable)', async () => {
    const { gateway, input, store, clock } = setup();
    store.settings = { enabled: true, userRateLimit: { requests: 2, windowMinutes: 10 } };
    await gateway.run(input());
    await gateway.run(input());
    await expect(gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_RATE_LIMITED',
      details: { windowMinutes: 10 },
    });
    clock.advance(10 * 60_000 + 1);
    await expect(gateway.run(input())).resolves.toMatchObject({ status: 'done' });
  });

  it('skips the per-user window for background features (ingestion OCR)', async () => {
    const { gateway, input, store } = setup();
    store.settings = { enabled: true, userRateLimit: { requests: 1, windowMinutes: 10 } };
    const ocr = () =>
      gateway.run(input({ feature: 'ocr', promptId: 'ocr', vars: { page: 1, fileName: 'Fictional scan.pdf' } }));
    await ocr();
    await ocr();
    await expect(ocr()).resolves.toMatchObject({ status: 'done' });
    expect(store.hits.size).toBe(0);
  });

  it('blocks the next call once the monthly budget is used (the current call finishes)', async () => {
    const { gateway, input, store } = setup([{ chunks: [HELLO_JSON], usage: { inputTokens: 900, outputTokens: 200 } }]);
    store.settings = { monthlyTokenBudget: 1000 };
    await expect(gateway.run(input())).resolves.toMatchObject({ status: 'done' });
    await expect(gateway.run(input())).rejects.toMatchObject({
      code: 'CLERK_BUDGET_EXCEEDED',
      details: { period: 'clerk-2026-03' },
    });
    expect(store.hits.get('u-1')).toHaveLength(1);
  });

  it('logs metering, and warns once when the month passes 80% of the budget (FND-21)', async () => {
    const usage = { inputTokens: 300, outputTokens: 100 };
    const { gateway, input, store, logs } = setup([
      { chunks: [HELLO_JSON], usage },
      { chunks: [HELLO_JSON], usage },
      { chunks: [HELLO_JSON], usage },
    ]);
    store.settings = { monthlyTokenBudget: 1000 };
    await gateway.run(input());
    await gateway.run(input());
    const warnings = () => logs.filter((l) => l.message === 'clerk budget threshold');
    expect(warnings()).toEqual([
      expect.objectContaining({ severity: 'warn', entry: expect.objectContaining({ percent: 80, limit: 1000 }) }),
    ]);
    await gateway.run(input()).catch(() => undefined);
    expect(warnings()).toHaveLength(1);
    expect(logs.find((l) => l.message === 'clerk metered')?.entry).toMatchObject({ tokens: 400 });
  });

  it('retries 529, 5xx and timeouts with jittered backoff, then succeeds', async () => {
    const { gateway, input, slept } = setup([
      { error: new ClerkModelError('overloaded', 'x', 529) },
      { error: new ClerkModelError('timeout') },
      { chunks: [HELLO_JSON] },
    ]);
    await expect(gateway.run(input())).resolves.toMatchObject({ status: 'done', fallbackUsed: false });
    expect(slept).toEqual([500, 1000]);
  });

  it('falls back to the next model after the retries, as a fresh branch, recording fallbackUsed', async () => {
    const overloaded = { error: new ClerkModelError('overloaded', 'x', 529) };
    const { gateway, input, model, store } = setup([
      overloaded,
      overloaded,
      overloaded,
      { chunks: [HELLO_JSON], model: 'claude-opus-5' },
    ]);
    const result = await gateway.run(input({ stream: { threadId: 't', messageId: 'm' } }));
    expect(result).toMatchObject({ status: 'done', model: 'claude-opus-5', fallbackUsed: true });
    expect(model.requests.map((r) => [r.model, r.serverFallbacks])).toEqual([
      [CLERK_MODEL, true],
      [CLERK_MODEL, true],
      [CLERK_MODEL, true],
      ['claude-opus-5', false],
    ]);
    expect(model.requests[3]?.messages).toHaveLength(1);
    expect(store.messages.get('t/m')?.final).toMatchObject({ fallbackUsed: true, model: 'claude-opus-5' });
    expect(store.meters[0]?.entry.costEstimated).toBe(true);
  });

  it('records a server-side refusal fallback hop as fallbackUsed', async () => {
    const { gateway, input } = setup([{ chunks: [HELLO_JSON], model: 'claude-sonnet-5-5', serverFallback: true }]);
    expect(await gateway.run(input())).toMatchObject({
      status: 'done',
      fallbackUsed: true,
      model: 'claude-sonnet-5-5',
    });
  });

  it('gives up with CLERK_UNAVAILABLE when every model fails', async () => {
    const down = { error: new ClerkModelError('server', 'x', 503) };
    const { gateway, input, store } = setup([down, down, down, down, down]);
    await expect(gateway.run(input({ stream: { threadId: 't', messageId: 'm' } }))).rejects.toMatchObject({
      code: 'CLERK_UNAVAILABLE',
    });
    expect(store.messages.get('t/m')?.final?.status).toBe('error');
  });

  it('turns a provider rate limit into CLERK_BUSY without switching models', async () => {
    const limited = { error: new ClerkModelError('rate_limited', 'x', 429, 2000) };
    const { gateway, input, model, slept } = setup([limited, limited, limited]);
    await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_BUSY' });
    expect(model.requests.every((r) => r.model === CLERK_MODEL)).toBe(true);
    expect(slept).toEqual([2000, 2000]);
  });

  it('keeps the partial text and marks the message error when the stream drops mid-way', async () => {
    const { gateway, input, store, model } = setup([
      { chunks: ['Half an ans'], error: new ClerkModelError('disconnected') },
    ]);
    const result = await gateway.run(input({ stream: { threadId: 't', messageId: 'm' } }));
    expect(result).toMatchObject({ status: 'error', text: 'Half an ans' });
    expect(model.requests).toHaveLength(1);
    expect(store.messages.get('t/m')?.final).toMatchObject({ status: 'error', text: 'Half an ans' });
  });

  it('honours stopRequested: aborts the stream and marks the message stopped', async () => {
    const { gateway, input, store } = setup([{ chunks: ['one ', 'two ', 'three'], delayMs: 200 }]);
    const running = gateway.run(input({ stream: { threadId: 't', messageId: 'm' } }));
    // Stop once the first chunk is written, well inside the pause before the second (a fixed
    // sleep raced the first chunk on a busy runner).
    await vi.waitFor(() => expect(store.messages.get('t/m')?.writes).toEqual(['one ']), { interval: 1 });
    store.messages.get('t/m')?.stop();
    const result = await running;
    expect(result.status).toBe('stopped');
    expect(result.text).toBe('one ');
    expect(store.messages.get('t/m')?.final).toMatchObject({ status: 'stopped', text: 'one ' });
    expect(store.meters).toHaveLength(1);
  });

  it('refuses roles without clerk.use', async () => {
    const { gateway, input } = setup();
    const base = input();
    await expect(gateway.run({ ...base, ctx: { ...base.ctx, role: 'readonly' } })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects bad prompt variables before calling the model', async () => {
    const { gateway, input, model } = setup();
    await expect(gateway.run(input({ vars: { name: 'x' } }))).rejects.toThrow(/missing variable "promptRef"/);
    expect(model.requests).toHaveLength(0);
  });

  it('keeps the answer when metering fails', async () => {
    const { gateway, input, store, logs } = setup([{ chunks: [HELLO_JSON] }]);
    store.meter = () => Promise.reject(new Error('firestore down'));
    await expect(gateway.run(input())).resolves.toMatchObject({ status: 'done' });
    expect(logs.some((l) => l.message === 'clerk metering failed')).toBe(true);
  });
});

describe('gateway helpers', () => {
  it('backs off exponentially with jitter, or by retry-after', () => {
    expect([0, 1, 2].map((n) => backoffMs(n, () => 0))).toEqual([250, 500, 1000]);
    expect(backoffMs(0, () => 0.999)).toBe(750);
    expect(backoffMs(3, () => 0.5, 45_000)).toBe(30_000);
  });

  it('meters by calendar month in Melbourne time', () => {
    expect(meteringPeriod(new Date('2026-03-31T13:30:00Z'))).toBe('clerk-2026-04');
    expect(meteringPeriod(new Date('2026-03-31T12:00:00Z'))).toBe('clerk-2026-03');
  });

  describe('bring your own key (AI-02a)', () => {
    it('passes the org key with each request, and defaults to Sonnet 5.5 and its chain', async () => {
      const overloaded = { error: new ClerkModelError('overloaded', 'x', 529) };
      const { gateway, input, model, store, keyring } = setup([
        overloaded,
        overloaded,
        overloaded,
        { chunks: [HELLO_JSON], model: 'claude-sonnet-5' },
      ]);
      store.settings = {};
      const result = await gateway.run(input());
      expect(result).toMatchObject({ status: 'done', model: 'claude-sonnet-5', fallbackUsed: true });
      expect(model.requests.map((r) => r.model)).toEqual([
        'claude-sonnet-5-5',
        'claude-sonnet-5-5',
        'claude-sonnet-5-5',
        'claude-sonnet-5',
      ]);
      const key = keyring.key as { apiKey: string };
      expect(model.requests.every((r) => r.credentials.apiKey === key.apiKey && r.credentials.orgId === 'org-a')).toBe(
        true,
      );
      // The unpriced fallback is costed at the primary's (Sonnet 5.5) price and flagged estimated.
      expect(store.meters[0]?.entry).toMatchObject({ costEstimated: true });
    });

    it('uses Opus 5.5 and its chain when the org opted in', async () => {
      const down = { error: new ClerkModelError('server', 'x', 503) };
      const { gateway, input, model } = setup([down, down, down, down, { chunks: [HELLO_JSON] }]);
      await gateway.run(input());
      expect(model.requests.map((r) => r.model)).toEqual([
        'claude-opus-5-5',
        'claude-opus-5-5',
        'claude-opus-5-5',
        'claude-opus-5',
        'claude-sonnet-5-5',
      ]);
    });

    it('is off for an org without a key (CLERK_DISABLED, org.byok.missing), checked after the kill switches', async () => {
      const { gateway, input, model, keyring } = setup();
      keyring.key = { state: 'missing' };
      await expect(gateway.run(input())).rejects.toMatchObject({
        code: 'CLERK_DISABLED',
        details: { switch: 'org.byok.missing' },
      });
      expect(model.requests).toHaveLength(0);
      const off = setup([], {});
      off.keyring.key = { state: 'missing' };
      await expect(off.gateway.run(off.input())).rejects.toMatchObject({ details: { switch: 'clerk.enabled' } });
    });

    it('checks the key before the limits, so an org without one spends no rate slot', async () => {
      const { gateway, input, store, keyring } = setup();
      keyring.key = { state: 'missing' };
      await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_DISABLED' });
      expect(store.hits.size).toBe(0);
    });

    it('marks a rejected key invalid and returns CLERK_KEY_INVALID; later calls stop before the provider', async () => {
      const { gateway, input, model, keyring, store, logs } = setup([
        { error: new ClerkModelError('auth', 'Provider rejected the credentials (401)', 401) },
      ]);
      await expect(gateway.run(input({ stream: { threadId: 't', messageId: 'm' } }))).rejects.toMatchObject({
        code: 'CLERK_KEY_INVALID',
      });
      expect(keyring.invalidated).toEqual(['v1']);
      expect(model.requests).toHaveLength(1);
      expect(store.messages.get('t/m')?.final?.status).toBe('error');
      await expect(gateway.run(input())).rejects.toMatchObject({ code: 'CLERK_KEY_INVALID' });
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain('sk-ant-');
    });
  });
});
