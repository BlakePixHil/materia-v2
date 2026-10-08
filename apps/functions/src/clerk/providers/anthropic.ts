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
 * The Anthropic API adapter (ADR-011a: first-party API; ADR-011b: each org's own key, passed per
 * request). This folder is the only place a model SDK may be imported (ESLint
 * `no-restricted-imports`). The SDK is loaded on first use so cold starts of other functions don't
 * pay for it.
 */

/** The beta that lets the API reroute refusals itself (`fallbacks: "default"`, ADR-011a). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const EPHEMERAL = { type: 'ephemeral' } as const;

type ApiBlock = Record<string, unknown>;

/**
 * One user content block. Citations are on for documents and search results, except with
 * structured output: the API rejects citations combined with `output_config.format`, so a
 * structured feature quotes its sources in its own fields instead (will extraction, AI-06).
 */
function toApiBlock(block: ClerkContentBlock, citable: boolean): ApiBlock {
  const cache = block.cache ? { cache_control: EPHEMERAL } : {};
  const citations = citable ? { citations: { enabled: true } } : {};
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
        ...citations,
        ...cache,
      };
    case 'search_result':
      return {
        type: 'search_result',
        source: block.source,
        title: block.title,
        content: [{ type: 'text', text: block.text }],
        ...citations,
        ...cache,
      };
    case 'tool_result':
      // Retrieved passages stay citable inside a tool result (AI-06).
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content.map((part) => toApiBlock(part, citable)),
        ...(block.isError ? { is_error: true } : {}),
        ...cache,
      };
  }
}

/**
 * The JSON schema for structured output, via the SDK's zod helper. The helper describes what the
 * schema parses to, which it can't for a field the domain transforms as it reads it (a date in the
 * chat proposals' task, deadline and event payloads): such a schema is described by what it reads,
 * which is what the model writes, the same way the helper strictens it. The gateway parses the
 * reply with the schema itself either way.
 */
async function outputFormat(
  schema: import('zod').ZodType,
): Promise<{ type: 'json_schema'; schema: Record<string, unknown> }> {
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  try {
    const format = zodOutputFormat(schema as never) as unknown as { schema: Record<string, unknown> };
    return { type: 'json_schema', schema: format.schema };
  } catch {
    const [{ transformJSONSchema }, z] = await Promise.all([
      import('@anthropic-ai/sdk/lib/transform-json-schema'),
      import('zod'),
    ]);
    const input = z.toJSONSchema(schema, { reused: 'ref', io: 'input' }) as Record<string, unknown>;
    return { type: 'json_schema', schema: transformJSONSchema(input) as Record<string, unknown> };
  }
}

/**
 * The request body. Opus 5.5 and Sonnet 5.5 facts (Clerk doc, ADR-011b): adaptive thinking only
 * (`disabled` is a 400), depth via an explicit `output_config.effort` on every prompt (Sonnet 5.5's
 * default is `high` and its levels differ), never a forced `tool_choice`, structured output via
 * `output_config.format`.
 * The system prompt carries a cache breakpoint; content blocks marked `cache` add one each.
 */
export async function buildParams(request: ClerkModelRequest): Promise<MessageStreamParams> {
  const messages = request.messages.map((turn) => ({
    role: turn.role,
    content:
      turn.role === 'user'
        ? (turn.content as ClerkContentBlock[]).map((block) => toApiBlock(block, !request.output))
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
  // Model-chosen tools only: no `tool_choice`, so the model decides (a forced choice is a 400).
  if (request.tools?.length)
    params['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  if (request.serverFallbacks) {
    params['fallbacks'] = 'default';
    params['betas'] = [SERVER_FALLBACK_BETA];
  }
  return params as unknown as MessageStreamParams;
}

interface ApiMessage {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string; citations?: unknown[] | null; id?: string; name?: string; input?: unknown }[];
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
    toolUses: message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {} })),
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
  models: {
    list(params: { limit: number }, options: { timeout: number }): PromiseLike<{ data: { id: string }[] }>;
  };
}

/** How long an org's SDK client is reused. A rotated key gets a new client on the next call. */
export const CLIENT_TTL_MS = 5 * 60_000;
/** Validating a key is one small request; don't hold the admin's save for long. */
export const LIST_MODELS_TIMEOUT_MS = 15_000;

export interface AnthropicModelOptions {
  /** Tests: builds a stand-in client for a key. */
  createClient?: (apiKey: string) => Promise<StreamingClient>;
  now?: () => number;
}

async function sdkClient(apiKey: string): Promise<StreamingClient> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  // maxRetries 0: the gateway owns retries, backoff and fallbacks, so behaviour is testable.
  return new AnthropicClient({ apiKey, maxRetries: 0 }) as Anthropic as unknown as StreamingClient;
}

/**
 * `ClerkModelPort` on the Anthropic API, with each org's own key (AI-02a). SDK clients are cached
 * per org for `CLIENT_TTL_MS` and only while the key is unchanged; there is no process-wide client.
 * Retries and model fallbacks are the gateway's job.
 */
export function anthropicModel(options: AnthropicModelOptions = {}): ClerkModelPort {
  const createClient = options.createClient ?? sdkClient;
  const now = options.now ?? Date.now;
  const clients = new Map<string, { apiKey: string; client: StreamingClient; expiresAt: number }>();

  async function clientFor(orgId: string, apiKey: string): Promise<StreamingClient> {
    if (!apiKey) throw new ClerkModelError('auth', 'No API key for this org');
    const at = now();
    for (const [key, entry] of clients) if (entry.expiresAt <= at) clients.delete(key);
    const cached = clients.get(orgId);
    if (cached && cached.apiKey === apiKey) return cached.client;
    const client = await createClient(apiKey);
    clients.set(orgId, { apiKey, client, expiresAt: at + CLIENT_TTL_MS });
    return client;
  }

  return {
    async run(request: ClerkModelRequest, onEvent?: (event: ClerkStreamEvent) => void): Promise<ClerkModelResult> {
      const api = await clientFor(request.credentials.orgId, request.credentials.apiKey);
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

    async listModels(apiKey: string): Promise<string[]> {
      // A fresh client: the key isn't saved yet, so it isn't any org's cached key.
      const api = await createClient(apiKey);
      try {
        const page = await api.models.list({ limit: 100 }, { timeout: LIST_MODELS_TIMEOUT_MS });
        return page.data.map((model) => model.id);
      } catch (error) {
        throw mapError(error, false);
      }
    },
  };
}
