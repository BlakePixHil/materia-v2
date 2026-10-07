import type { z } from 'zod';

import {
  citedClaims,
  CLERK_FALLBACKS,
  clerkModelFor,
  costMicros,
  mapCitations,
  markClaims,
  OUTPUT_SCHEMAS,
  renderPrompt,
  totalTokens,
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
  clerkAcknowledged,
  DomainError,
  orgClerkFeatureOn,
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
  type ClerkToolDefinition,
  type ClerkToolUse,
  type ClerkTurn,
  type Clock,
} from '../ports';
import { verifyCitations } from './citations';
import type { ClerkContext } from './context/build-context';
import type { DocumentTextPort } from './context/ports';
import {
  CLERK_FEATURES,
  DEFAULT_MONTHLY_TOKEN_BUDGET,
  DEFAULT_USER_RATE_LIMIT,
  MAX_RETRIES,
  MAX_TOOL_ROUNDS,
  meteringDay,
  meteringPeriod,
  type ClerkFeature,
} from './features';
import type { ClerkKeyring } from './keyring';
import type {
  ClerkMessageStatus,
  ClerkStore,
  ExchangeSources,
  MessageSink,
  OrgClerkSettings,
  ToolCallState,
} from './store';

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

/** What a tool returns (AI-06): text (JSON for records), and passages the model can cite. */
export interface ClerkToolOutput {
  text?: string;
  passages?: GatewayChunk[];
  isError?: boolean;
}

/**
 * The read-only tools a request offers (AI-06). The prompt's `tools` front-matter picks which of
 * the definitions are sent; the model chooses whether to call them (never forced).
 */
export interface ClerkToolbox {
  definitions: ClerkToolDefinition[];
  run(use: ClerkToolUse): Promise<ClerkToolOutput>;
}

/** A conversation's earlier exchanges, replayed verbatim (AI-06), and the sources they carried. */
export interface ClerkHistory {
  turns: ClerkTurn[];
  sources: ExchangeSources;
}

function searchFields(chunk: GatewayChunk): { source: string; title: string; text: string } {
  return { source: chunk.source, title: chunk.title, text: chunk.text };
}

function searchBlock(chunk: GatewayChunk): ClerkContentBlock {
  return { type: 'search_result', ...searchFields(chunk) };
}

function toolText(toolUseId: string, text: string, isError: boolean): ClerkContentBlock {
  return { type: 'tool_result', toolUseId, content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function addUsage(a: ClerkUsage, b: ClerkUsage): ClerkUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * The steps of a tool loop as one answer: their text joined by blank lines, and their content with
 * a blank text block between steps that both have text (so cited claims line up with the text).
 */
function joinSteps(contents: readonly (readonly unknown[])[]): { content: unknown[]; text: string } {
  const textOf = (content: readonly unknown[]) =>
    content
      .filter((block) => (block as { type?: string }).type === 'text')
      .map((block) => (block as { text?: string }).text ?? '')
      .join('');
  const content: unknown[] = [];
  const texts: string[] = [];
  for (const step of contents) {
    const text = textOf(step);
    if (text && texts.length) content.push({ type: 'text', text: '\n\n' });
    if (text) texts.push(text);
    content.push(...step);
  }
  return { content, text: texts.join('\n\n') };
}

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
  /**
   * Stream into `clerkThreads/{threadId}/messages/{messageId}`; `adopt` takes over the message
   * `clerk-sendMessage` created (AI-06) instead of creating it.
   */
  stream?: { threadId: string; messageId: string; adopt?: boolean };
  /**
   * Streams into a sink the caller opened instead of a Clerk message (AI-10 drafts stream into the
   * draft). The caller writes the final record from the result; `finish` only settles the stream.
   */
  sink?: MessageSink;
  /** Earlier exchanges of the conversation, sent first and unchanged (AI-06). */
  history?: ClerkHistory;
  /** Blocks before the question in this turn (a continued thread's summary, AI-06). */
  prelude?: ClerkContentBlock[];
  /** Read-only tools the model may call (AI-06), filtered by the prompt's `tools`. */
  tools?: ClerkToolbox;
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
  /**
   * The reply's citations (ADR-043). For a matter-scoped reply they are verified against the
   * chunks: those whose quote wasn't found carry `verified: false` and must not be shown.
   */
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
  /**
   * Page text from chunks (AI-04), to verify a matter-scoped reply's citations (AI-05). Without it,
   * or without a matter context, citations are stored unchecked.
   */
  citationText?: DocumentTextPort;
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

/**
 * The month's limits (AI-13): the token budget, and the spend limit an admin sets in US cents
 * (`used` from `ClerkStore.periodUsage`). A limit lowered below this month's spend blocks Clerk for
 * the rest of the month. CLERK_BUDGET_EXCEEDED, with `spend: true` for the spend limit. The gateway
 * checks it before every call, and `clerk-sendMessage` before it accepts a question.
 */
export function assertWithinBudget(
  settings: Pick<OrgClerkSettings, 'monthlyTokenBudget' | 'monthlyBudgetCents'>,
  used: { tokens: number; costMicros: number },
  period: string,
): void {
  if (used.tokens >= (settings.monthlyTokenBudget ?? DEFAULT_MONTHLY_TOKEN_BUDGET)) {
    throw new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk budget used', { period });
  }
  if (settings.monthlyBudgetCents !== undefined && used.costMicros >= settings.monthlyBudgetCents * 10_000) {
    throw new DomainError('CLERK_BUDGET_EXCEEDED', 'Monthly Clerk spend limit reached', { period, spend: true });
  }
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
 * ClerkGateway (AI-02, AI-02a, AI-13): the only path from a Clerk feature to Claude. In order: kill
 * switches and the org's toggles and disclosure acknowledgement → the org's key and model → prompt
 * → budget → rate limit → the call (retries, then fallback models; with tools, a loop of tool
 * rounds, AI-06) → status from the stop reason → structured-output validation → citations →
 * metering → message → metadata-only log.
 */
export function createClerkGateway(deps: GatewayDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  /**
   * Step 1 of `run` on its own: the role, the kill switches, the org's own toggles and its
   * acknowledgement of the data-use disclosure. A feature that shows a kept reply without calling
   * the model (INS-04) checks this first, so turning Clerk off hides what it wrote too.
   */
  async function assertOn(ctx: Pick<GatewayContext, 'orgId' | 'role'>, name: ClerkFeature): Promise<OrgClerkSettings> {
    const feature = CLERK_FEATURES[name];
    if (!(PERMISSIONS['clerk.use'] as readonly Role[]).includes(ctx.role))
      throw new DomainError('PERMISSION_DENIED', 'This role cannot use Clerk');
    if (!(await deps.flag(ctx.orgId, 'clerk.enabled'))) throw disabled('clerk.enabled');
    if (feature.flag && !(await deps.flag(ctx.orgId, feature.flag))) throw disabled(feature.flag);
    const settings = await deps.store.orgSettings(ctx.orgId);
    if (settings.enabled === false) throw disabled('org.settings.clerk.enabled');
    // The org's own toggles (AI-13): a feature turned off, and the data-use disclosure, which an
    // owner or admin acknowledges before Clerk first sends the firm's data (again for a new version).
    const orgFeature = 'orgFeature' in feature ? feature.orgFeature : undefined;
    if (orgFeature && !orgClerkFeatureOn(settings, orgFeature))
      throw disabled(`org.settings.clerk.features.${orgFeature}`);
    if (!('noClientData' in feature && feature.noClientData) && !clerkAcknowledged(settings))
      throw disabled('org.settings.clerk.acknowledgement');
    return settings;
  }

  async function run<TOutput = unknown>(input: ClerkRunInput<TOutput>): Promise<ClerkRunResult<TOutput>> {
    const { ctx } = input;
    const started = now();
    const feature = CLERK_FEATURES[input.feature];

    // 1. Kill switches, before anything else.
    const settings = await assertOn(ctx, input.feature);

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
    const used = await deps.store.periodUsage(ctx.orgId, period);
    assertWithinBudget(settings, used, period);
    const window = settings.userRateLimit ?? DEFAULT_USER_RATE_LIMIT;
    const background = 'background' in feature && feature.background;
    const slot = background
      ? 'ok'
      : await deps.store.takeRateSlot(ctx.orgId, ctx.uid, at.getTime(), {
          requests: window.requests,
          windowMs: window.windowMinutes * 60_000,
          ...(settings.perUserDailyRequests
            ? { daily: { limit: settings.perUserDailyRequests, day: meteringDay(at) } }
            : {}),
        });
    if (slot === 'daily')
      throw new DomainError('CLERK_RATE_LIMITED', 'Daily Clerk request limit reached', {
        daily: settings.perUserDailyRequests,
      });
    if (slot !== 'ok')
      throw new DomainError('CLERK_RATE_LIMITED', 'Too many Clerk requests', { windowMinutes: window.windowMinutes });

    // 4. The request: documents and chunks first (the stable, cached prefix), then the question.
    // A built context (AI-03) puts its matter facts first instead (the cached prefix) and its
    // notices after the documents and chunks, which are then the volatile part. A conversation's
    // earlier exchanges (AI-06) come before it, exactly as they were sent and answered.
    const context = input.context;
    const documents = context?.documents ?? input.documents ?? [];
    const searchResults = context?.searchResults ?? input.searchResults ?? [];
    const content: ClerkContentBlock[] = [
      ...documents.map((doc): ClerkContentBlock => ({
        type: 'document',
        ...(doc.title ? { title: doc.title } : {}),
        source: doc.source,
      })),
      ...searchResults.map(searchBlock),
    ];
    if (context) {
      content.unshift(...context.contextBlocks.stable);
      content.push(...context.contextBlocks.volatile);
    } else if (content.length)
      content[content.length - 1] = { ...content[content.length - 1], cache: true } as ClerkContentBlock;
    content.push(...(input.prelude ?? []), { type: 'text', text: prompt.user });
    const contextResult = context
      ? { manifest: context.manifest, truncated: context.truncated, privileged: context.manifest.privileged }
      : {};
    const history = input.history?.turns ?? [];
    // The API numbers documents and passages across the whole request, in order: earlier exchanges
    // first, then this question's, then what tools return.
    const sources = {
      documents: [...(input.history?.sources.documents ?? []), ...documents],
      searchResults: [...(input.history?.sources.searchResults ?? []), ...searchResults],
    };
    const exchangeSources = { documents: [...documents], searchResults: [...searchResults] };
    const userTurn: ClerkTurn = { role: 'user', content };
    const toolbox = input.tools;
    const tools = toolbox?.definitions.filter((tool) => prompt.meta.tools.includes(tool.name)) ?? [];

    // 5. The message to stream into, and stop handling.
    const abort = new AbortController();
    let sink: MessageSink | undefined = input.sink;
    if (!sink && input.stream) {
      sink = await deps.store.openMessage(ctx.orgId, input.stream, {
        uid: ctx.uid,
        promptRef: prompt.ref,
        requestId: ctx.requestId,
        ...(context ? { manifest: context.manifest } : {}),
        ...(input.stream.adopt ? { adopt: true } : {}),
      });
    }
    sink?.onStop(() => abort.abort());
    let streamed = '';
    /** Text from earlier steps of a tool loop is kept; the next step's text follows a blank line. */
    let stepStart = true;
    const onEvent = (event: { text: string }) => {
      if (stepStart && streamed && event.text) streamed += '\n\n';
      if (event.text) stepStart = false;
      streamed += event.text;
      sink?.write(streamed);
    };

    const base = {
      system: context ? `${context.system}\n\n${prompt.system}` : prompt.system,
      maxTokens: prompt.meta.maxTokens,
      effort: prompt.meta.effort,
      timeoutMs: feature.timeoutMs,
      signal: abort.signal,
      ...(schema ? { output: { name: schemaName ?? 'custom', schema } } : {}),
      ...(tools.length ? { tools } : {}),
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
    const ended = (status: 'stopped' | 'error', model: string, fallbackUsed: boolean): ClerkRunResult<TOutput> => ({
      status,
      text: streamed,
      citations: [],
      usage: ZERO_USAGE,
      stopReason: status,
      model,
      promptRef: prompt.ref,
      fallbackUsed,
      costMicros: 0,
      ...contextResult,
    });

    // 6. The call: the primary with retries, then each fallback model once (a fresh branch: the
    // request carries no earlier assistant turns, so no thinking blocks cross models). With tools
    // (AI-06), each tool round is another call on the same model, up to MAX_TOOL_ROUNDS.
    const models = [primary, ...fallbackModels];
    let modelIndex = 0;
    let attempts = 0;
    const steps: ClerkTurn[] = [];
    const contents: (readonly unknown[])[] = [];
    const calls: ToolCallState[] = [];
    const rawCitations: unknown[] = [];
    let usage: ClerkUsage = ZERO_USAGE;
    let result: ClerkModelResult | undefined;
    let rounds = 0;
    try {
      for (;;) {
        const first = !steps.length;
        let stepResult: ClerkModelResult | undefined;
        outer: for (; modelIndex < models.length; modelIndex++) {
          const model = models[modelIndex] as string;
          const tries = modelIndex === 0 || !first ? MAX_RETRIES + 1 : 1;
          for (let attempt = 0; attempt < tries; attempt++) {
            attempts++;
            stepStart = true;
            try {
              stepResult = await deps.model.run(
                {
                  ...base,
                  // A fallback model starts a fresh branch: this question only, never earlier turns.
                  messages: modelIndex > 0 ? [userTurn, ...steps] : [...history, userTurn, ...steps],
                  model,
                  credentials,
                  serverFallbacks: (deps.serverFallbacks ?? true) && modelIndex === 0,
                },
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
                return ended('stopped', model, modelIndex > 0);
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
                return ended('error', model, modelIndex > 0);
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
          // After a tool round the conversation is bound to this model: no fallback mid-answer.
          if (!first) break;
        }
        if (!stepResult) {
          await finishFailed('error', models[Math.min(modelIndex, models.length - 1)] as string);
          throw new DomainError('CLERK_UNAVAILABLE', 'Clerk is unavailable');
        }
        result = stepResult;
        usage = addUsage(usage, stepResult.usage);
        contents.push(stepResult.content);
        rawCitations.push(...stepResult.citations);
        steps.push({ role: 'assistant', content: stepResult.content });

        // 6b. Tools the model chose (read-only, scoped by the toolbox). Past the limit, each call is
        // answered "no more tools" and the model gets one last turn to answer with what it has.
        const uses = stepResult.toolUses ?? [];
        if (stepResult.stopReason !== 'tool_use' || !uses.length || !toolbox || rounds > MAX_TOOL_ROUNDS) break;
        rounds++;
        const answers: ClerkContentBlock[] = [];
        for (const use of uses) {
          if (abort.signal.aborted) break;
          if (rounds > MAX_TOOL_ROUNDS) {
            answers.push(toolText(use.id, 'Tool limit reached: answer with what you have.', true));
            continue;
          }
          const call: ToolCallState = { id: use.id, name: use.name, status: 'running' };
          calls.push(call);
          sink?.tools(calls);
          let output: ClerkToolOutput;
          try {
            output = await toolbox.run(use);
          } catch {
            output = { text: 'The tool failed.', isError: true };
          }
          call.status = output.isError ? 'error' : 'done';
          sink?.tools(calls);
          const passages = output.passages ?? [];
          sources.searchResults.push(...passages);
          exchangeSources.searchResults.push(...passages);
          answers.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: [
              ...(output.text !== undefined || !passages.length
                ? [{ type: 'text' as const, text: output.text ?? '' }]
                : []),
              ...passages.map((chunk) => ({ type: 'search_result' as const, ...searchFields(chunk) })),
            ],
            ...(output.isError ? { isError: true } : {}),
          });
          ctx.log.info('clerk tool', {
            ...logBase,
            tool: use.name,
            passages: passages.length,
            error: !!output.isError,
          });
        }
        if (abort.signal.aborted) {
          ctx.log.info('clerk call stopped', { ...logBase, model: result.model, attempts, latencyMs: now() - started });
          await finishFailed('stopped', result.model);
          await meter(input, ctx, period, result.model, primary, usage);
          return ended('stopped', result.model, modelIndex > 0);
        }
        steps.push({ role: 'user', content: answers });
      }
    } finally {
      sink?.close();
    }
    if (!result) throw new DomainError('CLERK_UNAVAILABLE', 'Clerk is unavailable');
    const joined = joinSteps(contents);

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

    // 8. Citations (mapped, then verified against the chunks for a matter-scoped reply, AI-05),
    // cost, metering. A citation whose quote isn't on its page is kept with `verified: false`:
    // never shown, counted as `citation_unverified`.
    const mapped = mapCitations(rawCitations as ModelCitation[], sources);
    let citations = mapped.citations;
    const checked = { verified: 0, unverified: 0 };
    const scope = context?.manifest.scope;
    if (citations.length && scope?.kind === 'matter' && deps.citationText) {
      const verified = await verifyCitations(
        citations,
        { orgId: ctx.orgId, matterId: scope.matterId },
        deps.citationText,
      );
      citations = verified.citations;
      checked.verified = verified.verified;
      checked.unverified = verified.unverified;
    }
    const cost = await meter(
      input,
      ctx,
      period,
      result.model,
      primary,
      usage,
      { used: used.tokens, limit: budget },
      checked,
    );
    const fallbackUsed = modelIndex > 0 || result.serverFallback;

    // 9. The message, verbatim turns included. Each cited claim carries `[n]` markers for its
    // citations (n = index + 1 in `citations`), so the UI can mark a claim that lost them all.
    await sink?.finish({
      status,
      text: citations.length ? markClaims(citedClaims(joined.content, joined.text, citations, sources)) : joined.text,
      citations,
      usage,
      model: result.model,
      fallbackUsed,
      raw: result.content,
      exchange: {
        // Stored without cache markers: a later turn moves the breakpoint to its own question.
        user: content.map((block) => {
          const stored = { ...block };
          delete stored.cache;
          return stored;
        }),
        turns: steps,
        sources: exchangeSources,
        model: result.model,
      },
    });

    // 10. Metadata only: never prompt or completion text.
    const level = status === 'done' ? 'info' : 'warn';
    ctx.log[level]('clerk call', {
      ...logBase,
      model: result.model,
      status,
      stopReason: result.stopReason,
      ...usage,
      costMicros: cost,
      latencyMs: now() - started,
      attempts,
      fallbackUsed,
      citations: citations.length,
      unmappedCitations: mapped.unmapped,
      ...(calls.length ? { toolCalls: calls.length, toolRounds: rounds } : {}),
      ...(checked.unverified ? { unverifiedCitations: checked.unverified } : {}),
      ...(invalidIssues ? { invalidIssues } : {}),
    });

    return {
      status,
      text: joined.text,
      ...(parsed !== undefined ? { parsed } : {}),
      citations,
      usage,
      stopReason: result.stopReason,
      model: result.model,
      promptRef: prompt.ref,
      fallbackUsed,
      costMicros: cost,
      ...contextResult,
    };
  }

  /** Share of the monthly token budget that raises the ops alert, once per period. */
  const BUDGET_ALERT_SHARE = 0.8;

  async function meter(
    input: ClerkRunInput<unknown>,
    ctx: GatewayContext,
    period: string,
    model: string,
    primary: string,
    usage: ClerkUsage,
    budget?: { used: number; limit: number },
    citations?: { verified: number; unverified: number },
  ): Promise<number> {
    const cost = costMicros(model, usage, primary);
    try {
      await deps.store.meter(
        ctx.orgId,
        period,
        {
          feature: input.feature,
          uid: ctx.uid,
          usage,
          costMicros: cost.micros,
          costEstimated: cost.estimated,
          ...(citations && citations.verified + citations.unverified ? { citations } : {}),
        },
        ctx.clock.now(),
      );
      // The ops dashboard's Clerk tokens and spend, and the "Clerk budget at 80%" alert (FND-21).
      const tokens = totalTokens(usage);
      ctx.log.info('clerk metered', { feature: input.feature, model, tokens, costMicros: cost.micros });
      const threshold = budget ? budget.limit * BUDGET_ALERT_SHARE : Infinity;
      if (budget && budget.used < threshold && budget.used + tokens >= threshold) {
        ctx.log.warn('clerk budget threshold', { period, percent: BUDGET_ALERT_SHARE * 100, limit: budget.limit });
      }
    } catch {
      // Metering must not lose the user's answer; the gap shows in the error log.
      ctx.log.error('clerk metering failed', { feature: input.feature, period });
    }
    return cost.micros;
  }

  return { run, assertOn };
}

export type ClerkGateway = ReturnType<typeof createClerkGateway>;
