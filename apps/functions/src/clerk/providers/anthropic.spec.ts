import { z } from 'zod';

import {
  anthropicModel,
  buildParams,
  mapError,
  SERVER_FALLBACK_BETA,
  toResult,
  type StreamingClient,
} from './anthropic';
import { ClerkModelError, type ClerkModelRequest } from '../../ports';

const request = (over: Partial<ClerkModelRequest> = {}): ClerkModelRequest => ({
  model: 'claude-opus-5-5',
  system: 'You are Clerk.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'document', title: 'Will', source: { kind: 'pdf', base64: 'JVBERi0=' } },
        { type: 'search_result', source: 'doc:d2#4', title: 'Affidavit', text: 'sworn', cache: true },
        { type: 'text', text: 'Who is the executor?' },
      ],
    },
  ],
  maxTokens: 2048,
  effort: 'medium',
  timeoutMs: 5000,
  serverFallbacks: true,
  ...over,
});

const apiMessage = {
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '…', signature: 'sig' },
    {
      type: 'text',
      text: 'Ms Quill ',
      citations: [
        { type: 'page_location', document_index: 0, cited_text: 'I appoint', start_page_number: 2, end_page_number: 2 },
      ],
    },
    { type: 'text', text: 'is the executor.', citations: null },
  ],
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: null },
};

describe('Anthropic adapter', () => {
  it('builds an Opus 5.5 request: adaptive thinking, effort, cached system, citations on, server fallbacks', async () => {
    const params = (await buildParams(request())) as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: 'You are Clerk.', cache_control: { type: 'ephemeral' } }],
      fallbacks: 'default',
      betas: [SERVER_FALLBACK_BETA],
    });
    expect(params).not.toHaveProperty('tool_choice');
    const content = (params['messages'] as { content: Record<string, unknown>[] }[])[0]?.content;
    expect(content?.[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      title: 'Will',
      citations: { enabled: true },
    });
    expect(content?.[1]).toEqual({
      type: 'search_result',
      source: 'doc:d2#4',
      title: 'Affidavit',
      content: [{ type: 'text', text: 'sworn' }],
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    });
    expect(content?.[2]).toEqual({ type: 'text', text: 'Who is the executor?' });
  });

  it('adds output_config.format for structured output, and omits fallbacks for fallback models', async () => {
    const params = (await buildParams(
      request({ output: { name: 'hello', schema: z.object({ greeting: z.string() }) }, serverFallbacks: false }),
    )) as unknown as { output_config: { format: { type: string; schema: { type: string; properties: object } } } };
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.output_config.format.schema).toMatchObject({
      type: 'object',
      properties: { greeting: { type: 'string' } },
    });
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
  });

  it('replays assistant turns verbatim, thinking blocks included', async () => {
    const turn = apiMessage.content;
    const params = (await buildParams(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', content: turn },
        ],
      }),
    )) as unknown as { messages: { content: unknown }[] };
    expect(params.messages[1]?.content).toBe(turn);
  });

  it('reads the final message: text, citations, usage, server fallback', () => {
    const result = toResult(apiMessage, 'claude-opus-5-5');
    expect(result).toMatchObject({
      model: 'claude-opus-5-5',
      stopReason: 'end_turn',
      text: 'Ms Quill is the executor.',
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 0 },
      serverFallback: false,
    });
    expect(result.citations).toHaveLength(1);
    expect(result.content).toBe(apiMessage.content);
    expect(toResult({ ...apiMessage, model: 'claude-sonnet-5-5' }, 'claude-opus-5-5').serverFallback).toBe(true);
    expect(
      toResult({ ...apiMessage, stop_reason: null, content: [{ type: 'fallback' }] }, 'claude-opus-5-5'),
    ).toMatchObject({
      stopReason: 'end_turn',
      serverFallback: true,
      text: '',
    });
  });

  it.each([
    [{ name: 'APIUserAbortError' }, false, 'aborted'],
    [{ name: 'Error', status: 500 }, true, 'aborted'],
    [{ name: 'APIConnectionTimeoutError' }, false, 'timeout'],
    [{ name: 'APIConnectionError' }, false, 'disconnected'],
    [new Error('stream ended'), false, 'disconnected'],
    [{ name: 'RateLimitError', status: 429, headers: { 'retry-after': '3' } }, false, 'rate_limited'],
    [{ name: 'InternalServerError', status: 529 }, false, 'overloaded'],
    [{ name: 'InternalServerError', status: 502 }, false, 'server'],
    [{ name: 'AuthenticationError', status: 401 }, false, 'auth'],
    [{ name: 'BadRequestError', status: 400 }, false, 'bad_request'],
  ])('classifies %o (aborted=%s) as %s', (error, aborted, kind) => {
    expect(mapError(error, aborted).kind).toBe(kind);
  });

  it('keeps retry-after and never copies the provider message', () => {
    const mapped = mapError(
      {
        name: 'RateLimitError',
        status: 429,
        headers: new Headers({ 'retry-after': '3' }),
        message: 'about Avery Quill',
      },
      false,
    );
    expect(mapped.retryAfterMs).toBe(3000);
    expect(mapped.message).not.toContain('Avery');
    const existing = new ClerkModelError('server');
    expect(mapError(existing, false)).toBe(existing);
  });

  it('streams text deltas and returns the final message through a client', async () => {
    const seen: unknown[] = [];
    const client: StreamingClient = {
      beta: {
        messages: {
          stream(params, options) {
            seen.push(params, options);
            let listener: ((delta: string) => void) | undefined;
            return {
              on(_event, cb) {
                listener = cb;
                return this;
              },
              async finalMessage() {
                listener?.('Ms Quill ');
                listener?.('is the executor.');
                return apiMessage;
              },
            };
          },
        },
      },
    };
    const model = anthropicModel({ apiKey: () => 'unused', client });
    const deltas: string[] = [];
    const result = await model.run(request(), (event) => deltas.push(event.text));
    expect(deltas).toEqual(['Ms Quill ', 'is the executor.']);
    expect(result.text).toBe('Ms Quill is the executor.');
    expect(seen[1]).toEqual({ timeout: 5000 });
  });

  it('maps stream failures and needs an API key before loading the SDK', async () => {
    const failing: StreamingClient = {
      beta: {
        messages: {
          stream: () => ({
            on: () => undefined,
            finalMessage: () => Promise.reject({ name: 'InternalServerError', status: 529 }),
          }),
        },
      },
    };
    await expect(anthropicModel({ apiKey: () => '', client: failing }).run(request())).rejects.toMatchObject({
      kind: 'overloaded',
    });
    await expect(anthropicModel({ apiKey: () => '' }).run(request())).rejects.toMatchObject({ kind: 'auth' });
  });
});
