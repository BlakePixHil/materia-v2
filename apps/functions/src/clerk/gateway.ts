import type { z } from 'zod';

import {
  CLERK_FALLBACKS,
  clerkModelFor,
  costMicros,
  mapCitations,
  OUTPUT_SCHEMAS,
  renderPrompt,
  ZERO_USAGE,
  type CitedChunk,
  type CitedDocument,
  type ClerkCitation,
  type ClerkUsage,
  type ModelCitation,
  type OutputSchemaName,
  type PromptVariables,
} from '@materia/clerk';
import {
  DomainError,
  PERMISSIONS,
  type ContextManifest,
  type ContextTruncation,
  type FlagKey,
  type Role,
} from '@materia/domain';

import type { Log } from '../core/log';
import {
  ClerkModelError,
  type ClerkContentBlock,
  type ClerkModelPort,
  type ClerkModelResult,
  type Clock,
} from '../ports';
import type { ClerkContext } from './context/build-context';
import {
  CLERK_FEATURES,
  DEFAULT_MONTHLY_TOKEN_BUDGET,
  DEFAULT_USER_RATE_LIMIT,
  MAX_RETRIES,
  meteringPeriod,
  type ClerkFeature,
} from './features';
import type { ClerkKeyring } from './keyring';
import type { ClerkMessageStatus, ClerkStore, MessageSink } from './store';

export interface GatewayContext {
  orgId: string;
  uid: string;
  role: Role;
  requestId: string;
  log: Log;
  clock: Clock;
}

export type GatewayDocument = CitedDocument & {
  title?: string;
  source: { kind: 'text'; text: string } | { kind: 'pdf'; base64: string };
};
export type GatewayChunk = CitedChunk & { title: string; text: string; source: string };

export interface ClerkRunInput<TOutput = unknown> {
  ctx: GatewayContext;
  feature: ClerkFeature;
  /** `id@version`, or a bare `id` for the latest version. */
  promptId: string;
  vars: PromptVariables;
  /** Sent as `document` blocks with citations on (matter context goes first and is cached). */
  documents?: GatewayDocument[];
  /** Retrieved chunks, sent as `search_result` blocks. */
  searchResults?: GatewayChunk[];
  /** Stream into `clerkThreads/{threadId}/messages/{messageId}`. */
  stream?: { threadId: string; messageId: string };
  /** Overrides the prompt's `outputSchema`. */
  output?: z.ZodType<TOutput>;
  /**
   * What `buildContext` allowed for this request (AI-03). Its system prompt goes before the
   * prompt's own, its documents and chunks replace `documents` and `searchResults`, and its
   * manifest is stored on the message and returned.
   */
  context?: ClerkContext;
}

export type ClerkRunStatus = ClerkMessageStatus;

export interface ClerkRunResult<TOutput = unknown> {
  status: ClerkRunStatus;
  text?: string;
  parsed?: TOutput;
  citations: ClerkCitation[];
  usage: ClerkUsage;
  stopReason: string;
  model: string;
  promptRef: string;
  fallbackUsed: boolean;
  costMicros: number;
  /** With a built context (AI-03): its sources, what was dropped to fit, and whether it is privileged. */
  manifest?: ContextManifest;
  truncated?: ContextTruncation | null;
  privileged?: boolean;
}

export interface GatewayDeps {
  model: ClerkModelPort;
  store: ClerkStore;
  /** Each org's own Anthropic key (BYOK, AI-02a). */
  keyring: ClerkKeyring;
  /** Whether a flag is on for the org (org override > Remote Config > default). */
  flag: (orgId: string, key: FlagKey) => Promise<boolean>;
  /** Availability fallbacks after the primary's retries (default: the org model's chain, ADR-011b; [] for none). */
  fallbackModels?: readonly string[];
  /** Let the API reroute refusals itself (first-party API, ADR-011a). */
  serverFallbacks?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const RETRYABLE = new Set(['rate_limited', 'overloaded', 'server', 'timeout', 'disconnected']);

function disabled(flag: string): DomainError {
  return new DomainError('CLERK_DISABLED', 'Clerk is switched off', { switch: flag });
}

/** The switch named when the org has no Anthropic key: Clerk is off until an admin adds one (AI-02a). */
export const BYOK_MISSING_SWITCH = 'org.byok.missing';

function keyInvalid(): DomainError {
  return new DomainError('CLERK_KEY_INVALID', 'Anthropic rejected the org’s API key; an admin must replace it');
}

/** Jittered exponential backoff: 0.5 s, 1 s, … times 0.5–1.5, or the provider's retry-after. */
export function backoffMs(attempt: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  return Math.round(500 * 2 ** attempt * (0.5 + random()));
}

function statusFor(stopReason: string): ClerkRunStatus {
  if (stopReason === 'refusal') return 'refused';
  if (stopReason === 'max_tokens') return 'truncated';
  return 'done';
}

/**
 * ClerkGateway (AI-02, AI-02a): the only path from a Clerk feature to Claude. In order: kill
 * switches → the org's key and model → prompt → budget → rate limit → the call (retries, then
 * fallback models) → status from the stop reason → structured-output validation → citations →
 * metering → message → metadata-only log.
 */
export function createClerkGateway(deps: GatewayDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  async function run<TOutput = unknown>(input: ClerkRunInput<TOutput>): Promise<ClerkRunResult<TOutput>> {
    const { ctx } = input;
    const started = now();
    const feature = CLERK_FEATURES[input.feature];
    if (!(PERMISSIONS['clerk.use'] as readonly Role[]).includes(ctx.role))
      throw new DomainError('PERMISSION_DENIED', 'This role cannot use Clerk');

    // 1. Kill switches, before anything else.
    if (!(await deps.flag(ctx.orgId, 'clerk.enabled'))) throw disabled('clerk.enabled');
    if (feature.flag && !(await deps.flag(ctx.orgId, feature.flag))) throw disabled(feature.flag);
    const settings = await deps.store.orgSettings(ctx.orgId);
    if (settings.enabled === false) throw disabled('org.settings.clerk.enabled');

    // 1b. The org's own key and model (BYOK). No key: Clerk is off for the org. A key Anthropic
    // rejected stays unusable until an admin replaces it. Resolved per call, so a rotated key
    // applies to the next call while a running one finishes on the old key.
    const key = await deps.keyring.resolve(ctx.orgId);
    if (key.state === 'missing') throw disabled(BYOK_MISSING_SWITCH);
    if (key.state === 'invalid') throw keyInvalid();
    const primary = clerkModelFor(settings.model);
    const fallbackModels = deps.fallbackModels ?? CLERK_FALLBACKS[primary];
    const credentials = { orgId: ctx.orgId, apiKey: key.apiKey };

    // 2. The prompt (strict variables) and its output schema.
    const prompt = renderPrompt(input.promptId, input.vars);
    const schemaName = prompt.meta.outputSchema as OutputSchemaName | undefined;
    const schema: z.ZodType | undefined = input.output ?? (schemaName ? OUTPUT_SCHEMAS[schemaName] : undefined);

    // 3. Limits, checked before the call. Budget first, so a blocked call takes no rate slot.
    const at = ctx.clock.now();
    const period = meteringPeriod(at);
    const budget = settings.monthlyTokenBudget ?? DEFAULT_MONTHLY_TOKEN_BUDGET;
    if ((await deps.store.periodTokens(ctx.orgId, period)) >= budget) {
      throw new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk budget used', { period });
    }
    const window = settings.userRateLimit ?? DEFAULT_USER_RATE_LIMIT;
    const allowed = await deps.store.takeRateSlot(ctx.orgId, ctx.uid, at.getTime(), {
      requests: window.requests,
      windowMs: window.windowMinutes * 60_000,
    });
    if (!allowed)
      throw new DomainError('CLERK_RATE_LIMITED', 'Too many Clerk requests', { windowMinutes: window.windowMinutes });

    // 4. The request: documents and chunks first (the stable, cached prefix), then the question.
    // A built context (AI-03) puts its matter facts first instead (the cached prefix) and its
    // notices after the documents and chunks, which are then the volatile part.
    const context = input.context;
    const documents = context?.documents ?? input.documents ?? [];
    const searchResults = context?.searchResults ?? input.searchResults ?? [];
    const content: ClerkContentBlock[] = [
      ...documents.map((doc): ClerkContentBlock => ({
        type: 'document',
        ...(doc.title ? { title: doc.title } : {}),
        source: doc.source,
      })),
      ...searchResults.map((chunk): ClerkContentBlock => ({
        type: 'search_result',
        source: chunk.source,
        title: chunk.title,
        text: chunk.text,
      })),
    ];
    if (context) {
      content.unshift(...context.contextBlocks.stable);
      content.push(...context.contextBlocks.volatile);
    } else if (content.length)
      content[content.length - 1] = { ...content[content.length - 1], cache: true } as ClerkContentBlock;
    content.push({ type: 'text', text: prompt.user });
    const contextResult = context
      ? { manifest: context.manifest, truncated: context.truncated, privileged: context.manifest.privileged }
      : {};

    // 5. The message to stream into, and stop handling.
    const abort = new AbortController();
    let sink: MessageSink | undefined;
    if (input.stream) {
      sink = await deps.store.openMessage(ctx.orgId, input.stream, {
        uid: ctx.uid,
        promptRef: prompt.ref,
        requestId: ctx.requestId,
        ...(context ? { manifest: context.manifest } : {}),
      });
      sink.onStop(() => abort.abort());
    }
    let streamed = '';
    const onEvent = (event: { text: string }) => {
      streamed += event.text;
      sink?.write(streamed);
    };

    const base = {
      system: context ? `${context.system}\n\n${prompt.system}` : prompt.system,
      messages: [{ role: 'user' as const, content }],
      maxTokens: prompt.meta.maxTokens,
      effort: prompt.meta.effort,
      timeoutMs: feature.timeoutMs,
      signal: abort.signal,
      ...(schema ? { output: { name: schemaName ?? 'custom', schema } } : {}),
    };

    const logBase = { feature: input.feature, promptRef: prompt.ref, primary };
    const finishFailed = async (status: ClerkRunStatus, model: string) => {
      await sink?.finish({
        status,
        text: streamed,
        citations: [],
        usage: ZERO_USAGE,
        model,
        fallbackUsed: model !== primary,
        raw: [],
      });
    };

    // 6. The call: the primary with retries, then each fallback model once (a fresh branch: the
    // request carries no earlier assistant turns, so no thinking blocks cross models).
    const models = [primary, ...fallbackModels];
    let result: ClerkModelResult | undefined;
    let modelIndex = 0;
    let attempts = 0;
    try {
      outer: for (; modelIndex < models.length; modelIndex++) {
        const model = models[modelIndex] as string;
        const tries = modelIndex === 0 ? MAX_RETRIES + 1 : 1;
        for (let attempt = 0; attempt < tries; attempt++) {
          attempts++;
          try {
            result = await deps.model.run(
              { ...base, model, credentials, serverFallbacks: (deps.serverFallbacks ?? true) && modelIndex === 0 },
              onEvent,
            );
            break outer;
          } catch (raw) {
            const error =
              raw instanceof ClerkModelError ? raw : new ClerkModelError('server', 'Unexpected provider failure');
            if (error.kind === 'aborted' || abort.signal.aborted) {
              ctx.log.info('clerk call stopped', { ...logBase, model, attempts, latencyMs: now() - started });
              await finishFailed('stopped', model);
              await meter(input, ctx, period, model, primary, ZERO_USAGE);
              return {
                status: 'stopped',
                text: streamed,
                citations: [],
                usage: ZERO_USAGE,
                stopReason: 'stopped',
                model,
                promptRef: prompt.ref,
                fallbackUsed: modelIndex > 0,
                costMicros: 0,
                ...contextResult,
              };
            }
            // Text already reached the user: a retry would repeat it. Keep the partial reply.
            if (streamed) {
              ctx.log.warn('clerk stream failed', {
                ...logBase,
                model,
                kind: error.kind,
                attempts,
                latencyMs: now() - started,
              });
              await finishFailed('error', model);
              return {
                status: 'error',
                text: streamed,
                citations: [],
                usage: ZERO_USAGE,
                stopReason: 'error',
                model,
                promptRef: prompt.ref,
                fallbackUsed: modelIndex > 0,
                costMicros: 0,
                ...contextResult,
              };
            }
            // The org's key was rejected (revoked, or out of credit on a disabled account): mark it
            // invalid, so no further call is made with it, and tell the user an admin must act.
            if (error.kind === 'auth') {
              ctx.log.error('clerk key rejected', { ...logBase, model, status: error.status });
              await deps.keyring.markInvalid(ctx.orgId, key.version, ctx.clock.now());
              await finishFailed('error', model);
              throw keyInvalid();
            }
            if (!RETRYABLE.has(error.kind)) {
              ctx.log.error('clerk provider rejected the call', {
                ...logBase,
                model,
                kind: error.kind,
                status: error.status,
              });
              await finishFailed('error', model);
              throw new DomainError('CLERK_UNAVAILABLE', 'Clerk is unavailable');
            }
            ctx.log.warn('clerk provider error', {
              ...logBase,
              model,
              kind: error.kind,
              status: error.status,
              attempt,
            });
            // A provider rate limit is not a reason to switch models: "Clerk is busy".
            if (error.kind === 'rate_limited' && attempt === tries - 1) {
              await finishFailed('error', model);
              throw new DomainError('CLERK_BUSY', 'The model provider is rate-limiting');
            }
            if (attempt < tries - 1) await sleep(backoffMs(attempt, random, error.retryAfterMs));
          }
        }
      }
    } finally {
      sink?.close();
    }
    if (!result) {
      await finishFailed('error', models[models.length - 1] as string);
      throw new DomainError('CLERK_UNAVAILABLE', 'Clerk is unavailable');
    }

    // 7. Status from the stop reason (refusal and max_tokens first), then structured output.
    let status = statusFor(result.stopReason);
    let parsed: TOutput | undefined;
    let invalidIssues = 0;
    if (status === 'done' && schema) {
      let candidate: unknown;
      let isJson = true;
      try {
        candidate = JSON.parse(result.text);
      } catch {
        isJson = false;
      }
      const checked = isJson ? schema.safeParse(candidate) : undefined;
      if (checked?.success) parsed = checked.data as TOutput;
      else {
        status = 'invalid_output';
        invalidIssues = checked ? checked.error.issues.length : 1;
      }
    }

    // 8. Citations, cost, metering.
    const mapped = mapCitations(result.citations as ModelCitation[], { documents, searchResults });
    const cost = await meter(input, ctx, period, result.model, primary, result.usage);
    const fallbackUsed = modelIndex > 0 || result.serverFallback;

    // 9. The message, verbatim turn included.
    await sink?.finish({
      status,
      text: result.text,
      citations: mapped.citations,
      usage: result.usage,
      model: result.model,
      fallbackUsed,
      raw: result.content,
    });

    // 10. Metadata only: never prompt or completion text.
    const level = status === 'done' ? 'info' : 'warn';
    ctx.log[level]('clerk call', {
      ...logBase,
      model: result.model,
      status,
      stopReason: result.stopReason,
      ...result.usage,
      costMicros: cost,
      latencyMs: now() - started,
      attempts,
      fallbackUsed,
      citations: mapped.citations.length,
      unmappedCitations: mapped.unmapped,
      ...(invalidIssues ? { invalidIssues } : {}),
    });

    return {
      status,
      text: result.text,
      ...(parsed !== undefined ? { parsed } : {}),
      citations: mapped.citations,
      usage: result.usage,
      stopReason: result.stopReason,
      model: result.model,
      promptRef: prompt.ref,
      fallbackUsed,
      costMicros: cost,
      ...contextResult,
    };
  }

  async function meter(
    input: ClerkRunInput<unknown>,
    ctx: GatewayContext,
    period: string,
    model: string,
    primary: string,
    usage: ClerkUsage,
  ): Promise<number> {
    const cost = costMicros(model, usage, primary);
    try {
      await deps.store.meter(
        ctx.orgId,
        period,
        { feature: input.feature, uid: ctx.uid, usage, costMicros: cost.micros, costEstimated: cost.estimated },
        ctx.clock.now(),
      );
    } catch {
      // Metering must not lose the user's answer; the gap shows in the error log.
      ctx.log.error('clerk metering failed', { feature: input.feature, period });
    }
    return cost.micros;
  }

  return { run };
}

export type ClerkGateway = ReturnType<typeof createClerkGateway>;
