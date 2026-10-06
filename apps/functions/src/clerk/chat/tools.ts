import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  can,
  CLERK_CHAT_DRAFT_TOOLS,
  CLERK_CHAT_TOOLS,
  DateOnlySchema,
  DeadlineStatusSchema,
  DocIdSchema,
  PrioritySchema,
  TASK_TITLE_MAX,
  TaskStatusSchema,
  type ClerkChatDraftTool,
  type ClerkChatTool,
  type ContextManifest,
  type Role,
} from '@materia/domain';

import type { ClerkToolDefinition, ClerkToolUse } from '../../ports';
import { compact } from '../context/facts';
import { escapeFraming, safeJson, wrap } from '../context/framing';
import type { ChunkSearchPort, ContextSource, DocumentTextPort, Row } from '../context/ports';
import type { ClerkToolbox, ClerkToolOutput, GatewayChunk } from '../gateway';

type Data = Record<string, unknown>;

/** Passages `search_documents` returns. */
export const SEARCH_TOOL_K = 8;
/** Pages `get_document_text` reads per call. */
export const DOCUMENT_TEXT_MAX_PAGES = 10;
/** Records a list tool returns. */
export const TOOL_RECORDS_MAX = 50;

/** The reads the chat tools make beyond `buildContext`'s (AI-06), all under one org and matter. */
export interface ChatToolSource {
  /** A matter's deadlines or tasks, optionally only those in `statuses` (capped). */
  records(
    orgId: string,
    matterId: string,
    collection: 'deadlines' | 'tasks',
    statuses?: readonly string[],
  ): Promise<Row[]>;
  /** A matter's time entries dated within the range (inclusive), capped. */
  timeEntries(
    orgId: string,
    matterId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<Row[]>;
}

export interface ChatToolDeps {
  context: ContextSource;
  records: ChatToolSource;
  chunks: ChunkSearchPort;
  documentText: DocumentTextPort;
}

/** Who is asking and about what: tools never reach past this matter (Clerk rule 4). */
export interface ChatToolScope {
  orgId: string;
  matterId: string;
  /** The role the context was built for (`manifest.role`, re-read at build time). */
  role: Role;
}

const OPEN_DEADLINES = ['upcoming', 'blocked'];
const OPEN_TASKS = ['todo', 'in_progress', 'blocked'];

const INPUTS = {
  search_documents: z.object({ query: z.string().min(1).max(500).describe('What to look for in the documents') }),
  get_deadlines: z.object({
    status: z
      .enum(['open', ...DeadlineStatusSchema.options])
      .optional()
      .describe('Only deadlines with this status; `open` (the default) is upcoming and blocked'),
  }),
  get_tasks: z.object({
    status: z
      .enum(['open', ...TaskStatusSchema.options])
      .optional()
      .describe('Only tasks with this status; `open` (the default) is to do, in progress and blocked'),
  }),
  get_parties: z.object({}),
  get_time_summary: z.object({
    from: DateOnlySchema.optional().describe('First day, YYYY-MM-DD (inclusive)'),
    to: DateOnlySchema.optional().describe('Last day, YYYY-MM-DD (inclusive)'),
  }),
  get_document_text: z.object({
    documentId: DocIdSchema.describe('The document id, from an excerpt or an attachment'),
    pages: z.array(z.number().int().min(1)).min(1).max(DOCUMENT_TEXT_MAX_PAGES).describe('Page numbers to read'),
  }),
} satisfies Record<ClerkChatTool, z.ZodType>;

const DESCRIPTIONS: Record<ClerkChatTool, string> = {
  search_documents: 'Search this matter’s documents for passages that match a query. Returns citable passages.',
  get_deadlines: 'This matter’s deadlines: title, due date, status, kind and the rule they come from.',
  get_tasks: 'This matter’s tasks: title, status, priority and due date.',
  get_parties: 'The people and organisations on this matter, with their roles.',
  get_time_summary: 'Time recorded on this matter over a period: total, billable and by status, in minutes.',
  get_document_text: 'The text of some pages of one of this matter’s documents. Returns citable pages.',
};

/** The chat tools as the model sees them (JSON Schema inputs). */
export const CHAT_TOOL_DEFINITIONS: ClerkToolDefinition[] = CLERK_CHAT_TOOLS.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  // Input mode: what the model writes (a date is a plain YYYY-MM-DD string before parsing).
  inputSchema: z.toJSONSchema(INPUTS[name], { io: 'input' }) as Record<string, unknown>,
}));

/** Drafts one answer may make (AI-06b): the prompt allows three. */
export const DRAFTS_PER_ANSWER_MAX = 3;
/** A drafted note's length: a file note, not a document. */
export const DRAFT_NOTE_MAX = 10_000;

const DRAFT_INPUTS = {
  draft_note: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(DRAFT_NOTE_MAX)
      .describe('The note, in the person’s own words, tidied (Markdown allowed)'),
    pinned: z.boolean().optional().describe('Pin the note to the top of the matter’s notes, only when asked'),
  }),
  draft_task: z.object({
    title: z.string().trim().min(1).max(TASK_TITLE_MAX).describe('What to do, in the person’s words'),
    dueDate: DateOnlySchema.optional().describe('When it is due, YYYY-MM-DD, only when the person said'),
    details: z.string().trim().max(DRAFT_NOTE_MAX).optional().describe('Anything else the person said about it'),
    priority: PrioritySchema.optional().describe('Only when the person said how urgent it is'),
  }),
} satisfies Record<ClerkChatDraftTool, z.ZodType>;

const DRAFT_DESCRIPTIONS: Record<ClerkChatDraftTool, string> = {
  draft_note:
    'Draft a file note on this matter, when the person asks you to record one. The person confirms it below your answer; nothing is saved until they do.',
  draft_task:
    'Draft a task on this matter, when the person asks you to add one. The person confirms it below your answer; nothing is saved until they do.',
};

/** The drafting tools as the model sees them, offered only when drafting is on. */
export const CHAT_DRAFT_TOOL_DEFINITIONS: ClerkToolDefinition[] = CLERK_CHAT_DRAFT_TOOLS.map((name) => ({
  name,
  description: DRAFT_DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(DRAFT_INPUTS[name], { io: 'input' }) as Record<string, unknown>,
}));

/** What a drafting tool asks for: one AI-07 suggestion on the open matter. */
export type ChatDraft =
  | { kind: 'note'; payload: { bodyMd: string; pinned: boolean } }
  | {
      kind: 'task';
      payload: { title: string; dueDate?: string; descriptionMd?: string; priority?: z.infer<typeof PrioritySchema> };
    };

/** What became of a draft (`proposeSuggestions`'s outcome, AI-07). */
export type ChatDraftOutcome =
  | { status: 'drafted'; suggestionId: string }
  | { status: 'duplicate' | 'exists' | 'disabled' | 'matter_unavailable' | 'invalid' | 'not_allowed' };

/** Creates the suggestion for a draft: `runChatMessage` passes one when drafting is on. */
export type ChatDrafter = (draft: ChatDraft) => Promise<ChatDraftOutcome>;

/** What Clerk is told for each outcome, so its answer says what really happened. */
const DRAFT_RESULTS: Record<Exclude<ChatDraftOutcome['status'], 'drafted'>, string> = {
  duplicate: 'The same draft already exists for this question, so it wasn’t drafted again.',
  exists: 'This matter already has that task, so it wasn’t drafted.',
  disabled: 'Clerk suggestions are switched off for this practice, so nothing could be drafted.',
  matter_unavailable: 'This matter is closed or archived, so nothing can be added to it.',
  invalid: 'That draft isn’t valid, so it wasn’t drafted.',
  not_allowed: 'The person’s role can’t add this on this matter, so it wasn’t drafted.',
};

const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const statusOf = (value: unknown) => (value as { status?: unknown } | undefined)?.status;

/** A document Clerk may read: live, of this matter, scanned clean, ingested, and visible to the role. */
function readable(row: Row | undefined, scope: ChatToolScope, allowPrivileged: boolean): row is Row {
  const data = row?.data;
  return (
    !!data &&
    !isDeleted(data) &&
    (data['matterId'] === undefined || data['matterId'] === scope.matterId) &&
    (data['privileged'] !== true || allowPrivileged) &&
    statusOf(data['scan']) === 'clean' &&
    statusOf(data['ingest']) === 'done' &&
    typeof data['version'] === 'number'
  );
}

function passage(row: Row, version: number, page: number, text: string): GatewayChunk {
  return {
    documentId: row.id,
    version,
    page,
    title: String(row.data['name'] ?? 'Untitled document'),
    source: `materia:document/${row.id}/v${version}/page/${page}`,
    text: wrap('excerpt', escapeFraming(text), { document: row.id, version, page }),
  };
}

const records = (tool: ClerkChatTool, value: unknown): ClerkToolOutput => ({
  text: wrap('matter_facts', safeJson(compact(value)), { tool }),
});

/** What the tools showed Clerk, merged into the message's manifest after the answer (AI-03 audit). */
export interface ToolUsage {
  privileged: boolean;
  chunks: ContextManifest['chunks'];
  records: ContextManifest['records'];
  /** Whether Clerk used a drafting tool (AI-06b), whatever became of the draft. */
  drafting: boolean;
  /** Suggestions the drafting tools created, in order: linked from the answer. */
  drafted: string[];
}

/**
 * The chat panel's tools (AI-06): each reads only the scoped matter, under the caller's org, with
 * the same privilege rules as `buildContext` (privileged documents and passages only for a role
 * with `privileged.view`, checked in code again after the query). The read tools never write.
 * `usage` collects what the tools showed, for the message's manifest; `onPrivileged` fires the
 * first time a tool returns privileged material, so the answer is marked before it is written.
 *
 * With `draft`, the drafting tools (AI-06b) are offered too: each turns the person's request into
 * one AI-07 suggestion through `draft` (at most three per answer), never a record, and tells Clerk
 * what became of it.
 */
export function createChatToolbox(
  deps: ChatToolDeps,
  scope: ChatToolScope,
  events: { onPrivileged?: () => Promise<void>; draft?: ChatDrafter } = {},
): ClerkToolbox & { usage: ToolUsage } {
  const { orgId, matterId } = scope;
  const allowPrivileged = can(scope.role, 'privileged.view');
  const usage: ToolUsage = { privileged: false, chunks: [], records: [], drafting: false, drafted: [] };
  let drafts = 0;
  const seen = new Set<string>();
  const note = async (chunk: GatewayChunk, privileged: boolean) => {
    if (privileged && !usage.privileged) {
      usage.privileged = true;
      await events.onPrivileged?.();
    }
    const key = `${chunk.documentId}|${chunk.version}|${chunk.page}`;
    if (seen.has(key)) return;
    seen.add(key);
    usage.chunks.push({ documentId: chunk.documentId, version: chunk.version, page: chunk.page as number });
  };
  const noteRecords = (kind: 'deadline' | 'task' | 'party', rows: readonly Row[]) => {
    for (const row of rows) usage.records.push({ kind, id: row.id });
  };

  const handlers: { [K in ClerkChatTool]: (input: z.output<(typeof INPUTS)[K]>) => Promise<ClerkToolOutput> } = {
    async search_documents({ query }) {
      const hits = await deps.chunks.searchChunks({ orgId, matterId, query, k: SEARCH_TOOL_K * 2, allowPrivileged });
      const candidates = hits.filter((hit) => allowPrivileged || !hit.privileged);
      const ids = [...new Set(candidates.map((hit) => hit.documentId))].filter(
        (id) => DocIdSchema.safeParse(id).success,
      );
      const docs = new Map(
        (ids.length ? await deps.context.documents(orgId, matterId, ids) : []).map((r) => [r.id, r]),
      );
      const best = new Map<string, { chunk: GatewayChunk; privileged: boolean; distance: number }>();
      for (const hit of candidates) {
        const row = docs.get(hit.documentId);
        if (!readable(row, scope, allowPrivileged) || row.data['version'] !== hit.version) continue;
        const key = `${hit.documentId}|${hit.page}`;
        const current = best.get(key);
        if (current && current.distance <= hit.distance) continue;
        best.set(key, {
          chunk: passage(row, hit.version, hit.page, hit.text),
          privileged: hit.privileged || row.data['privileged'] === true,
          distance: hit.distance,
        });
      }
      const passages = [...best.values()].sort((a, b) => a.distance - b.distance).slice(0, SEARCH_TOOL_K);
      for (const hit of passages) await note(hit.chunk, hit.privileged);
      if (!passages.length) return { text: 'No passages in this matter’s documents matched.' };
      return { passages: passages.map((hit) => hit.chunk) };
    },

    async get_document_text({ documentId, pages }) {
      const [row] = await deps.context.documents(orgId, matterId, [documentId]);
      if (!readable(row, scope, allowPrivileged))
        return { text: 'That document isn’t available to Clerk on this matter.', isError: true };
      const version = row.data['version'] as number;
      const all = await deps.documentText.pages({ orgId, matterId, documentId, version });
      const wanted = new Set(pages);
      const found = all.filter((page) => wanted.has(page.page)).sort((a, b) => a.page - b.page);
      if (!found.length) return { text: `No text for those pages (the document has ${all.length} page(s) of text).` };
      const passages = found.map((page) => passage(row, version, page.page, page.text));
      for (const chunk of passages) await note(chunk, row.data['privileged'] === true);
      return { passages };
    },

    async get_deadlines({ status }) {
      const statuses = !status || status === 'open' ? OPEN_DEADLINES : [status];
      const rows = (await deps.records.records(orgId, matterId, 'deadlines', statuses))
        .filter((row) => !isDeleted(row.data))
        .sort((a, b) => String(a.data['dueDate'] ?? '').localeCompare(String(b.data['dueDate'] ?? '')))
        .slice(0, TOOL_RECORDS_MAX);
      noteRecords('deadline', rows);
      return records(
        'get_deadlines',
        rows.map((row) => ({
          id: row.id,
          title: str(row.data['title']),
          dueDate: str(row.data['dueDate']),
          status: str(row.data['status']),
          kind: str(row.data['kind']),
          critical: row.data['critical'] === true ? true : undefined,
          rule: str((row.data['computed'] as Data | undefined)?.['citation']),
        })),
      );
    },

    async get_tasks({ status }) {
      const statuses = !status || status === 'open' ? OPEN_TASKS : [status];
      const rows = (await deps.records.records(orgId, matterId, 'tasks', statuses))
        .filter((row) => !isDeleted(row.data))
        .sort((a, b) => String(a.data['dueDate'] ?? '9999').localeCompare(String(b.data['dueDate'] ?? '9999')))
        .slice(0, TOOL_RECORDS_MAX);
      noteRecords('task', rows);
      return records(
        'get_tasks',
        rows.map((row) => ({
          id: row.id,
          title: str(row.data['title']),
          status: str(row.data['status']),
          priority: str(row.data['priority']),
          dueDate: str(row.data['dueDate']),
          group: str(row.data['group']),
        })),
      );
    },

    async get_parties() {
      const rows = (await deps.context.parties(orgId, matterId)).filter((row) => !isDeleted(row.data));
      const ids = [...new Set(rows.map((row) => row.data['contactId']).filter((id): id is string => !!str(id)))];
      const names = await deps.context.contactNames(orgId, ids);
      noteRecords('party', rows);
      return records(
        'get_parties',
        rows.slice(0, TOOL_RECORDS_MAX).map((row) => ({
          id: row.id,
          name: names.get(String(row.data['contactId'])) ?? 'Unknown contact',
          role: str(row.data['role']),
          share: str(row.data['share']),
        })),
      );
    },

    async get_time_summary({ from, to }) {
      const rows = (await deps.records.timeEntries(orgId, matterId, { from, to })).filter(
        (row) =>
          !isDeleted(row.data) &&
          (!from || String(row.data['date']) >= from) &&
          (!to || String(row.data['date']) <= to),
      );
      const minutes = (list: readonly Row[]) =>
        list.reduce((sum, row) => sum + (typeof row.data['minutes'] === 'number' ? row.data['minutes'] : 0), 0);
      const byStatus: Record<string, number> = {};
      for (const row of rows) {
        const key = String(row.data['status'] ?? 'unknown');
        byStatus[key] = (byStatus[key] ?? 0) + minutes([row]);
      }
      // Amounts are billing information: only for roles that may see billing.
      const amount = can(scope.role, 'billing.view')
        ? rows.reduce(
            (sum, row) => sum + (typeof row.data['amountCents'] === 'number' ? row.data['amountCents'] : 0),
            0,
          )
        : undefined;
      return records('get_time_summary', {
        from,
        to,
        entries: rows.length,
        totalMinutes: minutes(rows),
        billableMinutes: minutes(rows.filter((row) => row.data['billable'] === true)),
        minutesByStatus: byStatus,
        amountCents: amount,
      });
    },
  };

  const draft = async (request: ChatDraft): Promise<ClerkToolOutput> => {
    if (!events.draft) return { text: 'Drafting isn’t available.', isError: true };
    usage.drafting = true;
    if (drafts >= DRAFTS_PER_ANSWER_MAX)
      return { text: `At most ${DRAFTS_PER_ANSWER_MAX} drafts per answer: this one wasn’t drafted.`, isError: true };
    drafts += 1;
    const outcome = await events.draft(request);
    if (outcome.status !== 'drafted') return { text: DRAFT_RESULTS[outcome.status], isError: true };
    usage.drafted.push(outcome.suggestionId);
    return {
      text: 'Drafted. It is waiting below your answer for the person to confirm; nothing is saved until they do.',
    };
  };

  const drafting: {
    [K in ClerkChatDraftTool]: (input: z.output<(typeof DRAFT_INPUTS)[K]>) => Promise<ClerkToolOutput>;
  } = {
    draft_note: ({ text, pinned }) => draft({ kind: 'note', payload: { bodyMd: text, pinned: pinned ?? false } }),
    draft_task: ({ title, dueDate, details, priority }) =>
      draft({
        kind: 'task',
        payload: {
          title,
          ...(dueDate ? { dueDate } : {}),
          ...(details ? { descriptionMd: details } : {}),
          ...(priority ? { priority } : {}),
        },
      }),
  };

  return {
    definitions: events.draft ? [...CHAT_TOOL_DEFINITIONS, ...CHAT_DRAFT_TOOL_DEFINITIONS] : CHAT_TOOL_DEFINITIONS,
    usage,
    async run(use: ClerkToolUse): Promise<ClerkToolOutput> {
      if (events.draft && (CLERK_CHAT_DRAFT_TOOLS as readonly string[]).includes(use.name)) {
        const name = use.name as ClerkChatDraftTool;
        const input = DRAFT_INPUTS[name].safeParse(use.input ?? {});
        if (!input.success) return { text: `Invalid input: ${z.prettifyError(input.error)}`, isError: true };
        return (drafting[name] as (input: unknown) => Promise<ClerkToolOutput>)(input.data);
      }
      const name = use.name as ClerkChatTool;
      if (!(CLERK_CHAT_TOOLS as readonly string[]).includes(name))
        return { text: `There is no tool called ${use.name}.`, isError: true };
      const input = INPUTS[name].safeParse(use.input ?? {});
      if (!input.success) return { text: `Invalid input: ${z.prettifyError(input.error)}`, isError: true };
      return (handlers[name] as (input: unknown) => Promise<ClerkToolOutput>)(input.data);
    },
  };
}

/**
 * The chat tools' reads on Firestore: matter subcollections under the caller's org, single-field
 * filters only (no new indexes), capped.
 */
export function firestoreChatToolSource(db: Firestore): ChatToolSource {
  const sub = (orgId: string, matterId: string, name: string) =>
    db.collection(`orgs/${orgId}/matters/${matterId}/${name}`);
  const rows = (snap: import('firebase-admin/firestore').QuerySnapshot): Row[] =>
    snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const MAX = 200;
  return {
    async records(orgId, matterId, collection, statuses) {
      const base = sub(orgId, matterId, collection);
      const query = statuses?.length ? base.where('status', 'in', [...statuses]) : base;
      return rows(await query.limit(MAX).get());
    },
    async timeEntries(orgId, matterId, { from, to }) {
      let query = sub(orgId, matterId, 'timeEntries').orderBy('date');
      if (from) query = query.where('date', '>=', from);
      if (to) query = query.where('date', '<=', to);
      return rows(await query.limit(500).get());
    },
  };
}
