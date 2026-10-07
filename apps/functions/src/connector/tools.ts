import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  addDays,
  can,
  CONNECTOR_LIST_MAX,
  CONNECTOR_MODEL,
  CONNECTOR_PROMPT_ID,
  CONNECTOR_PROMPT_VERSION,
  CONNECTOR_PROPOSE_TOOLS,
  CONNECTOR_READ_TOOLS,
  CONNECTOR_TOOL_INFO,
  connectorToolAllowed,
  contactDisplayName,
  DateOnlySchema,
  formatCents,
  MATTER_STATUS_LABELS,
  MATTER_TYPE_NAMES,
  MatterStatusSchema,
  matchesSearch,
  OPEN_TASK_STATUSES,
  parseSearchQuery,
  PrioritySchema,
  rankSearchHits,
  TASK_TITLE_MAX,
  TaskStatusSchema,
  TIME_NARRATIVE_MAX,
  today,
  todayWindow,
  type Cents,
  type ConnectorTool,
  type DateOnly,
  type MatterStatus,
  type MatterType,
  type SuggestionKind,
} from '@materia/domain';

import { toDate, type ConnectorPrincipal } from './access';
import type { Log } from '../core/log';
import { CLOSED_STATUSES } from '../deadlines/shared';
import { matterPath, mattersPath } from '../matters/shared';
import type { Clock } from '../ports';
import { proposeSuggestions, type ProposeSkipReason } from '../suggestions/propose';

type Data = Record<string, unknown>;
interface Row {
  id: string;
  data: Data;
}

/** What a tool runs with: the person it acts for, and the app's origin for links. */
export interface ToolContext {
  db: Firestore;
  clock: Clock;
  log: Log;
  origin: string;
  principal: ConnectorPrincipal;
}

/** An MCP `CallToolResult`. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool's result and, for the audit log, the matter it was about and how many records it returned. */
export interface ToolOutcome {
  result: ToolResult;
  matterId?: string;
  count?: number;
}

/** A refusal Claude should relay: the person's request can't be done as asked. */
class ToolRefusal extends Error {}

/** Rows a cross-matter query reads before filtering (privileged or deleted matters are dropped). */
const READ_MAX = 200;
const OPEN_DEADLINES = ['upcoming', 'blocked'];
const ACTIVE_MATTERS: readonly MatterStatus[] = ['lead', 'open', 'on_hold'];
const DEFAULT_DEADLINE_DAYS = 30;
const DEFAULT_TIME_DAYS = 7;
const NOTE_MAX = 10_000;

const MatterRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The matter: its number (such as M-2026-0142) or its id from another tool');
const Reason = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .describe('Why, in a sentence, shown on the suggestion (for example what the person said)');

const INPUTS = {
  get_my_day: z.object({}),
  search_matters: z.object({
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('Words from the matter’s title or client’s name, or its number. Leave out to list matters'),
    status: z
      .enum(['active', 'any', ...MatterStatusSchema.options])
      .optional()
      .describe('`active` is lead, open or on hold (the default without a query); `any` (the default with one)'),
    mine: z.boolean().optional().describe('Only matters the person is responsible for'),
    limit: z.number().int().min(1).max(CONNECTOR_LIST_MAX).optional().describe('At most this many (default 20)'),
  }),
  get_matter: z.object({ matter: MatterRef }),
  list_deadlines: z.object({
    matter: MatterRef.optional(),
    mine: z
      .boolean()
      .optional()
      .describe('Without a matter: only deadlines assigned to the person (the default) or everyone’s'),
    withinDays: z
      .number()
      .int()
      .min(0)
      .max(366)
      .optional()
      .describe(
        'Due within this many days from today (default 30 without a matter, all on one); overdue ones always show',
      ),
  }),
  list_tasks: z.object({
    matter: MatterRef.optional().describe('One matter’s tasks; without it, the person’s own tasks'),
    status: z
      .enum(['open', ...TaskStatusSchema.options])
      .optional()
      .describe('`open` (the default) is to do, in progress and blocked'),
  }),
  get_time_summary: z.object({
    matter: MatterRef.optional().describe('One matter’s time (everyone’s); without it, the person’s own'),
    from: DateOnlySchema.optional().describe('First day, YYYY-MM-DD (default a week ago without a matter)'),
    to: DateOnlySchema.optional().describe('Last day, YYYY-MM-DD (default today)'),
  }),
  propose_task: z.object({
    matter: MatterRef,
    title: z.string().trim().min(1).max(TASK_TITLE_MAX).describe('What to do, in the person’s words'),
    details: z.string().trim().max(NOTE_MAX).optional().describe('Anything else the person said about it'),
    dueDate: DateOnlySchema.optional().describe('When it is due, YYYY-MM-DD, only when the person said'),
    priority: PrioritySchema.optional().describe('Only when the person said how urgent it is'),
    reason: Reason,
  }),
  propose_note: z.object({
    matter: MatterRef,
    text: z.string().trim().min(1).max(NOTE_MAX).describe('The file note, in the person’s own words, tidied'),
    reason: Reason,
  }),
  propose_time_entry: z.object({
    matter: MatterRef,
    date: DateOnlySchema.describe('The day the work was done, YYYY-MM-DD'),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .describe('How long, in minutes'),
    narrative: z.string().trim().min(1).max(TIME_NARRATIVE_MAX).describe('What was done, as it should read on a bill'),
    billable: z.boolean().optional().describe('Whether it is billable (default true)'),
    reason: Reason,
  }),
} satisfies Record<ConnectorTool, z.ZodType>;

const SUGGESTION_NOTE =
  'Nothing has changed in Materia yet: this waits on the matter as a suggestion until someone accepts it there.';

const DESCRIPTIONS: Record<ConnectorTool, string> = {
  get_my_day: 'The person’s day in Materia, as on their Today page: their overdue and this week’s deadlines and tasks.',
  search_matters:
    'Find matters by number, title or client name, or list matters (most recently active first). Privileged matters are never included.',
  get_matter:
    'One matter’s summary: status, type, responsible lawyer, team, clients, the deceased for an estate, key facts, the next deadline and open tasks (and WIP for roles that see billing).',
  list_deadlines:
    'Open deadlines, on one matter or across matters (the person’s own by default), soonest first, overdue ones flagged. Deadlines can be legally critical: quote dates exactly as given.',
  list_tasks: 'Tasks on one matter, or the person’s own open tasks across matters (with their personal tasks).',
  get_time_summary:
    'Time recorded over a period, in minutes: on one matter (everyone’s), or the person’s own by matter. Amounts only for roles that see billing.',
  propose_task: `Suggest a task on a matter, when the person asks for one. ${SUGGESTION_NOTE}`,
  propose_note: `Suggest a file note on a matter, when the person asks you to record one. ${SUGGESTION_NOTE}`,
  propose_time_entry: `Suggest a time entry for the person on a matter, when they ask you to record time. ${SUGGESTION_NOTE}`,
};

/** An MCP tool definition (`tools/list`). */
export interface McpTool {
  name: ConnectorTool;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function definition(name: ConnectorTool): McpTool {
  // `$schema` names the JSON Schema draft; MCP clients take the schema without it.
  const inputSchema = z.toJSONSchema(INPUTS[name], { io: 'input' }) as Record<string, unknown>;
  delete inputSchema['$schema'];
  const read = (CONNECTOR_READ_TOOLS as readonly string[]).includes(name);
  const title = CONNECTOR_TOOL_INFO[name].title;
  return {
    name,
    title,
    description: DESCRIPTIONS[name],
    inputSchema,
    annotations: { title, readOnlyHint: read, destructiveHint: false, idempotentHint: read, openWorldHint: false },
  };
}

const DEFINITIONS = new Map(
  [...CONNECTOR_READ_TOOLS, ...CONNECTOR_PROPOSE_TOOLS].map((name) => [name, definition(name)] as const),
);

/** Why a tool isn't offered to this person now, or null when it is. */
export function toolUnavailable(principal: ConnectorPrincipal, name: ConnectorTool): string | null {
  const info = CONNECTOR_TOOL_INFO[name];
  if (!principal.scopes.includes(info.scope))
    return 'This connection wasn’t allowed to do that. Connect again to allow it.';
  if (!connectorToolAllowed(principal.role, name)) return 'The person’s role in Materia can’t do that.';
  if (info.scope === 'materia.propose') {
    if (!principal.allowProposals) return 'The practice has turned off suggestions from Claude.';
    if (principal.readOnly) return 'The practice is scheduled for deletion, so nothing can be added to it.';
  }
  return null;
}

/** The tools this person may use now (`tools/list`). */
export function toolsFor(principal: ConnectorPrincipal): McpTool[] {
  return [...DEFINITIONS.values()].filter((tool) => toolUnavailable(principal, tool.name) === null);
}

export function isConnectorTool(name: unknown): name is ConnectorTool {
  return typeof name === 'string' && DEFINITIONS.has(name as ConnectorTool);
}

// ---------- shared reads ----------

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] === undefined || data['deletedAt'] === null);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

function ok(value: Record<string, unknown>): ToolResult {
  const structured = json(value);
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

const refused = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const link = (ctx: ToolContext, path: string) => `${ctx.origin}${path}`;
const matterLink = (ctx: ToolContext, id: string, tab = 'overview') =>
  link(ctx, `/matters/${encodeURIComponent(id)}/${tab}`);

/** A matter as other records name it. */
interface MatterName {
  id: string;
  number: string | undefined;
  title: string | undefined;
}

/** The live, non-privileged matters among `ids` (Claude never sees a privileged matter's records). */
async function sharedMatters(ctx: ToolContext, ids: Iterable<string>): Promise<Map<string, MatterName>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Map();
  const { db, principal } = ctx;
  const snaps = await db.getAll(...unique.map((id) => db.doc(matterPath(principal.orgId, id))));
  const result = new Map<string, MatterName>();
  for (const snap of snaps) {
    const data = snap.data() as Data | undefined;
    if (!isLive(data) || data?.['privileged'] === true) continue;
    result.set(snap.id, { id: snap.id, number: str(data?.['number']), title: str(data?.['title']) });
  }
  return result;
}

async function memberNames(ctx: ToolContext, uids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(uids)].filter(Boolean);
  if (!unique.length) return new Map();
  const { db, principal } = ctx;
  const snaps = await db.getAll(...unique.map((uid) => db.doc(`orgs/${principal.orgId}/members/${uid}`)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, String(s.get('displayName') ?? 'A member')]));
}

async function contactNames(ctx: ToolContext, ids: Iterable<string>): Promise<string[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return [];
  const { db, principal } = ctx;
  const snaps = await db.getAll(...unique.map((id) => db.doc(`orgs/${principal.orgId}/contacts/${id}`)));
  return snaps.filter((s) => s.exists).map((s) => contactDisplayName((s.data() ?? {}) as Data));
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The matter a tool names, by id or number. A privileged matter is refused, and to a role that
 * can't see privileged matters it doesn't exist, as in Materia.
 */
async function findMatter(ctx: ToolContext, ref: string): Promise<Row> {
  const { db, principal } = ctx;
  const notFound = new ToolRefusal(`No matter matches “${ref}”. Use search_matters to find it.`);
  let found: Row | undefined;
  if (ID.test(ref)) {
    const snap = await db.doc(matterPath(principal.orgId, ref)).get();
    if (snap.exists) found = { id: snap.id, data: snap.data() as Data };
  }
  for (const number of new Set([ref, ref.toUpperCase()])) {
    if (found) break;
    const snap = await db.collection(mattersPath(principal.orgId)).where('number', '==', number).limit(5).get();
    const live = snap.docs.find((doc) => isLive(doc.data()));
    if (live) found = { id: live.id, data: live.data() };
  }
  if (!found || !isLive(found.data)) throw notFound;
  if (found.data['privileged'] === true) {
    if (!can(principal.role, 'privileged.view')) throw notFound;
    throw new ToolRefusal('That matter is privileged, so Materia doesn’t share it with Claude. Open it in Materia.');
  }
  return found;
}

const matterName = (row: Row): MatterName => ({
  id: row.id,
  number: str(row.data['number']),
  title: str(row.data['title']),
});

function deadlineRow(ctx: ToolContext, row: Row, matter: MatterName, todayDate: DateOnly, names: Map<string, string>) {
  const dueDate = str(row.data['dueDate']);
  return {
    id: row.id,
    title: str(row.data['title']),
    dueDate,
    dueTime: str(row.data['dueTime']),
    overdue: dueDate && dueDate < todayDate && row.data['status'] === 'upcoming' ? true : undefined,
    critical: row.data['critical'] === true ? true : undefined,
    status: str(row.data['status']),
    kind: str(row.data['kind']),
    rule: str((row.data['computed'] as Data | undefined)?.['citation']),
    assignee: names.get(String(row.data['assigneeUid'])),
    matter,
    link: matterLink(ctx, matter.id, 'deadlines'),
  };
}

function taskRow(
  ctx: ToolContext,
  row: Row,
  matter: MatterName | null,
  todayDate: DateOnly,
  names: Map<string, string>,
) {
  const dueDate = str(row.data['dueDate']);
  const open = (OPEN_TASK_STATUSES as readonly unknown[]).includes(row.data['status']);
  const priority = str(row.data['priority']);
  return {
    id: row.id,
    title: str(row.data['title']),
    status: str(row.data['status']),
    priority: priority === 'none' ? undefined : priority,
    dueDate,
    overdue: open && dueDate && dueDate < todayDate ? true : undefined,
    assignee: names.get(String(row.data['assigneeUid'])),
    matter,
    link: matter ? matterLink(ctx, matter.id, 'tasks') : link(ctx, '/tasks'),
  };
}

const byDue = (a: Row, b: Row) =>
  String(a.data['dueDate'] ?? '9999').localeCompare(String(b.data['dueDate'] ?? '9999')) || a.id.localeCompare(b.id);
const rows = (snap: { docs: { id: string; data(): unknown }[] }): Row[] =>
  snap.docs.map((doc) => ({ id: doc.id, data: (doc.data() ?? {}) as Data })).filter((row) => isLive(row.data));

const todayFor = (ctx: ToolContext) => today(ctx.principal.timeZone, ctx.clock.now());

// ---------- the tools ----------

type Handler<K extends ConnectorTool> = (ctx: ToolContext, input: z.output<(typeof INPUTS)[K]>) => Promise<ToolOutcome>;

const handlers: { [K in ConnectorTool]: Handler<K> } = {
  async get_my_day(ctx) {
    const { db, principal } = ctx;
    const todayDate = todayFor(ctx);
    const week = todayWindow(todayDate);
    const [deadlineSnap, taskSnap] = await Promise.all([
      db
        .collectionGroup('deadlines')
        .where('orgId', '==', principal.orgId)
        .where('privileged', '==', false)
        .where('assigneeUid', '==', principal.uid)
        .where('status', '==', 'upcoming')
        .where('dueDate', '<=', week.weekEnd)
        .orderBy('dueDate')
        .limit(READ_MAX)
        .get(),
      db
        .collectionGroup('tasks')
        .where('orgId', '==', principal.orgId)
        .where('assigneeUid', '==', principal.uid)
        .where('status', 'in', [...OPEN_TASK_STATUSES])
        .where('dueDate', '<=', week.weekEnd)
        .orderBy('dueDate')
        .limit(READ_MAX)
        .get(),
    ]);
    const deadlines = rows(deadlineSnap).sort(byDue);
    const tasks = rows(taskSnap).sort(byDue);
    const matters = await sharedMatters(ctx, [
      ...deadlines.map((row) => String(row.data['matterId'] ?? '')),
      ...tasks.map((row) => String(row.data['matterId'] ?? '')),
    ]);
    const names = new Map<string, string>();
    const deadlineRows = deadlines.flatMap((row) => {
      const matter = matters.get(String(row.data['matterId']));
      return matter ? [deadlineRow(ctx, row, matter, todayDate, names)] : [];
    });
    const taskRows = tasks.flatMap((row) => {
      const matterId = str(row.data['matterId']);
      const matter = matterId ? matters.get(matterId) : null;
      return matter === undefined ? [] : [taskRow(ctx, row, matter, todayDate, names)];
    });
    const overdue = <T extends { dueDate?: string | undefined }>(list: T[]) =>
      list.filter((r) => (r.dueDate ?? '') < todayDate).slice(0, CONNECTOR_LIST_MAX);
    const upcoming = <T extends { dueDate?: string | undefined }>(list: T[]) =>
      list.filter((r) => (r.dueDate ?? '') >= todayDate).slice(0, CONNECTOR_LIST_MAX);
    return {
      count: deadlineRows.length + taskRows.length,
      result: ok({
        today: todayDate,
        weekEnds: week.weekEnd,
        timeZone: principal.timeZone,
        overdueDeadlines: overdue(deadlineRows),
        deadlinesThisWeek: upcoming(deadlineRows),
        overdueTasks: overdue(taskRows),
        tasksThisWeek: upcoming(taskRows),
        link: link(ctx, '/today'),
      }),
    };
  },

  async search_matters(ctx, { query, status, mine, limit }) {
    const { db, principal } = ctx;
    const max = limit ?? 20;
    const text = query?.trim() ?? '';
    const wanted = status ?? (text ? 'any' : 'active');
    const statuses: readonly MatterStatus[] | null =
      wanted === 'any' ? null : wanted === 'active' ? ACTIVE_MATTERS : [wanted as MatterStatus];
    let base = db
      .collection(mattersPath(principal.orgId))
      .where('deletedAt', '==', null)
      .where('privileged', '==', false);
    let found: Row[];
    if (text) {
      const parsed = parseSearchQuery(text);
      if (!parsed.token) throw new ToolRefusal('Search with at least two letters or digits.');
      const snap = await base
        .where('search', 'array-contains', parsed.token)
        .orderBy('lastActivityAt', 'desc')
        .limit(READ_MAX)
        .get();
      const hits = rows(snap)
        .filter((row) => {
          const tokens = (row.data['search'] as string[] | undefined) ?? [];
          return matchesSearch(tokens, parsed, [String(row.data['title'] ?? ''), String(row.data['number'] ?? '')]);
        })
        .filter((row) => !statuses || statuses.includes(row.data['status'] as MatterStatus))
        .filter((row) => !mine || row.data['responsibleUid'] === principal.uid)
        .map((row) => ({
          row,
          number: str(row.data['number']),
          title: String(row.data['title'] ?? ''),
          at: toDate(row.data['lastActivityAt']) ?? null,
        }));
      found = rankSearchHits(hits, parsed).map((hit) => hit.row);
    } else {
      if (statuses)
        base =
          statuses.length === 1 ? base.where('status', '==', statuses[0]) : base.where('status', 'in', [...statuses]);
      if (mine) base = base.where('responsibleUid', '==', principal.uid);
      const snap = await base.orderBy('lastActivityAt', 'desc').limit(max).get();
      found = rows(snap).sort(
        (a, b) =>
          (toDate(b.data['lastActivityAt'])?.getTime() ?? 0) - (toDate(a.data['lastActivityAt'])?.getTime() ?? 0),
      );
    }
    const page = found.slice(0, max);
    const names = await memberNames(
      ctx,
      page.map((row) => String(row.data['responsibleUid'] ?? '')),
    );
    return {
      count: page.length,
      result: ok({
        matters: page.map((row) => {
          const next = row.data['nextDeadline'] as Data | undefined;
          return {
            id: row.id,
            number: str(row.data['number']),
            title: str(row.data['title']),
            type: MATTER_TYPE_NAMES[row.data['type'] as MatterType] ?? str(row.data['type']),
            status: MATTER_STATUS_LABELS[row.data['status'] as MatterStatus] ?? str(row.data['status']),
            responsible: names.get(String(row.data['responsibleUid'])),
            nextDeadline: next ? { title: str(next['title']), dueDate: str(next['dueDate']) } : undefined,
            openTasks: typeof row.data['openTaskCount'] === 'number' ? row.data['openTaskCount'] : undefined,
            lastActivity: toDate(row.data['lastActivityAt'])?.toISOString().slice(0, 10),
            link: matterLink(ctx, row.id),
          };
        }),
        more: found.length > max ? true : undefined,
      }),
    };
  },

  async get_matter(ctx, { matter: ref }) {
    const { principal } = ctx;
    const row = await findMatter(ctx, ref);
    const data = row.data;
    const team = ((data['teamUids'] as string[] | undefined) ?? []).filter((uid) => uid !== data['responsibleUid']);
    const deceased = data['deceased'] as Data | undefined;
    const [names, clients, deceasedName] = await Promise.all([
      memberNames(ctx, [String(data['responsibleUid'] ?? ''), ...team]),
      contactNames(ctx, (data['clientContactIds'] as string[] | undefined) ?? []),
      deceased?.['contactId'] ? contactNames(ctx, [String(deceased['contactId'])]) : Promise.resolve([]),
    ]);
    const next = data['nextDeadline'] as Data | undefined;
    const facts = (data['facts'] as Data | undefined) ?? {};
    const estate = (data['estate'] as Data | undefined) ?? {};
    const billing = can(principal.role, 'billing.view');
    const money = (value: unknown) => (typeof value === 'number' ? formatCents(value as Cents) : undefined);
    return {
      matterId: row.id,
      count: 1,
      result: ok({
        id: row.id,
        number: str(data['number']),
        title: str(data['title']),
        type: MATTER_TYPE_NAMES[data['type'] as MatterType] ?? str(data['type']),
        status: MATTER_STATUS_LABELS[data['status'] as MatterStatus] ?? str(data['status']),
        jurisdiction: str(data['jurisdiction']),
        responsible: names.get(String(data['responsibleUid'])),
        team: team.map((uid) => names.get(uid)).filter(Boolean),
        clients,
        deceased: deceased
          ? { name: deceasedName[0], dateOfDeath: str(deceased['dateOfDeath']) ?? 'unknown' }
          : undefined,
        keyFacts: {
          willDate: str(facts['willDate']),
          courtFileNo: str(facts['courtFileNo']),
          trustName: str(facts['trustName']),
          grantType: str(estate['grantType']),
          grantDate: str(estate['grantDate']),
          grantNo: str(estate['grantNo']),
        },
        opened: toDate(data['createdAt'])?.toISOString().slice(0, 10),
        nextDeadline: next
          ? {
              title: str(next['title']),
              dueDate: str(next['dueDate']),
              critical: next['critical'] === true || undefined,
            }
          : undefined,
        openTasks: typeof data['openTaskCount'] === 'number' ? data['openTaskCount'] : undefined,
        wip: billing ? money(data['wipCents']) : undefined,
        outstanding: billing ? money(data['outstandingCents']) : undefined,
        link: matterLink(ctx, row.id),
      }),
    };
  },

  async list_deadlines(ctx, { matter: ref, mine, withinDays }) {
    const { db, principal } = ctx;
    const todayDate = todayFor(ctx);
    let found: Row[];
    let matterId: string | undefined;
    let matters: Map<string, MatterName>;
    if (ref) {
      const matter = await findMatter(ctx, ref);
      matterId = matter.id;
      const snap = await db
        .collection(`${matterPath(principal.orgId, matter.id)}/deadlines`)
        .where('status', 'in', OPEN_DEADLINES)
        .limit(READ_MAX)
        .get();
      const horizon = withinDays === undefined ? undefined : addDays(todayDate, withinDays);
      found = rows(snap)
        .filter((row) => row.data['privileged'] !== true)
        .filter((row) => !horizon || !row.data['dueDate'] || String(row.data['dueDate']) <= horizon);
      matters = new Map([[matter.id, matterName(matter)]]);
    } else {
      const horizon = addDays(todayDate, withinDays ?? DEFAULT_DEADLINE_DAYS);
      let query = db
        .collectionGroup('deadlines')
        .where('orgId', '==', principal.orgId)
        .where('privileged', '==', false);
      if (mine !== false) query = query.where('assigneeUid', '==', principal.uid);
      const snap = await query
        .where('status', '==', 'upcoming')
        .where('dueDate', '<=', horizon)
        .orderBy('dueDate')
        .limit(READ_MAX)
        .get();
      found = rows(snap);
      matters = await sharedMatters(
        ctx,
        found.map((row) => String(row.data['matterId'] ?? '')),
      );
    }
    const names = await memberNames(
      ctx,
      found.map((row) => String(row.data['assigneeUid'] ?? '')),
    );
    const list = found.sort(byDue).flatMap((row) => {
      const matter = matters.get(String(row.data['matterId'] ?? matterId));
      return matter ? [deadlineRow(ctx, row, matter, todayDate, names)] : [];
    });
    return {
      ...(matterId ? { matterId } : {}),
      count: Math.min(list.length, CONNECTOR_LIST_MAX),
      result: ok({
        today: todayDate,
        deadlines: list.slice(0, CONNECTOR_LIST_MAX),
        more: list.length > CONNECTOR_LIST_MAX || undefined,
      }),
    };
  },

  async list_tasks(ctx, { matter: ref, status }) {
    const { db, principal } = ctx;
    const todayDate = todayFor(ctx);
    const statuses = !status || status === 'open' ? [...OPEN_TASK_STATUSES] : [status];
    let found: Row[];
    let matterId: string | undefined;
    let matters: Map<string, MatterName>;
    if (ref) {
      const matter = await findMatter(ctx, ref);
      matterId = matter.id;
      const snap = await db
        .collection(`${matterPath(principal.orgId, matter.id)}/tasks`)
        .where('status', 'in', statuses)
        .limit(READ_MAX)
        .get();
      found = rows(snap);
      matters = new Map([[matter.id, matterName(matter)]]);
    } else {
      const snap = await db
        .collectionGroup('tasks')
        .where('orgId', '==', principal.orgId)
        .where('assigneeUid', '==', principal.uid)
        .where('status', 'in', statuses)
        .limit(READ_MAX)
        .get();
      found = rows(snap);
      matters = await sharedMatters(
        ctx,
        found.map((row) => String(row.data['matterId'] ?? '')),
      );
    }
    const names = await memberNames(
      ctx,
      found.map((row) => String(row.data['assigneeUid'] ?? '')),
    );
    const list = found.sort(byDue).flatMap((row) => {
      const id = str(row.data['matterId']) ?? matterId;
      const matter = id ? matters.get(id) : null;
      return matter === undefined ? [] : [taskRow(ctx, row, matter, todayDate, names)];
    });
    return {
      ...(matterId ? { matterId } : {}),
      count: Math.min(list.length, CONNECTOR_LIST_MAX),
      result: ok({
        today: todayDate,
        tasks: list.slice(0, CONNECTOR_LIST_MAX),
        more: list.length > CONNECTOR_LIST_MAX || undefined,
      }),
    };
  },

  async get_time_summary(ctx, { matter: ref, from, to }) {
    const { db, principal } = ctx;
    const todayDate = todayFor(ctx);
    const end = to ?? todayDate;
    if (from && from > end) throw new ToolRefusal('`from` is after `to`.');
    let entries: Row[];
    let matterId: string | undefined;
    let start: DateOnly | undefined = from;
    let matters: Map<string, MatterName>;
    if (ref) {
      const matter = await findMatter(ctx, ref);
      matterId = matter.id;
      let query = db.collection(`${matterPath(principal.orgId, matter.id)}/timeEntries`).orderBy('date');
      if (start) query = query.where('date', '>=', start);
      const snap = await query.where('date', '<=', end).limit(2000).get();
      entries = rows(snap);
      matters = new Map([[matter.id, matterName(matter)]]);
    } else {
      start ??= addDays(end, -(DEFAULT_TIME_DAYS - 1));
      const snap = await db
        .collectionGroup('timeEntries')
        .where('orgId', '==', principal.orgId)
        .where('uid', '==', principal.uid)
        .where('date', '>=', start)
        .where('date', '<=', end)
        .orderBy('date')
        .limit(2000)
        .get();
      entries = rows(snap);
      matters = await sharedMatters(
        ctx,
        entries.map((row) => String(row.data['matterId'] ?? '')),
      );
    }
    const shared = entries.filter((row) => {
      const date = String(row.data['date'] ?? '');
      return matters.has(String(row.data['matterId'] ?? matterId)) && (!start || date >= start) && date <= end;
    });
    const minutes = (list: readonly Row[]) =>
      list.reduce((sum, row) => sum + (typeof row.data['minutes'] === 'number' ? row.data['minutes'] : 0), 0);
    const byStatus: Record<string, number> = {};
    for (const row of shared) {
      const key = String(row.data['status'] ?? 'unknown');
      byStatus[key] = (byStatus[key] ?? 0) + minutes([row]);
    }
    // Amounts are billing information: only for roles that may see billing.
    const amount = can(principal.role, 'billing.view')
      ? formatCents(
          shared.reduce(
            (sum, row) => sum + (typeof row.data['amountCents'] === 'number' ? row.data['amountCents'] : 0),
            0,
          ) as Cents,
        )
      : undefined;
    const byMatter = matterId
      ? undefined
      : [...matters.values()]
          .map((matter) => ({
            matter,
            minutes: minutes(shared.filter((row) => row.data['matterId'] === matter.id)),
          }))
          .filter((item) => item.minutes > 0)
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, CONNECTOR_LIST_MAX);
    return {
      ...(matterId ? { matterId } : {}),
      count: shared.length,
      result: ok({
        from: start,
        to: end,
        whose: matterId ? 'everyone on the matter' : 'the person’s own',
        entries: shared.length,
        totalMinutes: minutes(shared),
        billableMinutes: minutes(shared.filter((row) => row.data['billable'] === true)),
        minutesByStatus: byStatus,
        amount,
        byMatter,
        link: matterId ? matterLink(ctx, matterId, 'time') : link(ctx, '/time'),
      }),
    };
  },

  propose_task: (ctx, { matter, title, details, dueDate, priority, reason }) =>
    propose(
      ctx,
      matter,
      'task',
      {
        title,
        ...(details ? { descriptionMd: details } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(priority ? { priority } : {}),
      },
      reason,
    ),

  propose_note: (ctx, { matter, text, reason }) =>
    propose(ctx, matter, 'note', { bodyMd: text, pinned: false }, reason),

  propose_time_entry: (ctx, { matter, date, minutes, narrative, billable, reason }) =>
    propose(ctx, matter, 'time_entry', { date, minutes, narrative, billable: billable ?? true }, reason),
};

/** What Claude is told when a suggestion wasn't made, so it tells the person what really happened. */
const SKIPPED: Record<ProposeSkipReason, string> = {
  invalid: 'That suggestion isn’t valid, so it wasn’t made.',
  duplicate: 'The same suggestion is already waiting on that matter (or was dismissed), so it wasn’t made again.',
  exists: 'That matter already has it, so it wasn’t suggested.',
  disabled: 'Suggestions are switched off for this practice, so nothing could be suggested.',
  matter_unavailable: 'That matter is closed or archived, so nothing can be added to it.',
};

async function propose(
  ctx: ToolContext,
  ref: string,
  kind: SuggestionKind,
  payload: Data,
  reason: string | undefined,
): Promise<ToolOutcome> {
  const { db, clock, log, principal } = ctx;
  const matter = await findMatter(ctx, ref);
  if (CLOSED_STATUSES.has(matter.data['status']))
    return { matterId: matter.id, result: refused(SKIPPED.matter_unavailable) };
  const outcome = await proposeSuggestions(
    { db, orgId: principal.orgId, clock, log },
    matter.id,
    [{ kind, payload, citations: [], ...(reason ? { rationale: reason } : {}) }],
    {
      privileged: false,
      promptId: CONNECTOR_PROMPT_ID,
      promptVersion: CONNECTOR_PROMPT_VERSION,
      model: CONNECTOR_MODEL,
      requestedBy: { uid: principal.uid, name: principal.name.slice(0, 120) },
    },
  );
  const created = outcome.created[0];
  if (!created) {
    const skipped = outcome.skipped[0]?.reason ?? 'invalid';
    return { matterId: matter.id, result: refused(SKIPPED[skipped]) };
  }
  return {
    matterId: matter.id,
    count: 1,
    result: ok({
      status: 'suggested',
      suggestionId: created.id,
      matter: matterName(matter),
      note: `${SUGGESTION_NOTE} Tell the person to review it on the matter’s Overview.`,
      link: matterLink(ctx, matter.id),
    }),
  };
}

/**
 * Runs one tool for the person: checks it is offered to them, validates the input, and turns a
 * refusal into an error result Claude can relay (MCP tool errors are results, not protocol errors).
 */
export async function runTool(ctx: ToolContext, name: ConnectorTool, args: unknown): Promise<ToolOutcome> {
  const unavailable = toolUnavailable(ctx.principal, name);
  if (unavailable) return { result: refused(unavailable) };
  const input = INPUTS[name].safeParse(args ?? {});
  if (!input.success) return { result: refused(`Invalid input: ${z.prettifyError(input.error)}`) };
  try {
    return await (handlers[name] as (ctx: ToolContext, input: unknown) => Promise<ToolOutcome>)(ctx, input.data);
  } catch (error) {
    if (error instanceof ToolRefusal) return { result: refused(error.message) };
    throw error;
  }
}
