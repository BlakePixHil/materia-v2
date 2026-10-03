/**
 * Clerk provider latency benchmark (AI-01).
 *
 * Sends a ~20k-token prompt of fictional estate text to claude-opus-5-5 several times through one
 * provider route, and reports time to first token (TTFT) and output tokens per second. Run it from
 * the same region as Cloud Functions (australia-southeast1) so the numbers match production.
 *
 * Usage:
 *   pnpm materia-scripts clerk-bench --provider anthropic [--runs 5] [--prompt-tokens 20000]
 *   pnpm materia-scripts clerk-bench --provider bedrock
 *   pnpm materia-scripts clerk-bench --provider vertex
 *   pnpm materia-scripts clerk-bench --provider fake        # offline dry run, no credentials
 *
 * Provider configuration (environment only; never commit credentials):
 *   bedrock    AWS credential chain (role, SSO or env). BENCH_AWS_REGION (default ap-southeast-4,
 *              Melbourne, in-region) and BENCH_MODEL (default anthropic.claude-opus-5-5). For the AU
 *              cross-region profile, use region ap-southeast-2 and the profile model id shown in the
 *              Bedrock console.
 *   vertex     Google ADC. BENCH_GCP_PROJECT and BENCH_GCP_REGION (default global; Opus 5.5 has no
 *              Australian Vertex endpoint).
 *   anthropic  ANTHROPIC_API_KEY. BENCH_INFERENCE_GEO is optional ("us" or "global" only).
 *
 * The prompt is synthetic and fictional. Never point this script at real client documents.
 * Output: a Markdown table on stdout, ready to paste into docs/adr/ADR-011a-clerk-provider.md.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

type Provider = 'bedrock' | 'vertex' | 'anthropic' | 'fake';

interface RunResult {
  run: number;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerSecond: number;
  stopReason: string;
}

/** The slice of the SDK client this script uses; every provider client exposes it. */
export type StreamingClient = Pick<Anthropic, 'messages'>;
type StreamParams = Parameters<Anthropic['messages']['stream']>[0];

const PROVIDERS: readonly Provider[] = ['bedrock', 'vertex', 'anthropic', 'fake'];
const CHARS_PER_TOKEN = 4; // rough English estimate; the API's usage block reports the real count

/** Builds deterministic fictional estate-file text of roughly `tokens` tokens. */
export function buildPrompt(tokens: number, nonce: string): string {
  const paragraphs = [
    'File note: the executor, Alex Example, attended to discuss the estate of the late Sam Placeholder.',
    'The will dated 1 March 2019 appoints Alex Example and Jordan Sample as joint executors.',
    'Assets include a residence in a fictional suburb, two bank accounts and a superannuation interest.',
    'A death certificate and the original will are held in safe custody, packet 0000-TEST.',
    'Beneficiaries are the two adult children in equal shares, with a gift of jewellery to a niece.',
    'Next steps: advertise the intention to apply for a grant, then file the probate application.',
  ];
  const parts: string[] = [`Benchmark run ${nonce}. All names and facts below are fictional.`];
  let i = 0;
  while (parts.join('\n').length < tokens * CHARS_PER_TOKEN) {
    parts.push(`[${i}] ${paragraphs[i % paragraphs.length]}`);
    i += 1;
  }
  return parts.join('\n');
}

export function makeClient(provider: Exclude<Provider, 'fake'>): { client: StreamingClient; model: string } {
  const env = process.env;
  switch (provider) {
    case 'bedrock':
      return {
        client: new AnthropicBedrockMantle({
          awsRegion: env['BENCH_AWS_REGION'] ?? 'ap-southeast-4',
        }) as unknown as StreamingClient,
        model: env['BENCH_MODEL'] ?? 'anthropic.claude-opus-5-5',
      };
    case 'vertex': {
      const projectId = env['BENCH_GCP_PROJECT'];
      if (!projectId) throw new Error('BENCH_GCP_PROJECT is required for --provider vertex');
      return {
        client: new AnthropicVertex({
          projectId,
          region: env['BENCH_GCP_REGION'] ?? 'global',
        }) as unknown as StreamingClient,
        model: env['BENCH_MODEL'] ?? 'claude-opus-5-5',
      };
    }
    case 'anthropic':
      return { client: new Anthropic(), model: env['BENCH_MODEL'] ?? 'claude-opus-5-5' };
  }
}

export async function runOnce(
  client: StreamingClient,
  model: string,
  promptTokens: number,
  run: number,
): Promise<RunResult> {
  // A unique nonce per run defeats prompt caching, so every run measures a cold 20k-token prompt.
  const prompt = buildPrompt(promptTokens, `${Date.now()}-${run}`);
  const params: StreamParams = {
    model,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: `${prompt}\n\nSummarise this file note in five bullet points.` }],
  };
  if (process.env['BENCH_INFERENCE_GEO']) {
    (params as StreamParams & { inference_geo?: string }).inference_geo = process.env['BENCH_INFERENCE_GEO'];
  }

  const start = performance.now();
  let firstToken: number | undefined;
  const stream = client.messages.stream(params);
  for await (const event of stream) {
    // Thinking runs first and its text is omitted by default, so the first delta of any kind
    // (thinking or text) is when the model starts producing output.
    if (firstToken === undefined && event.type === 'content_block_delta') firstToken = performance.now();
  }
  const message = await stream.finalMessage();
  const end = performance.now();

  const ttft = (firstToken ?? end) - start;
  const generationSeconds = Math.max((end - (firstToken ?? start)) / 1000, 0.001);
  return {
    run,
    ttftMs: Math.round(ttft),
    totalMs: Math.round(end - start),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    tokensPerSecond: Math.round((message.usage.output_tokens / generationSeconds) * 10) / 10,
    stopReason: message.stop_reason ?? 'unknown',
  };
}

/** Offline stand-in so the script and table format can be checked without credentials. */
async function fakeRun(promptTokens: number, run: number): Promise<RunResult> {
  const ttftMs = 800 + run * 10;
  const outputTokens = 300;
  return {
    run,
    ttftMs,
    totalMs: ttftMs + 6000,
    inputTokens: promptTokens,
    outputTokens,
    tokensPerSecond: Math.round((outputTokens / 6) * 10) / 10,
    stopReason: 'end_turn',
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const upper = s[mid] ?? 0;
  if (s.length % 2) return upper;
  const lower = s[mid - 1] ?? upper;
  return Math.round(((lower + upper) / 2) * 10) / 10;
}

export function toMarkdown(provider: string, model: string, results: RunResult[]): string {
  const rows = results.map(
    (r) =>
      `| ${r.run} | ${r.ttftMs} | ${r.totalMs} | ${r.inputTokens} | ${r.outputTokens} | ${r.tokensPerSecond} | ${r.stopReason} |`,
  );
  return [
    `**${provider}** · \`${model}\` · ${new Date().toISOString()}`,
    '',
    '| Run | TTFT (ms) | Total (ms) | Input tokens | Output tokens | Output tok/s | Stop reason |',
    '| -- | -- | -- | -- | -- | -- | -- |',
    ...rows,
    `| **Median** | **${median(results.map((r) => r.ttftMs))}** | ${median(results.map((r) => r.totalMs))} | | | **${median(results.map((r) => r.tokensPerSecond))}** | |`,
  ].join('\n');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', default: 'fake' },
      runs: { type: 'string', default: '5' },
      'prompt-tokens': { type: 'string', default: '20000' },
    },
  });
  const provider = values.provider as Provider;
  if (!PROVIDERS.includes(provider)) throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}`);
  const runs = Number(values.runs);
  const promptTokens = Number(values['prompt-tokens']);

  const results: RunResult[] = [];
  let model = 'fake';
  if (provider === 'fake') {
    for (let run = 1; run <= runs; run += 1) results.push(await fakeRun(promptTokens, run));
  } else {
    const made = makeClient(provider);
    model = made.model;
    for (let run = 1; run <= runs; run += 1) {
      results.push(await runOnce(made.client, made.model, promptTokens, run));
      // Log ids and numbers only; never prompt or completion text.
      console.error(`run ${run}/${runs} done`);
    }
  }
  console.log(toMarkdown(provider, model, results));
}

// Run only when executed directly, not when imported (tests, the materia-scripts dispatcher).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
