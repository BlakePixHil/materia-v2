import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams as MessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import {
  ClerkModelError,
  type ClerkContentBlock,
  type ClerkModelPort,
  type ClerkModelRequest,
  type ClerkModelResult,
  type ClerkStreamEvent,
} from '../../ports';

/**
 * The Anthropic API adapter (ADR-011a: first-party API, key in Secret Manager). This folder is the
 * only place a model SDK may be imported (ESLint `no-restricted-imports`). The SDK is loaded on
 * first use so cold starts of other functions don't pay for it.
 */

/** The beta that lets the API reroute refusals itself (`fallbacks: "default"`, ADR-011a). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const EPHEMERAL = { type: 'ephemeral' } as const;

type ApiBlock = Record<string, unknown>;

function toApiBlock(block: ClerkContentBlock): ApiBlock {
  const cache = block.cache ? { cache_control: EPHEMERAL } : {};
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...cache };
    case 'document':
      return {
        type: 'document',
        source:
          block.source.kind === 'pdf'
            ? { type: 'base64', media_type: 'application/pdf', data: block.source.base64 }
            : { type: 'text', media_type: 'text/plain', data: block.source.text },
        ...(block.title ? { title: block.title } : {}),
        citations: { enabled: true },
        ...cache,
      };
    case 'search_result':
      return {
        type: 'search_result',
        source: block.source,
        title: block.title,
        content: [{ type: 'text', text: block.text }],
        citations: { enabled: true },
        ...cache,
      };
  }
}

/** The JSON schema for structured output, via the SDK's zod helper. */
async function outputFormat(
  schema: import('zod').ZodType,
): Promise<{ type: 'json_schema'; schema: Record<string, unknown> }> {
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const format = zodOutputFormat(schema as never) as unknown as { schema: Record<string, unknown> };
  return { type: 'json_schema', schema: format.schema };
}

/**
 * The request body. Opus 5.5 facts (Clerk doc): adaptive thinking only, depth via
 * `output_config.effort`, never a forced `tool_choice`, structured output via `output_config.format`.
 * The system prompt carries a cache breakpoint; content blocks marked `cache` add one each.
 */
export async function buildParams(request: ClerkModelRequest): Promise<MessageStreamParams> {
  const messages = request.messages.map((turn) => ({
    role: turn.role,
    content:
      turn.role === 'user'
        ? (turn.content as ClerkContentBlock[]).map(toApiBlock)
        : // Assistant turns are replayed exactly as the API returned them (preserved thinking).
          (turn.content as ApiBlock[]),
  }));
  const params: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system, cache_control: EPHEMERAL }],
    messages,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: request.effort,
      ...(request.output ? { format: await outputFormat(request.output.schema) } : {}),
    },
  };
  if (request.serverFallbacks) {
    params['fallbacks'] = 'default';
    params['betas'] = [SERVER_FALLBACK_BETA];
  }
  return params as unknown as MessageStreamParams;
}

interface ApiMessage {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string; citations?: unknown[] | null }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** The result from the final message: text blocks joined, their citations collected. */
export function toResult(message: ApiMessage, requestedModel: string): ClerkModelResult {
  const textBlocks = message.content.filter((block) => block.type === 'text');
  return {
    model: message.model,
    stopReason: message.stop_reason ?? 'end_turn',
    text: textBlocks.map((block) => block.text ?? '').join(''),
    citations: textBlocks.flatMap((block) => block.citations ?? []),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    content: message.content,
    serverFallback: message.model !== requestedModel || message.content.some((block) => block.type === 'fallback'),
  };
}

/** Classifies an SDK error. Messages from the API are never copied (they can echo content). */
export function mapError(error: unknown, aborted: boolean): ClerkModelError {
  if (error instanceof ClerkModelError) return error;
  const e = error as { name?: string; status?: number; headers?: Record<string, string> | Headers } | undefined;
  const name = e?.name ?? '';
  if (aborted || name === 'APIUserAbortError') return new ClerkModelError('aborted', 'Stopped');
  if (name === 'APIConnectionTimeoutError') return new ClerkModelError('timeout', 'Provider timed out');
  if (name === 'APIConnectionError') return new ClerkModelError('disconnected', 'Connection to the provider failed');
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === undefined) return new ClerkModelError('disconnected', 'The stream ended unexpectedly');
  if (status === 429) {
    const headers = e?.headers;
    const raw = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
    const seconds = raw ? Number(raw) : NaN;
    return new ClerkModelError(
      'rate_limited',
      'Provider rate limit',
      429,
      Number.isFinite(seconds) ? seconds * 1000 : undefined,
    );
  }
  if (status === 529) return new ClerkModelError('overloaded', 'Provider overloaded', 529);
  if (status >= 500) return new ClerkModelError('server', `Provider error ${status}`, status);
  if (status === 401 || status === 403)
    return new ClerkModelError('auth', `Provider rejected the credentials (${status})`, status);
  return new ClerkModelError('bad_request', `Provider rejected the request (${status})`, status);
}

/** The slice of the SDK client the adapter uses (so tests can pass a stand-in). */
export interface StreamingClient {
  beta: {
    messages: {
      stream(
        params: MessageStreamParams,
        options: { signal?: AbortSignal; timeout?: number },
      ): { on(event: 'text', listener: (delta: string) => void): unknown; finalMessage(): Promise<unknown> };
    };
  };
}

export interface AnthropicModelOptions {
  /** Reads the API key (the `ANTHROPIC_API_KEY` secret); called once, on first use. */
  apiKey: () => string;
  /** Tests: a stand-in client. */
  client?: StreamingClient;
}

/** `ClerkModelPort` on the Anthropic API. Retries and model fallbacks are the gateway's job. */
export function anthropicModel(options: AnthropicModelOptions): ClerkModelPort {
  let client: StreamingClient | undefined = options.client;
  async function getClient(): Promise<StreamingClient> {
    if (client) return client;
    const key = options.apiKey();
    if (!key) throw new ClerkModelError('auth', 'ANTHROPIC_API_KEY is not configured');
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    // maxRetries 0: the gateway owns retries, backoff and fallbacks, so behaviour is testable.
    client = new AnthropicClient({ apiKey: key, maxRetries: 0 }) as Anthropic as unknown as StreamingClient;
    return client;
  }
  return {
    async run(request: ClerkModelRequest, onEvent?: (event: ClerkStreamEvent) => void): Promise<ClerkModelResult> {
      const api = await getClient();
      const params = await buildParams(request);
      try {
        const stream = api.beta.messages.stream(params, {
          ...(request.signal ? { signal: request.signal } : {}),
          timeout: request.timeoutMs,
        });
        stream.on('text', (delta) => onEvent?.({ type: 'text', text: delta }));
        const message = (await stream.finalMessage()) as ApiMessage;
        return toResult(message, request.model);
      } catch (error) {
        throw mapError(error, request.signal?.aborted ?? false);
      }
    },
  };
}
