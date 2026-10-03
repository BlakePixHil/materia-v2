import { makeClient, main, runOnce, type StreamingClient } from './clerk-bench.ts';

/** A stand-in for the SDK's MessageStream: two deltas, then a final message. */
function fakeClient(): StreamingClient {
  return {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start' };
          yield { type: 'content_block_delta' };
          yield { type: 'content_block_delta' };
        },
        finalMessage: async () => ({ usage: { input_tokens: 1200, output_tokens: 40 }, stop_reason: 'end_turn' }),
      }),
    },
  } as unknown as StreamingClient;
}

describe('clerk-bench runner', () => {
  it('measures one streamed run', async () => {
    const result = await runOnce(fakeClient(), 'claude-opus-5-5', 1000, 1);
    expect(result).toMatchObject({ run: 1, inputTokens: 1200, outputTokens: 40, stopReason: 'end_turn' });
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensPerSecond).toBeGreaterThan(0);
  });

  it('passes inference_geo through when BENCH_INFERENCE_GEO is set', async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient();
    const original = client.messages.stream.bind(client.messages);
    client.messages.stream = ((params: Record<string, unknown>) => {
      seen = params;
      return original(params as never);
    }) as never;
    vi.stubEnv('BENCH_INFERENCE_GEO', 'us');
    await runOnce(client, 'claude-opus-5-5', 100, 1);
    vi.unstubAllEnvs();
    expect(seen['inference_geo']).toBe('us');
  });

  it('builds provider clients from the environment without network calls', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    expect(makeClient('anthropic').model).toBe('claude-opus-5-5');
    expect(makeClient('bedrock').model).toBe('anthropic.claude-opus-5-5');
    expect(() => makeClient('vertex')).toThrow('BENCH_GCP_PROJECT');
    vi.stubEnv('BENCH_GCP_PROJECT', 'demo-project');
    expect(makeClient('vertex').model).toBe('claude-opus-5-5');
    vi.unstubAllEnvs();
  });

  it('prints a table for the fake provider and rejects unknown providers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(['--provider', 'fake', '--runs', '2']);
    expect(log.mock.calls[0]?.[0]).toContain('| **Median** |');
    log.mockRestore();
    await expect(main(['--provider', 'nope'])).rejects.toThrow('--provider must be one of');
  });
});
