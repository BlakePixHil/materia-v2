import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CLERK_MODELS, getPrompt, type ClerkCitation, type PromptVariables } from '@materia/clerk';
import {
  EVALS_DIR,
  EvalOutageError,
  fixturePages,
  readTextFixture,
  sourcePages,
  type CaseExecutor,
  type CaseOutcome,
  type CaseRequest,
  type CitedQuote,
  type EvalCase,
  type TextSpan,
} from '@materia/clerk/evals';
import { DomainError, can } from '@materia/domain';

import { createLog } from '../../core/log';
import { ClerkModelError, type ClerkModelPort, type ClerkModelResult } from '../../ports';
import type { ClerkFeature } from '../features';
import { createClerkGateway, type ClerkRunResult, type GatewayDocument } from '../gateway';
import type { ClerkKeyring } from '../keyring';
import { MemoryClerkStore } from '../testing';

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
 * What the request may see. Roles without `privileged.view` get no privileged document or note,
 * the same filter the matter context applies in production (AI-03 replaces this with its own
 * context builder; the privilege suite then tests that one).
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
  return citations.map((c) => ({ documentId: c.documentId, quote: c.quote, ...(c.page ? { page: c.page } : {}) }));
}

/** One judge item per cited span: the claim, the quote and its page's text. */
export function judgeItems(
  content: readonly unknown[],
  citations: readonly ClerkCitation[],
  pages: ReadonlyMap<string, readonly string[]>,
): string[] {
  const items: string[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; text?: string; citations?: { cited_text?: string }[] | null };
    if (block.type !== 'text' || !block.text || !block.citations?.length) continue;
    for (const cited of block.citations) {
      const match = citations.find((c) => c.quote === cited.cited_text);
      if (!match) continue;
      const pageText = match.page
        ? pages.get(match.documentId)?.[match.page - 1]
        : pages.get(match.documentId)?.join('\n');
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

  function gatewayFor() {
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
    const { gateway, results, lastError } = gatewayFor();
    const started = now();
    let result: ClerkRunResult;
    try {
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
