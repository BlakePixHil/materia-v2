import { renderPrompt } from '@materia/clerk';
import {
  can,
  DEFAULT_ORG_TIMEZONE,
  DocIdSchema,
  DomainError,
  INSIGHTS_MAX_MONTHS,
  isMonthId,
  narrativeContextJson,
  narrativeFigures,
  toDisplay,
  today,
  type ContextManifest,
  type ContextTruncation,
  type DateOnly,
  type MatterBriefFactSet,
  type MetricValues,
  type NarrativeFigure,
  type NarrativePeriodInfo,
  type Role,
} from '@materia/domain';

import type { ClerkContentBlock } from '../../ports';
import type { ClerkFeature } from '../features';
import type { GatewayChunk, GatewayContext, GatewayDocument } from '../gateway';
import { readMatterBriefFacts } from './brief-facts';
import { matterFacts, isoOf, recordOf } from './facts';
import { escapeFraming, openTag, safeJson, truncateText, wrap } from './framing';
import {
  CONTEXT_POLICIES,
  FACT_LIMITS,
  MAX_ATTACHMENTS,
  RETRIEVAL_FETCH_K,
  RETRIEVAL_TOP_K,
  type ContextPolicy,
} from './policy';
import type { ChunkHit, ChunkSearchPort, ContextSource, DocumentTextPort, Row, TokenCounter } from './ports';

/**
 * The practice's figures for a period and what it is compared with (INS-04): org totals from the
 * month rollups, no client data. Only features whose policy lists `metrics` may ask for it.
 */
export interface MetricsScope {
  org: 'metrics';
  current: NarrativePeriodInfo;
  comparison: NarrativePeriodInfo | null;
}

/** One matter, or the practice's aggregated metrics. */
export type ContextScope = { matterId: string } | MetricsScope;

export interface BuildContextInput {
  ctx: GatewayContext;
  scope: ContextScope;
  feature: ClerkFeature;
  /** Document ids the person attached; each must belong to the scoped matter. */
  attachments?: readonly string[];
  /** The person's question: retrieval runs on it when present. */
  query?: string;
}

/**
 * What Clerk may see for one request (AI-03, ADR-034), laid out for the prompt cache: `system` (the
 * base system prompt) and `contextBlocks.stable` (the matter facts and recent notes, ending in a
 * cache breakpoint) first; then `documents` and `searchResults`; then `contextBlocks.volatile`
 * (what was left out and why); the gateway adds the feature prompt's question last.
 */
export interface ClerkContext {
  system: string;
  contextBlocks: { stable: ClerkContentBlock[]; volatile: ClerkContentBlock[] };
  documents: GatewayDocument[];
  searchResults: GatewayChunk[];
  manifest: ContextManifest;
  truncated: ContextTruncation | null;
  /** The metrics scope's figures, exactly as `<org_metrics>` gives them (for checking the reply). */
  figures?: NarrativeFigure[];
  /** The matter brief's facts (policy `facts: 'brief'`), for checking the reply (AI-06c). */
  brief?: MatterBriefFactSet;
}

export interface ContextDeps {
  source: ContextSource;
  chunks: ChunkSearchPort;
  documentText: DocumentTextPort;
  tokens: TokenCounter;
  /** Per-feature budgets and scopes (default `CONTEXT_POLICIES`). */
  policies?: Record<ClerkFeature, ContextPolicy>;
}

/** The base system prompt (`libs/clerk/prompts/system@*.md`); its version is pinned here. */
export const SYSTEM_PROMPT_REF = 'system@1.1.0';

/** Tokens kept back for the `<context_notice>` block, which is written after the budget is applied. */
const NOTICE_RESERVE_TOKENS = 120;

type Data = Record<string, unknown>;

const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;
const statusOf = (value: unknown) => (value as { status?: unknown } | undefined)?.status;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function notFound(what: 'Matter' | 'Document', id: string): DomainError {
  return new DomainError('NOT_FOUND', `${what} not found`, what === 'Matter' ? { matterId: id } : { docId: id });
}

function revoked(): DomainError {
  return new DomainError('ACCESS_REVOKED', 'Access changed while Clerk was preparing the request');
}

function invalidId(field: string, value: string): void {
  if (!DocIdSchema.safeParse(value).success)
    throw new DomainError('INVALID_ARGUMENT', 'Invalid id', { fields: { [field]: ['Invalid id'] } });
}

/** A document is readable by Clerk once it is scanned clean and its text is ingested. */
function readiness(data: Data): 'ready' | 'processing' | 'unreadable' {
  const ingest = statusOf(data['ingest']);
  if (statusOf(data['scan']) !== 'clean' || ingest === 'pending' || ingest === undefined) return 'processing';
  if (ingest !== 'done' || typeof data['version'] !== 'number' || data['version'] < 1) return 'unreadable';
  return 'ready';
}

/** "Monday 5 Oct 2026" for the system prompt. */
function todayLabel(iso: string): string {
  const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
  return `${weekday} ${toDisplay(iso as never)}`;
}

/** A document's pages as one text block, with the offset at which each page starts (for citations). */
function documentText(
  doc: Row,
  version: number,
  pages: readonly { page: number; text: string }[],
): { text: string; pageOffsets: number[] } {
  const byPage = new Map(pages.map((page) => [page.page, page.text]));
  const last = Math.max(...pages.map((page) => page.page));
  let text = `${openTag('document', { id: doc.id, version, name: String(doc.data['name'] ?? '') })}\n`;
  const pageOffsets: number[] = [];
  for (let page = 1; page <= last; page++) {
    pageOffsets.push(text.length);
    text += `${escapeFraming(byPage.get(page) ?? '')}\n\n`;
  }
  return { text: `${text.trimEnd()}\n</document>`, pageOffsets };
}

interface Candidate {
  kind: 'doc' | 'note' | 'chunk';
  tokens: number;
  keep: boolean;
}

/**
 * `buildContext` (AI-03): decides exactly what Clerk may see for a request. Scoping, privilege and
 * confidentiality are enforced here, in code, never by the prompt:
 * 1. the member is re-read (suspended, removed or lost Clerk: ACCESS_REVOKED) and the matter is
 *    checked against the permission matrix, as the rules would for that role;
 * 2. roles without `privileged.view` get no privileged documents, chunks or notes; anything
 *    privileged that is included makes the manifest (and so the reply) privileged;
 * 3. attachments must belong to the matter; documents still processing are left out and counted;
 * 4. retrieval runs only on the query, through the chunk search port, and never lists documents;
 * 5. the feature's token budget is applied by dropping the lowest-ranked material first.
 */
export function createContextBuilder(deps: ContextDeps) {
  const policies: Record<ClerkFeature, ContextPolicy> = deps.policies ?? CONTEXT_POLICIES;

  async function buildContext(input: BuildContextInput): Promise<ClerkContext> {
    const { ctx, feature } = input;
    const policy = policies[feature];
    const scopeKind = 'matterId' in input.scope ? 'matter' : 'metrics';
    if (!policy.scopes.includes(scopeKind))
      throw new DomainError('PERMISSION_DENIED', 'This Clerk feature cannot read that scope', {
        feature,
        scope: scopeKind,
      });
    const attachments = [...new Set(input.attachments ?? [])];
    attachments.forEach((id) => invalidId('attachments', id));
    if (attachments.length > MAX_ATTACHMENTS)
      throw new DomainError('INVALID_ARGUMENT', 'Too many attachments', { max: MAX_ATTACHMENTS });

    // 1. Who is asking, now: the claim was checked when the request arrived, the member is re-read.
    if (!can(ctx.role, 'clerk.use')) throw new DomainError('PERMISSION_DENIED', 'This role cannot use Clerk');
    const member = await deps.source.member(ctx.orgId, ctx.uid);
    if (!member || member.status !== 'active' || !can(member.role, 'clerk.use')) throw revoked();
    const role: Role = member.role;
    // Privileged material needs privileged.view in the request's role and the current one.
    const allowPrivileged = can(ctx.role, 'privileged.view') && can(role, 'privileged.view');

    const timeZone = (await deps.source.orgTimeZone(ctx.orgId)) ?? DEFAULT_ORG_TIMEZONE;
    const todayIso = today(timeZone, ctx.clock.now());
    const system = renderPrompt(SYSTEM_PROMPT_REF, {
      today: todayLabel(todayIso),
      todayIso,
      timeZone,
    }).system;

    if (scopeKind === 'metrics') {
      if (attachments.length)
        throw new DomainError('INVALID_ARGUMENT', 'The metrics scope takes no attachments', { scope: 'metrics' });
      return metricsContext(input, input.scope as MetricsScope, role, system);
    }

    const matterId = (input.scope as { matterId: string }).matterId;
    invalidId('matterId', matterId);

    // 2. The matter, through the permission matrix (as the rules would read it for this role).
    const matter = await deps.source.matter(ctx.orgId, matterId);
    const visibleTo = (r: Role) =>
      !!matter && !isDeleted(matter.data) && can(r, 'matter.view', { privileged: matter.data['privileged'] === true });
    if (!visibleTo(ctx.role)) throw notFound('Matter', matterId);
    if (!visibleTo(role)) throw revoked();
    const matterRow = matter as Row;
    const matterPrivileged = matterRow.data['privileged'] === true;
    if (policy.facts === 'brief')
      return briefContext(input, { matterId, matterPrivileged, role, system, todayIso, timeZone });

    const query = input.query?.trim() ?? '';
    // Trust balances (BILL-11) only for billing roles, in the request's role and the current one.
    const trustVisible = can(ctx.role, 'billing.view') && can(role, 'billing.view');
    // The responsible lawyer, by name, so Clerk can say who to ask (an inactive member is left out).
    const responsibleUid = matterRow.data['responsibleUid'];
    const [parties, events, deadlines, tasks, notes, attached, hits, trust, responsible] = await Promise.all([
      deps.source.parties(ctx.orgId, matterId),
      deps.source.events(ctx.orgId, matterId),
      deps.source.openDeadlines(ctx.orgId, matterId),
      deps.source.openTasks(ctx.orgId, matterId),
      deps.source.recentNotes(ctx.orgId, matterId, { allowPrivileged, limit: FACT_LIMITS.notes * 3 }),
      attachments.length ? deps.source.documents(ctx.orgId, matterId, attachments) : Promise.resolve([]),
      query
        ? deps.chunks.searchChunks({ orgId: ctx.orgId, matterId, query, k: RETRIEVAL_FETCH_K, allowPrivileged })
        : Promise.resolve([] as ChunkHit[]),
      trustVisible ? deps.source.trustSnapshot(ctx.orgId, matterId) : Promise.resolve(null),
      typeof responsibleUid === 'string' && responsibleUid
        ? deps.source.member(ctx.orgId, responsibleUid)
        : Promise.resolve(null),
    ]);

    // 3. Attachments: each must be a live document of this matter that the role may see.
    const attachedById = new Map(attached.map((row) => [row.id, row]));
    const notices: string[] = [];
    let processing = 0;
    let unreadable = 0;
    const ready: { row: Row; version: number }[] = [];
    for (const id of attachments) {
      const row = attachedById.get(id);
      const data = row?.data;
      if (
        !row ||
        !data ||
        isDeleted(data) ||
        (data['matterId'] !== undefined && data['matterId'] !== matterId) ||
        (data['orgId'] !== undefined && data['orgId'] !== ctx.orgId) ||
        (data['privileged'] === true && !allowPrivileged)
      )
        throw notFound('Document', id);
      const state = readiness(data);
      if (state === 'processing') processing++;
      else if (state === 'unreadable') unreadable++;
      else ready.push({ row, version: data['version'] as number });
    }
    const loaded = await Promise.all(
      ready.map(async ({ row, version }) => ({
        row,
        version,
        pages: await deps.documentText.pages({ orgId: ctx.orgId, matterId, documentId: row.id, version }),
      })),
    );
    const docs = loaded.filter((doc) => {
      if (doc.pages.length) return true;
      processing++; // ingested, but no text reachable yet
      return false;
    });

    // 4. Retrieval hits: privileged ones only when allowed, current versions of live, clean
    // documents of this matter, one per (document, page), closest first.
    const attachedIds = new Set(attachments);
    const candidates = hits.filter((hit) => (allowPrivileged || !hit.privileged) && !attachedIds.has(hit.documentId));
    const hitDocIds = [...new Set(candidates.map((hit) => hit.documentId))].filter(
      (id) => DocIdSchema.safeParse(id).success,
    );
    const hitDocs = new Map(
      (hitDocIds.length ? await deps.source.documents(ctx.orgId, matterId, hitDocIds) : []).map((row) => [row.id, row]),
    );
    const bestByPage = new Map<string, { hit: ChunkHit; doc: Row }>();
    for (const hit of candidates) {
      const doc = hitDocs.get(hit.documentId);
      const data = doc?.data;
      if (!doc || !data || isDeleted(data) || readiness(data) !== 'ready') continue;
      if (data['matterId'] !== undefined && data['matterId'] !== matterId) continue;
      if (data['privileged'] === true && !allowPrivileged) continue;
      if (data['version'] !== hit.version) continue;
      const key = `${hit.documentId}|${hit.page}`;
      const best = bestByPage.get(key);
      if (!best || hit.distance < best.hit.distance) bestByPage.set(key, { hit, doc });
    }
    const chunks = [...bestByPage.values()].sort((a, b) => a.hit.distance - b.hit.distance).slice(0, RETRIEVAL_TOP_K);

    // 5. Notes: live, never privileged without privileged.view, newest first, long ones cut.
    const noteRows = notes
      .filter((row) => !isDeleted(row.data) && (allowPrivileged || row.data['privileged'] !== true))
      .slice(0, FACT_LIMITS.notes);
    const noteCut = noteRows.map(() => false);
    const noteTexts = noteRows.map((row, i) => {
      const body = truncateText(String(row.data['bodyMd'] ?? ''), FACT_LIMITS.noteChars);
      noteCut[i] = body.truncated;
      return wrap('matter_note', escapeFraming(body.text), {
        id: row.id,
        written: isoOf(row.data['createdAt'])?.slice(0, 10),
        privileged: row.data['privileged'] === true ? true : undefined,
      });
    });

    const contactIds = new Set<string>();
    for (const row of parties) if (typeof row.data['contactId'] === 'string') contactIds.add(row.data['contactId']);
    for (const id of (matterRow.data['clientContactIds'] as unknown[] | undefined) ?? [])
      if (typeof id === 'string') contactIds.add(id);
    for (const key of ['deceased', 'testator']) {
      const id = (matterRow.data[key] as { contactId?: unknown } | undefined)?.contactId;
      if (typeof id === 'string') contactIds.add(id);
    }
    const names = await deps.source.contactNames(ctx.orgId, [...contactIds]);
    const facts = matterFacts({
      matter: matterRow,
      parties,
      contactNames: names,
      events,
      deadlines,
      tasks,
      trust: trust ? { ...trust, today: todayIso } : null,
      responsible:
        responsible?.status === 'active' && responsible.displayName
          ? { name: responsible.displayName, title: responsible.title }
          : null,
    });
    const factsText = wrap('matter_facts', safeJson(facts.json), { matter: matterId });

    const documents: GatewayDocument[] = docs.map(({ row, version, pages }) => {
      const { text, pageOffsets } = documentText(row, version, pages);
      return {
        documentId: row.id,
        version,
        title: String(row.data['name'] ?? 'Untitled document'),
        pageOffsets,
        source: { kind: 'text', text },
      };
    });
    const searchResults: GatewayChunk[] = chunks.map(({ hit, doc }) => ({
      documentId: hit.documentId,
      version: hit.version,
      page: hit.page,
      title: String(doc.data['name'] ?? 'Untitled document'),
      source: `materia:document/${hit.documentId}/v${hit.version}/page/${hit.page}`,
      text: wrap('excerpt', escapeFraming(hit.text), {
        document: hit.documentId,
        version: hit.version,
        page: hit.page,
      }),
    }));

    // 6. The budget: the system prompt, facts and query are fixed; attachments, notes and excerpts
    // are ranked (attachments first, then notes newest first, then excerpts closest first) and the
    // lowest-ranked go first until the rest fits.
    const counted = await deps.tokens.count([
      system,
      factsText,
      query,
      ...documents.map((doc) => (doc.source.kind === 'text' ? doc.source.text : '')),
      ...noteTexts,
      ...searchResults.map((chunk) => chunk.text),
    ]);
    const [systemTokens = 0, factsTokens = 0, queryTokens = 0] = counted;
    let offset = 3;
    const ranked: Candidate[] = [
      ...documents.map(() => ({ kind: 'doc' as const, tokens: counted[offset++] ?? 0, keep: true })),
      ...noteTexts.map(() => ({ kind: 'note' as const, tokens: counted[offset++] ?? 0, keep: true })),
      ...searchResults.map(() => ({ kind: 'chunk' as const, tokens: counted[offset++] ?? 0, keep: true })),
    ];
    let used =
      systemTokens + factsTokens + queryTokens + NOTICE_RESERVE_TOKENS + ranked.reduce((n, c) => n + c.tokens, 0);
    // Drop order: excerpts (farthest first), then notes (oldest first), then attachments (last first).
    const dropOrder = [
      ...ranked.filter((c) => c.kind === 'chunk').reverse(),
      ...ranked.filter((c) => c.kind === 'note').reverse(),
      ...ranked.filter((c) => c.kind === 'doc').reverse(),
    ];
    for (const candidate of dropOrder) {
      if (used <= policy.budgetTokens) break;
      candidate.keep = false;
      used -= candidate.tokens;
    }
    const kept = (kind: Candidate['kind']) => ranked.filter((c) => c.kind === kind).map((c) => c.keep);
    const keepDocs = kept('doc');
    const keepNotes = kept('note');
    const keepChunks = kept('chunk');
    const finalDocs = documents.filter((_, i) => keepDocs[i]);
    const finalNotes = noteTexts.filter((_, i) => keepNotes[i]);
    const finalNoteRows = noteRows.filter((_, i) => keepNotes[i]);
    const finalChunks = searchResults.filter((_, i) => keepChunks[i]);
    const finalHits = chunks.filter((_, i) => keepChunks[i]);
    const dropped = {
      droppedDocs: keepDocs.filter((keep) => !keep).length,
      droppedChunks: keepChunks.filter((keep) => !keep).length,
      droppedNotes: keepNotes.filter((keep) => !keep).length,
    };
    const truncated = dropped.droppedDocs || dropped.droppedChunks || dropped.droppedNotes ? dropped : null;

    // 7. What the model is told about the context itself (rule 5: say when material is missing).
    if (processing) notices.push(`${plural(processing, 'document')} still processing and not included.`);
    if (unreadable) notices.push(`${plural(unreadable, 'attached document')} could not be read and are not included.`);
    if (truncated) {
      const parts = [
        dropped.droppedDocs ? plural(dropped.droppedDocs, 'attached document') : '',
        dropped.droppedNotes ? plural(dropped.droppedNotes, 'note') : '',
        dropped.droppedChunks ? plural(dropped.droppedChunks, 'excerpt') : '',
      ].filter(Boolean);
      notices.push(`Context truncated to fit: ${parts.join(', ')} left out.`);
    }
    const cutNotes = noteCut.filter((cut, i) => cut && keepNotes[i]).length;
    if (cutNotes) notices.push(`${plural(cutNotes, 'long note')} cut short (marked "[… truncated]").`);
    if (query && !finalChunks.length && !finalDocs.length) notices.push('No document excerpts matched the question.');

    const includedNotePrivileged = finalNoteRows.some((row) => row.data['privileged'] === true);
    const includedDocPrivileged = docs.some(({ row }, i) => keepDocs[i] && row.data['privileged'] === true);
    const includedChunkPrivileged = finalHits.some(({ hit, doc }) => hit.privileged || doc.data['privileged'] === true);
    const privileged = matterPrivileged || includedNotePrivileged || includedDocPrivileged || includedChunkPrivileged;

    const stableText = [factsText, ...finalNotes].join('\n\n');
    const manifest: ContextManifest = {
      scope: { kind: 'matter', matterId },
      feature,
      role,
      privileged,
      records: [...facts.records, ...finalNoteRows.map((row) => recordOf('note', row))],
      documents: finalDocs.map((doc) => ({ documentId: doc.documentId, version: doc.version })),
      chunks: finalChunks.map((chunk) => ({
        documentId: chunk.documentId,
        version: chunk.version,
        page: chunk.page as number,
      })),
      processing,
      notices,
      truncated,
      tokens: { used, budget: policy.budgetTokens, exact: deps.tokens.exact },
    };

    ctx.log.info('clerk context', {
      feature,
      scope: 'matter',
      matterId,
      documents: finalDocs.length,
      chunks: finalChunks.length,
      notes: finalNotes.length,
      processing,
      privileged,
      tokens: used,
      budget: policy.budgetTokens,
      ...(truncated ?? {}),
    });

    return {
      system,
      contextBlocks: {
        stable: [{ type: 'text', text: stableText, cache: true }],
        volatile: notices.length ? [{ type: 'text', text: wrap('context_notice', notices.join('\n')) }] : [],
      },
      documents: finalDocs,
      searchResults: finalChunks,
      manifest,
      truncated,
    };
  }

  /**
   * The matter brief's facts (AI-06c): deadlines, tasks, the feed's lines, the names and categories
   * of documents added and the open suggestions, as `matterBriefFacts` writes them, inside
   * `<matter_facts kind="brief">`. No notes, document text or retrieval. The facts are the ones
   * every reader of the matter may see (the brief is shared), so privileged records are in them
   * only on a privileged matter, which only privileged.view roles reach (checked above).
   */
  async function briefContext(
    input: BuildContextInput,
    at: {
      matterId: string;
      matterPrivileged: boolean;
      role: Role;
      system: string;
      todayIso: DateOnly;
      timeZone: string;
    },
  ): Promise<ClerkContext> {
    const { ctx, feature } = input;
    if (input.attachments?.length)
      throw new DomainError('INVALID_ARGUMENT', 'The matter brief takes no attachments', { feature });
    const brief = await readMatterBriefFacts(deps.source, {
      orgId: ctx.orgId,
      matterId: at.matterId,
      matterPrivileged: at.matterPrivileged,
      today: at.todayIso,
      now: ctx.clock.now(),
      timeZone: at.timeZone,
    });
    const text = wrap('matter_facts', safeJson(brief.facts), { matter: at.matterId, kind: 'brief' });
    const [used = 0] = await deps.tokens.count([at.system + text]);
    const manifest: ContextManifest = {
      scope: { kind: 'matter', matterId: at.matterId },
      feature,
      role: at.role,
      privileged: at.matterPrivileged,
      records: [...brief.refs.values()].map((info) => ({ kind: info.kind, id: info.id })),
      documents: [],
      chunks: [],
      processing: 0,
      notices: [],
      truncated: null,
      tokens: { used, budget: policies[feature].budgetTokens, exact: deps.tokens.exact },
    };
    ctx.log.info('clerk context', {
      feature,
      scope: 'matter',
      matterId: at.matterId,
      facts: 'brief',
      records: manifest.records.length,
      privileged: at.matterPrivileged,
      tokens: used,
      budget: policies[feature].budgetTokens,
    });
    return {
      system: at.system,
      contextBlocks: { stable: [{ type: 'text', text, cache: true }], volatile: [] },
      documents: [],
      searchResults: [],
      manifest,
      truncated: null,
      brief,
    };
  }

  /**
   * The metrics scope (INS-04): the figures for two periods, worked out from the month rollups with
   * their shards (`narrativeFigures`): org totals only, never a member's figures, a referrer, a
   * matter or a client, and no documents, notes or retrieval. Every member reads the rollups
   * (INS-01's rules), so `clerk.use` (checked above for both roles) is the only gate.
   */
  async function metricsContext(
    input: BuildContextInput,
    scope: MetricsScope,
    role: Role,
    system: string,
  ): Promise<ClerkContext> {
    const { ctx, feature } = input;
    const periods = [scope.current, ...(scope.comparison ? [scope.comparison] : [])];
    if (
      !scope.current.months.length ||
      periods.some((period) => period.months.length > INSIGHTS_MAX_MONTHS || !period.months.every(isMonthId))
    )
      throw new DomainError('INVALID_ARGUMENT', 'Invalid metrics periods', { scope: 'metrics' });
    const months = [...new Set(periods.flatMap((period) => period.months))];
    const rows = await deps.source.metricMonths(ctx.orgId, months);
    const values = new Map<string, MetricValues>();
    for (const row of rows) {
      const numbers: MetricValues = {};
      for (const [key, value] of Object.entries((row.data['values'] as Data | undefined) ?? {}))
        if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
      values.set(row.id.replace(/^month-/, ''), numbers);
    }
    const figures = narrativeFigures({
      current: scope.current.months,
      comparison: scope.comparison?.months ?? null,
      values,
    });
    const text = wrap(
      'org_metrics',
      safeJson(narrativeContextJson({ current: scope.current, comparison: scope.comparison, figures })),
    );
    const [used = 0] = await deps.tokens.count([system + text + (input.query ?? '')]);
    const manifest: ContextManifest = {
      scope: { kind: 'metrics' },
      feature,
      role,
      privileged: false,
      records: rows.map((row) => recordOf('metrics', row)),
      documents: [],
      chunks: [],
      processing: 0,
      notices: [],
      truncated: null,
      tokens: { used, budget: policies[feature].budgetTokens, exact: deps.tokens.exact },
    };
    ctx.log.info('clerk context', {
      feature,
      scope: 'metrics',
      months: months.length,
      periods: rows.length,
      figures: figures.length,
      tokens: used,
    });
    return {
      system,
      contextBlocks: { stable: [{ type: 'text', text, cache: true }], volatile: [] },
      documents: [],
      searchResults: [],
      manifest,
      truncated: null,
      figures,
    };
  }

  return { buildContext };
}

export type ContextBuilder = ReturnType<typeof createContextBuilder>;
