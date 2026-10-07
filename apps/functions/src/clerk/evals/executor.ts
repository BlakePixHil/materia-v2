import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Firestore } from 'firebase-admin/firestore';

import {
  CLERK_MODELS,
  EventsFromFileOutput,
  citedQuote,
  getPrompt,
  type ClerkCitation,
  type ModelCitation,
  type PromptVariables,
} from '@materia/clerk';
import {
  EVALS_DIR,
  EvalOutageError,
  fixturePages,
  insightsCase,
  readTextFixture,
  sourcePages,
  type CaseExecutor,
  type CaseOutcome,
  type CaseRequest,
  type CitedQuote,
  type DraftedItem,
  type EvalCase,
  type ProposedEvent,
  type TextSpan,
} from '@materia/clerk/evals';
import { DomainError, briefRef, can, checkBrief, narrativePeriodInfo, narrativePromptVars } from '@materia/domain';

import { createLog } from '../../core/log';
import { EVENTS_QUERY, toProposals } from '../../migration/events';
import { ClerkModelError, type ClerkModelPort, type ClerkModelResult } from '../../ports';
import { CHAT_PROMPT, CHAT_TASKS } from '../chat/run';
import { createChatToolbox, type ChatDraft } from '../chat/tools';
import { createContextBuilder } from '../context/build-context';
import { charEstimateCounter, type DocumentTextPort } from '../context/ports';
import { MemoryContextSource, type MemoryMatter } from '../context/testing';
import type { ClerkFeature } from '../features';
import {
  createClerkGateway,
  type ClerkGateway,
  type ClerkRunResult,
  type GatewayContext,
  type GatewayDocument,
} from '../gateway';
import type { ClerkKeyring } from '../keyring';
import { ACKNOWLEDGED_CLERK_SETTINGS, MemoryClerkStore } from '../testing';
import {
  caseNow,
  EVAL_MATTER,
  evalAttachments,
  evalChunkSearch,
  evalDocumentText,
  evalOrg,
  evalToolRecords,
} from './matter';

/** The eval org: fictional, and never a real tenant (evals run outside Firestore). */
const EVAL_ORG = 'org-clerk-evals';

/** Provider failures that are outages (the case is retried, then inconclusive), not defects. */
const OUTAGE_KINDS = new Set(['rate_limited', 'overloaded', 'server', 'timeout', 'disconnected']);

/** The suite feature names (kebab-free ids in the datasets) mapped to gateway features. */
const FEATURES: Record<CaseRequest['feature'], ClerkFeature> = {
  chat: 'chat',
  suggestions: 'suggestions',
  classification: 'classification',
  brief: 'brief',
  willExtraction: 'willExtraction',
  drafting: 'drafting',
  timeAssist: 'timeAssist',
  insightsNarrative: 'insightsNarrative',
  eventsExtraction: 'eventsExtraction',
  matterBrief: 'matterBrief',
};

export interface EvalExecutorOptions {
  /** The provider port: the Anthropic adapter for live runs, the fake one for plumbing checks. */
  model: ClerkModelPort;
  /** The eval key (never an org's key): `CLERK_EVALS_API_KEY`. */
  apiKey: string;
  /** The model under test. Every request goes to it, with no availability fallbacks. */
  modelId: string;
  /** Grade API citations with the LLM judge (`eval-citation-judge`) as well. */
  judge?: boolean;
  root?: string;
  now?: () => number;
  /** The gateway's retry backoff (tests skip it). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A keyring with one key, for evals only: a rejected key fails the run loudly, since every later
 * case would fail the same way.
 */
export function evalKeyring(apiKey: string): ClerkKeyring {
  return {
    async resolve() {
      return { state: 'ok', apiKey, version: 'eval' };
    },
    async markInvalid() {
      throw new Error('The eval API key was rejected (CLERK_EVALS_API_KEY)');
    },
  };
}

/** The placeholders a prompt uses, so only those variables are passed (rendering is strict). */
export function promptPlaceholders(ref: string): string[] {
  const template = getPrompt(ref);
  const names = new Set<string>();
  for (const match of `${template.system}\n${template.user}`.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g))
    names.add(match[1] as string);
  return [...names];
}

/**
 * What a non-chat request may see. Roles without `privileged.view` get no privileged document or
 * note, the same filter the matter context applies in production. Chat cases use production's
 * `buildContext` instead (`runChat`).
 */
export function visibleContext(evalCase: EvalCase) {
  const privileged = can(evalCase.role, 'privileged.view');
  return {
    documents: evalCase.documents.filter((doc) => !doc.privileged || privileged),
    notes: evalCase.notes.filter((note) => !note.privileged || privileged).map((note) => note.text),
  };
}

export function matterContext(evalCase: EvalCase): string {
  const { notes } = visibleContext(evalCase);
  const context = {
    ...(Object.keys(evalCase.matter).length ? { matter: evalCase.matter } : {}),
    ...(notes.length ? { notes } : {}),
  };
  return Object.keys(context).length ? JSON.stringify(context, null, 2) : 'No matter context for this request.';
}

export function caseVariables(promptRef: string, evalCase: EvalCase, root: string = EVALS_DIR): PromptVariables {
  const [first] = visibleContext(evalCase).documents;
  const known: PromptVariables = {
    today: evalCase.today,
    role: evalCase.role,
    matterContext: matterContext(evalCase),
    question: evalCase.query,
    // Document prompts (classification, AI-04): the file's name and how many pages were sent.
    ...(first ? { fileName: first.title, pageCount: Math.max(1, fixturePages(root, first.fixture).length) } : {}),
  };
  const vars: PromptVariables = {};
  for (const name of promptPlaceholders(promptRef)) {
    const value = known[name];
    if (value === undefined) throw new Error(`The eval runner has no value for {{${name}}} in ${promptRef}`);
    vars[name] = value;
  }
  return vars;
}

/**
 * The case's visible documents as gateway documents: text with page offsets, or a PDF. Text sent
 * for classification is framed as ingestion frames it (AI-04): each page after a `--- Page N ---` line.
 */
export function caseDocuments(
  evalCase: EvalCase,
  root: string = EVALS_DIR,
  feature?: CaseRequest['feature'],
): GatewayDocument[] {
  return visibleContext(evalCase).documents.map((doc) => {
    const base = { documentId: doc.id, version: doc.version, title: doc.title };
    if (feature === 'classification') {
      const text = fixturePages(root, doc.fixture)
        .map((page, index) => `--- Page ${index + 1} ---\n${page}`)
        .join('\n');
      return { ...base, source: { kind: 'text', text } };
    }
    if (doc.fixture.endsWith('.pdf')) {
      const base64 = readFileSync(path.join(root, 'fixtures', doc.fixture)).toString('base64');
      return { ...base, source: { kind: 'pdf', base64 } };
    }
    const { text, offsets } = readTextFixture(root, doc.fixture);
    return { ...base, pageOffsets: offsets, source: { kind: 'text', text } };
  });
}

/** The reply's text blocks as cited or uncited runs (for citationCoverage). */
export function textSpans(content: readonly unknown[]): TextSpan[] {
  return content.flatMap((raw) => {
    const block = raw as { type?: string; text?: string; citations?: unknown[] | null };
    if (block.type !== 'text' || !block.text) return [];
    return [{ text: block.text, cited: (block.citations?.length ?? 0) > 0 }];
  });
}

function quotes(citations: readonly ClerkCitation[]): CitedQuote[] {
  return citations.map((c) => ({
    documentId: c.documentId,
    quote: c.quote,
    ...(c.page ? { page: c.page } : {}),
    ...(c.pageEnd ? { pageEnd: c.pageEnd } : {}),
  }));
}

/** One judge item per cited span: the claim, the quote and its page's text. */
export function judgeItems(
  content: readonly unknown[],
  citations: readonly ClerkCitation[],
  pages: ReadonlyMap<string, readonly string[]>,
): string[] {
  const items: string[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; text?: string; citations?: ModelCitation[] | null };
    if (block.type !== 'text' || !block.text || !block.citations?.length) continue;
    for (const cited of block.citations) {
      // The gateway stores the API's quote as `citedQuote` makes it (mapCitation), so compare the same way.
      const citedText = citedQuote(cited);
      const match = citations.find((c) => c.quote === citedText);
      if (!match) continue;
      const docPages = pages.get(match.documentId);
      const pageText = match.page
        ? docPages?.slice(match.page - 1, match.pageEnd ?? match.page).join('\n') || undefined
        : docPages?.join('\n');
      items.push(
        [
          `Item ${items.length}:`,
          `Claim: ${block.text.trim()}`,
          `Quote: ${match.quote}`,
          `Page text: ${(pageText ?? '(page not found)').slice(0, 4000)}`,
        ].join('\n'),
      );
    }
  }
  return items;
}

/** The chat panel's prompt (AI-06), any version: its cases run the way the panel does. */
export function isChatPrompt(promptRef: string): boolean {
  return promptRef.split('@')[0] === CHAT_PROMPT.split('@')[0];
}

/**
 * One chat case the way the panel answers a question (AI-06 `runChatMessage`, without Firestore or
 * streaming): production's `buildContext` (AI-03) decides what the role may see from the case as an
 * in-memory matter, and the model may call the panel's read-only tools over the same matter. So the
 * privilege and injection suites test production's filtering, not a copy of it. The drafting tools
 * (AI-06b) are offered as in production with suggestions on; their drafts are recorded, not saved.
 */
async function runChat(
  gateway: ClerkGateway,
  ctx: GatewayContext,
  evalCase: EvalCase,
  promptRef: string,
  root: string,
): Promise<{ result: ClerkRunResult; drafts: DraftedItem[] }> {
  const source = new MemoryContextSource(evalOrg(evalCase, ctx.orgId, ctx.uid));
  const chunks = evalChunkSearch(evalCase, root);
  const documentText = evalDocumentText(evalCase, root);
  const context = await createContextBuilder({
    source,
    chunks,
    documentText,
    tokens: charEstimateCounter,
  }).buildContext({
    ctx,
    scope: { matterId: EVAL_MATTER },
    feature: 'chat',
    attachments: evalAttachments(evalCase),
    query: evalCase.query,
  });
  const drafts: DraftedItem[] = [];
  const tools = createChatToolbox(
    { context: source, records: evalToolRecords(source, ctx.orgId), chunks, documentText },
    { orgId: ctx.orgId, matterId: EVAL_MATTER, role: context.manifest.role },
    {
      draft: async (draft) => {
        drafts.push({ kind: draft.kind, text: draftText(draft) });
        return { status: 'drafted', suggestionId: `eval-draft-${drafts.length}` };
      },
    },
  );
  const result = await gateway.run({
    ctx,
    feature: 'chat',
    promptId: promptRef,
    vars: { task: CHAT_TASKS.question, question: evalCase.query },
    context,
    tools,
  });
  return { result, drafts };
}

/**
 * One Insights narrative case (INS-04) the way `clerk-explainInsights` asks: the case's months as
 * the org's month rollups, production's metrics scope (`buildContext`) for the case's periods, and
 * the callable's prompt variables. The graders check the reply against the same figures.
 */
async function runInsights(
  gateway: ClerkGateway,
  ctx: GatewayContext,
  evalCase: EvalCase,
  promptRef: string,
  root: string,
): Promise<ClerkRunResult> {
  const insights = insightsCase(evalCase);
  if (!insights) throw new Error(`${evalCase.id}: an Insights narrative case needs an insights selection`);
  const metrics = Object.fromEntries(
    Object.entries(evalCase.metrics).map(([month, values]) => [`month-${month}`, { period: `month-${month}`, values }]),
  );
  const source = new MemoryContextSource({
    [ctx.orgId]: { members: { [ctx.uid]: { status: 'active', role: evalCase.role } }, matters: {}, metrics },
  });
  const context = await createContextBuilder({
    source,
    chunks: evalChunkSearch(evalCase, root),
    documentText: evalDocumentText(evalCase, root),
    tokens: charEstimateCounter,
  }).buildContext({
    ctx,
    scope: {
      org: 'metrics',
      current: narrativePeriodInfo(insights.current),
      comparison: insights.comparison ? narrativePeriodInfo(insights.comparison) : null,
    },
    feature: 'insightsNarrative',
  });
  return gateway.run({
    ctx,
    feature: 'insightsNarrative',
    promptId: promptRef,
    vars: narrativePromptVars(insights.current, insights.comparison),
    context,
  });
}

/**
 * One key-dates case (MIG-09) the way `extractMatterEvents` reads a migrated matter: production's
 * `buildContext` over the case as an in-memory matter (its date of death and grant recorded as
 * events, as matter creation records them), the prompt's `today`, and production's `toProposals`
 * checks on the reply. The graders score what a person would be offered.
 */
async function runEvents(
  gateway: ClerkGateway,
  ctx: GatewayContext,
  evalCase: EvalCase,
  promptRef: string,
  root: string,
): Promise<{ result: ClerkRunResult; proposed: ProposedEvent[] }> {
  const orgs = evalOrg(evalCase, ctx.orgId, ctx.uid);
  const matter = orgs[ctx.orgId]?.matters[EVAL_MATTER];
  if (!matter) throw new Error(`${evalCase.id}: no eval matter`);
  const facts = evalCase.matter as { dateOfDeath?: string; probate?: { granted?: string | null } };
  matter.events = {
    ...matter.events,
    ...(facts.dateOfDeath ? { 'e-death': { kind: 'date_of_death', date: facts.dateOfDeath } } : {}),
    ...(facts.probate?.granted ? { 'e-grant': { kind: 'grant_issued', date: facts.probate.granted } } : {}),
  };
  const documentText = evalDocumentText(evalCase, root);
  const context = await createContextBuilder({
    source: new MemoryContextSource(orgs),
    chunks: evalChunkSearch(evalCase, root),
    documentText,
    tokens: charEstimateCounter,
  }).buildContext({ ctx, scope: { matterId: EVAL_MATTER }, feature: 'eventsExtraction', query: EVENTS_QUERY });
  const result = await gateway.run({
    ctx,
    feature: 'eventsExtraction',
    promptId: promptRef,
    vars: { today: evalCase.today },
    context,
    output: EventsFromFileOutput,
  });
  const parsed = EventsFromFileOutput.safeParse(result.parsed);
  if (result.status !== 'done' || !parsed.success) return { result, proposed: [] };
  // toProposals reads only the cited notes from Firestore: serve them from the eval matter.
  const db = {
    doc: (ref: string) => ({ get: async () => ({ data: () => matter.notes?.[ref.split('/').at(-1) ?? ''] }) }),
  } as unknown as Firestore;
  const recorded = new Set(Object.values(matter.events).map((event) => String(event['kind'])));
  const proposals = await toProposals({ db, text: documentText }, ctx.orgId, EVAL_MATTER, parsed.data.events, {
    manifest: result.manifest ?? context.manifest,
    recorded,
    today: evalCase.today,
  });
  const proposed = proposals.map((proposal) => {
    const payload = proposal.payload as { kind: string; date: string; label?: string };
    return { kind: payload.kind, date: payload.date, ...(payload.label ? { label: payload.label } : {}) };
  });
  return { result, proposed };
}

/**
 * A matter brief case's records (AI-06c) as Firestore keeps them on the eval matter: documents
 * scanned clean, instants as Dates, the matter privileged when the case says so.
 */
export function briefMatter(evalCase: EvalCase, matter: MemoryMatter): MemoryMatter {
  const rows = evalCase.brief;
  if (!rows) throw new Error(`${evalCase.id}: a matter brief case needs its records (brief)`);
  const byId = <T extends { id: string }>(
    list: readonly T[],
    data: (row: Omit<T, 'id'>) => Record<string, unknown> = (row) => row,
  ) => Object.fromEntries(list.map(({ id, ...row }) => [id, data(row)]));
  return {
    ...matter,
    data: { ...matter.data, privileged: rows.matterPrivileged },
    deadlines: byId(rows.deadlines),
    tasks: byId(rows.tasks),
    activity: byId(rows.activity, ({ at, ...row }) => ({ ...row, at: new Date(at) })),
    documents: byId(rows.documents, ({ createdAt, ...row }) => ({
      ...row,
      createdAt: new Date(createdAt),
      scan: { status: 'clean' },
    })),
    suggestions: byId(rows.suggestions),
  };
}

/**
 * One matter brief case (AI-06c) the way `clerk-matterBrief` asks: production's `buildContext`
 * (the brief's facts from the case's records), the prompt's `today`, and production's `checkBrief`
 * on the reply. The graders score what would be shown.
 */
async function runMatterBrief(
  gateway: ClerkGateway,
  ctx: GatewayContext,
  evalCase: EvalCase,
  promptRef: string,
  root: string,
): Promise<{ result: ClerkRunResult; brief: { written: number; kept: number; refs: string[] } }> {
  const orgs = evalOrg(evalCase, ctx.orgId, ctx.uid);
  const org = orgs[ctx.orgId];
  const matter = org?.matters[EVAL_MATTER];
  if (!org || !matter) throw new Error(`${evalCase.id}: no eval matter`);
  org.matters[EVAL_MATTER] = briefMatter(evalCase, matter);
  const context = await createContextBuilder({
    source: new MemoryContextSource(orgs),
    chunks: evalChunkSearch(evalCase, root),
    documentText: evalDocumentText(evalCase, root),
    tokens: charEstimateCounter,
  }).buildContext({ ctx, scope: { matterId: EVAL_MATTER }, feature: 'matterBrief' });
  const facts = context.brief;
  if (!facts) throw new Error(`${evalCase.id}: the matter brief context has no facts`);
  const result = await gateway.run({
    ctx,
    feature: 'matterBrief',
    promptId: promptRef,
    vars: { today: facts.facts.today },
    context,
  });
  const parsed = result.parsed as { headline?: unknown; items?: unknown } | undefined;
  if (result.status !== 'done' || !parsed) return { result, brief: { written: 0, kept: 0, refs: [] } };
  const checked = checkBrief(parsed, facts);
  return {
    result,
    brief: {
      written: Array.isArray(parsed.items) ? parsed.items.length : 0,
      kept: checked.items.length,
      refs: [...new Set(checked.items.flatMap((item) => item.refs.map((ref) => briefRef(ref.kind, ref.id))))],
    },
  };
}

/** A draft as the graders read it: a note's text, or a task's title, due date and details. */
function draftText(draft: ChatDraft): string {
  if (draft.kind === 'note') return draft.payload.bodyMd;
  const { title, dueDate, descriptionMd } = draft.payload;
  return [title, dueDate, descriptionMd].filter(Boolean).join(' · ');
}

/**
 * The case executor on the real ClerkGateway (AI-12): the same prompt rendering, structured-output
 * validation, citation mapping and metering as production, with an in-memory store (no limits),
 * every flag on, the eval key, and the model under test forced on every request. Provider outages
 * become `EvalOutageError`; a read-only user's refusal by the gateway is scored as an empty answer.
 */
export function createEvalExecutor(options: EvalExecutorOptions): CaseExecutor {
  const root = options.root ?? EVALS_DIR;
  const now = options.now ?? Date.now;
  const keyring = evalKeyring(options.apiKey);
  const log = createLog({ fn: 'clerk-evals', requestId: 'eval', orgId: EVAL_ORG, uid: 'eval' }, () => undefined);

  function gatewayFor(citationText?: DocumentTextPort) {
    const results: ClerkModelResult[] = [];
    let lastError: ClerkModelError | undefined;
    const model: ClerkModelPort = {
      listModels: (key) => options.model.listModels(key),
      async run(request, onEvent) {
        try {
          const result = await options.model.run({ ...request, model: options.modelId }, onEvent);
          results.push(result);
          return result;
        } catch (error) {
          if (error instanceof ClerkModelError) lastError = error;
          throw error;
        }
      },
    };
    const store = new MemoryClerkStore();
    store.settings = {
      ...ACKNOWLEDGED_CLERK_SETTINGS,
      ...((CLERK_MODELS.choices as readonly string[]).includes(options.modelId)
        ? { model: options.modelId as (typeof CLERK_MODELS.choices)[number] }
        : {}),
      userRateLimit: { requests: 1_000_000, windowMinutes: 1 },
      monthlyTokenBudget: Number.MAX_SAFE_INTEGER,
    };
    const gateway = createClerkGateway({
      model,
      store,
      keyring,
      flag: async () => true,
      fallbackModels: [],
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(citationText ? { citationText } : {}),
    });
    return { gateway, results, lastError: () => lastError };
  }

  return async (request: CaseRequest): Promise<CaseOutcome> => {
    const { evalCase, promptRef } = request;
    const ctx = {
      orgId: EVAL_ORG,
      uid: `eval-${evalCase.role}`,
      role: evalCase.role,
      requestId: `${request.suite.suite}/${evalCase.id}#${request.run}`,
      log,
      clock: { now: () => new Date(now()) },
    };
    const chat = isChatPrompt(promptRef);
    const { gateway, results, lastError } = gatewayFor(chat ? evalDocumentText(evalCase, root) : undefined);
    const started = now();
    let result: ClerkRunResult;
    let drafts: DraftedItem[] | undefined;
    let proposedEvents: ProposedEvent[] | undefined;
    let brief: CaseOutcome['brief'];
    try {
      if (request.feature === 'matterBrief')
        ({ result, brief } = await runMatterBrief(
          gateway,
          { ...ctx, clock: { now: () => caseNow(evalCase) } },
          evalCase,
          promptRef,
          root,
        ));
      else if (request.feature === 'eventsExtraction')
        ({ result, proposed: proposedEvents } = await runEvents(
          gateway,
          { ...ctx, clock: { now: () => caseNow(evalCase) } },
          evalCase,
          promptRef,
          root,
        ));
      else if (request.feature === 'insightsNarrative')
        result = await runInsights(
          gateway,
          { ...ctx, clock: { now: () => caseNow(evalCase) } },
          evalCase,
          promptRef,
          root,
        );
      else if (chat)
        ({ result, drafts } = await runChat(
          gateway,
          { ...ctx, clock: { now: () => caseNow(evalCase) } },
          evalCase,
          promptRef,
          root,
        ));
      else
        result = await gateway.run({
          ctx,
          feature: FEATURES[request.feature],
          promptId: promptRef,
          vars: caseVariables(promptRef, evalCase, root),
          documents: caseDocuments(evalCase, root, request.feature),
        });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERMISSION_DENIED')
        return {
          status: 'denied',
          stopReason: 'denied',
          model: options.modelId,
          text: '',
          citations: [],
          spans: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costMicros: 0,
          latencyMs: now() - started,
        };
      const kind = lastError()?.kind;
      if (error instanceof DomainError && (error.code === 'CLERK_BUSY' || (kind && OUTAGE_KINDS.has(kind))))
        throw new EvalOutageError(kind ? `${error.code}:${kind}` : error.code);
      if (error instanceof DomainError)
        throw Object.assign(new Error(error.message), { code: kind ? `${error.code}:${kind}` : error.code });
      throw error;
    }
    const latencyMs = now() - started;
    const content = results.at(-1)?.content ?? [];
    const outcome: CaseOutcome = {
      status: result.status,
      stopReason: result.stopReason,
      model: result.model,
      text: result.text ?? '',
      ...(result.parsed !== undefined ? { parsed: result.parsed } : {}),
      citations: quotes(result.citations),
      spans: textSpans(content),
      usage: result.usage,
      costMicros: result.costMicros,
      latencyMs,
      ...(drafts ? { drafts } : {}),
      ...(proposedEvents ? { proposedEvents } : {}),
      ...(brief ? { brief } : {}),
    };

    if (options.judge && request.suite.citations === 'api' && result.citations.length) {
      const items = judgeItems(content, result.citations, sourcePages(root, evalCase));
      if (items.length) {
        const verdict = await gateway.run({
          ctx: { ...ctx, role: 'lawyer', requestId: `${ctx.requestId}/judge` },
          feature: 'evalJudge',
          promptId: 'eval-citation-judge',
          vars: { items: items.join('\n\n') },
        });
        const verdicts = (verdict.parsed as { verdicts?: { index: number; supported: boolean }[] } | undefined)
          ?.verdicts;
        if (verdicts)
          outcome.judge = {
            supported: verdicts.filter((v) => v.supported && v.index >= 0 && v.index < items.length).length,
            judged: items.length,
            costMicros: verdict.costMicros,
          };
      }
    }
    return outcome;
  };
}
