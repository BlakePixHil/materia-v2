import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import { PrioritySchema, TaskStatusSchema, type Priority, type TaskStatus } from './schemas/enums';
import { PersonalTask, Task } from './schemas/matter-records';
import { addDays, compareDates, DateOnlySchema, weekday, type DateOnly } from './values/date-only';

/**
 * Tasks (CORE-08): matter tasks (`orgs/{orgId}/matters/{matterId}/tasks`) and personal tasks
 * (`orgs/{orgId}/members/{uid}/tasks`). Clients create, edit the whitelisted fields of and soft
 * delete tasks directly (the rules validate them); `tasks-bulkUpdate` changes more than
 * `TASK_CLIENT_BATCH_MAX` at once; `tasks-onWrite` keeps `openTaskCount`, `completedAt`, assignment
 * notifications and the matter's activity. The quick-add parser is a separate entry point
 * (`@materia/domain/quick-add`) because it brings chrono-node.
 */

// ---------- status and priority ----------

/** Statuses that count as open (`openTaskCount`, "My tasks"); `done` and `cancelled` are closed. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export interface TaskLike {
  status?: unknown;
  deletedAt?: unknown;
}

/** A live task whose status is open. */
export function isOpenTask(task: TaskLike | undefined | null): boolean {
  if (!task || (task.deletedAt !== undefined && task.deletedAt !== null)) return false;
  return (OPEN_TASK_STATUSES as readonly unknown[]).includes(task.status);
}

/** Sort rank of a priority, most pressing first (urgent 0 … none 4). */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Space toggles done: an open task becomes `done`, a closed one goes back to `todo`. */
export function toggledStatus(status: TaskStatus): TaskStatus {
  return status === 'done' || status === 'cancelled' ? 'todo' : 'done';
}

/**
 * Completing a task with unticked checklist items is allowed after a confirm (CORE-08 edge case):
 * the number of open items the confirm mentions, 0 when no confirm is needed.
 */
export function openChecklistItems(task: { checklist?: readonly { done: boolean }[] }): number {
  return (task.checklist ?? []).filter((item) => !item.done).length;
}

/** Completing a task linked to a deadline asks "Mark the deadline as done too?". */
export function asksToCompleteDeadline(task: { deadlineId?: string | undefined }, next: TaskStatus): boolean {
  return next === 'done' && !!task.deadlineId;
}

// ---------- paths and client creates ----------

export const matterTaskPath = (orgId: string, matterId: string, taskId?: string) =>
  `orgs/${orgId}/matters/${matterId}/tasks${taskId ? `/${taskId}` : ''}`;
export const personalTaskPath = (orgId: string, uid: string, taskId?: string) =>
  `orgs/${orgId}/members/${uid}/tasks${taskId ? `/${taskId}` : ''}`;

/**
 * What a client writes to create a matter task (CORE-08), besides the meta fields the repository
 * stamps: the create fields plus `orgId` and `matterId` matching the path (the rules check both).
 * `source` is always `manual`; completion fields and template keys are the server's. `countedOpen`
 * is always `false`: the task isn't in the matter's `openTaskCount` until `tasks-onWrite` counts it
 * (a task written without the field is one counted before CORE-08).
 */
export const MatterTaskCreateInput = /* @__PURE__ */ Task.create.extend({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  source: z.literal('manual').default('manual'),
  countedOpen: z.literal(false).default(false),
});
export type MatterTaskCreateInput = z.input<typeof MatterTaskCreateInput>;

/** The same for a personal task: `matterId: null` and the owner as the assignee (the rules check it). */
export const PersonalTaskCreateInput = /* @__PURE__ */ PersonalTask.create.extend({
  orgId: DocIdSchema,
  matterId: z.null().default(null),
  assigneeUid: DocIdSchema,
  source: z.literal('manual').default('manual'),
});
export type PersonalTaskCreateInput = z.input<typeof PersonalTaskCreateInput>;

// ---------- fractional order ----------

/** The gap between neighbouring tasks after a rebalance, and before the first or after the last. */
export const ORDER_STEP = 1024;
/** Below this gap a midpoint is refused and the list is rebalanced instead. */
export const ORDER_MIN_GAP = 1e-6;

/**
 * The order for a task placed between `before` and `after` (either may be absent: the start or
 * end of the list, or an empty list). `null` when the two are too close for a midpoint (precision
 * has run out): call `rebalanceOrders` then.
 */
export function orderBetween(before?: number | null, after?: number | null): number | null {
  const hasBefore = typeof before === 'number' && Number.isFinite(before);
  const hasAfter = typeof after === 'number' && Number.isFinite(after);
  if (!hasBefore && !hasAfter) return ORDER_STEP;
  if (!hasBefore) return (after as number) - ORDER_STEP;
  if (!hasAfter) return (before as number) + ORDER_STEP;
  const low = Math.min(before as number, after as number);
  const high = Math.max(before as number, after as number);
  const mid = low + (high - low) / 2;
  if (high - low < ORDER_MIN_GAP || !(mid > low && mid < high)) return null;
  return mid;
}

export interface OrderedItem {
  id: string;
  order: number;
}

export interface OrderUpdate {
  id: string;
  order: number;
}

/** Evenly spaced orders (`ORDER_STEP` apart) for the ids in their display order. */
export function rebalanceOrders(ids: readonly string[]): OrderUpdate[] {
  return ids.map((id, i) => ({ id, order: (i + 1) * ORDER_STEP }));
}

/** Sorts by order, then id, so ties (two offline inserts) still sort the same everywhere. */
export function byOrder<T extends OrderedItem>(a: T, b: T): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Moves the tasks `ids` (in that order) to `toIndex` of the list without them (drag and drop,
 * Alt+Up/Down). Returns the writes: one order per moved task between its new neighbours, or, when
 * precision runs out or orders tie, a rebalance of the whole list (only the tasks whose order
 * changes). Write the result in batches (`chunkWrites`, at most 500 writes each).
 */
export function planMove(items: readonly OrderedItem[], ids: readonly string[], toIndex: number): OrderUpdate[] {
  const moving = new Set(ids);
  const sorted = [...items].sort(byOrder);
  const moved = ids.map((id) => sorted.find((item) => item.id === id)).filter((item): item is OrderedItem => !!item);
  if (!moved.length) return [];
  const rest = sorted.filter((item) => !moving.has(item.id));
  const index = Math.max(0, Math.min(toIndex, rest.length));
  const before = rest[index - 1]?.order;
  const after = rest[index]?.order;
  const n = moved.length;
  const current = new Map(sorted.map((item) => [item.id, item.order]));

  let orders: number[] | null;
  if (before === undefined && after === undefined) orders = moved.map((_, i) => (i + 1) * ORDER_STEP);
  else if (before === undefined) orders = moved.map((_, i) => (after as number) - (n - i) * ORDER_STEP);
  else if (after === undefined) orders = moved.map((_, i) => before + (i + 1) * ORDER_STEP);
  else {
    // Spread the moved tasks evenly across the gap; refuse when precision has run out.
    const gap = (after - before) / (n + 1);
    const spread = moved.map((_, i) => before + gap * (i + 1));
    const ok =
      gap >= ORDER_MIN_GAP && spread.every((o, i) => o > (i ? (spread[i - 1] as number) : before) && o < after);
    orders = ok ? spread : null;
  }
  if (!orders) {
    const finalIds = [...rest.slice(0, index), ...moved, ...rest.slice(index)].map((item) => item.id);
    return rebalanceOrders(finalIds).filter((update) => current.get(update.id) !== update.order);
  }
  const planned = orders;
  return moved
    .map((item, i) => ({ id: item.id, order: planned[i] as number }))
    .filter((update) => current.get(update.id) !== update.order);
}

/** Splits writes into batches of at most `size` (a Firestore batch takes 500 writes). */
export function chunkWrites<T>(items: readonly T[], size = 500): T[][] {
  if (size < 1) throw new Error('chunkWrites size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------- My tasks ----------

export type MyTaskSection = 'overdue' | 'today' | 'this_week' | 'later' | 'no_date';

/** The sections of "My tasks", in display order, with their headings. */
export const MY_TASK_SECTIONS: readonly { id: MyTaskSection; label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This week' },
  { id: 'later', label: 'Later' },
  { id: 'no_date', label: 'No date' },
];

/** The Sunday ending the (Monday to Sunday) week of `date`. */
export function endOfWeek(date: DateOnly): DateOnly {
  return addDays(date, 7 - weekday(date));
}

/**
 * The section of a due date, given today's date in the org's time zone (`today(org.timezone)`):
 * before today is Overdue, today is Today, after today up to Sunday is This week, later is Later,
 * and no due date is No date.
 */
export function myTaskSection(dueDate: DateOnly | undefined | null, todayDate: DateOnly): MyTaskSection {
  if (!dueDate) return 'no_date';
  const vsToday = compareDates(dueDate, todayDate);
  if (vsToday < 0) return 'overdue';
  if (vsToday === 0) return 'today';
  return compareDates(dueDate, endOfWeek(todayDate)) <= 0 ? 'this_week' : 'later';
}

export interface SectionableTask {
  id: string;
  dueDate?: DateOnly | undefined;
  priority?: Priority | undefined;
  order?: number | undefined;
}

export interface TaskSection<T> {
  id: MyTaskSection;
  label: string;
  tasks: T[];
}

/** Within a section: due date, then priority (urgent first), then order, then id. */
export function compareMyTasks(a: SectionableTask, b: SectionableTask): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return compareDates(a.dueDate, b.dueDate);
  }
  const rank = PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none'];
  if (rank) return rank;
  const order = (a.order ?? 0) - (b.order ?? 0);
  if (order) return order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Groups tasks into the My tasks sections (every section, empty ones included), each sorted. */
export function sectionMyTasks<T extends SectionableTask>(tasks: readonly T[], todayDate: DateOnly): TaskSection<T>[] {
  const sections = MY_TASK_SECTIONS.map((section) => ({ ...section, tasks: [] as T[] }));
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const task of tasks) byId.get(myTaskSection(task.dueDate, todayDate))?.tasks.push(task);
  for (const section of sections) section.tasks.sort(compareMyTasks);
  return sections;
}

// ---------- assignees ----------

export const FORMER_MEMBER_LABEL = 'Unassigned (former member)';

export type AssigneeState = 'unassigned' | 'member' | 'former_member';

export interface MemberLike {
  uid: string;
  status?: string | undefined;
}

/**
 * Whether a task's assignee is still in the org (CORE-08 edge case): a removed member, or a uid
 * with no member document, is a former member, and the task shows "Unassigned (former member)".
 * Suspended members are still members (they may come back).
 */
export function assigneeState(assigneeUid: string | undefined | null, members: readonly MemberLike[]): AssigneeState {
  if (!assigneeUid) return 'unassigned';
  const member = members.find((m) => m.uid === assigneeUid);
  return !member || member.status === 'removed' ? 'former_member' : 'member';
}

/** The tasks assigned to someone no longer in the org. */
export function tasksWithFormerAssignee<T extends { assigneeUid?: string | undefined }>(
  tasks: readonly T[],
  members: readonly MemberLike[],
): T[] {
  return tasks.filter((task) => assigneeState(task.assigneeUid, members) === 'former_member');
}

// ---------- tasks-bulkUpdate ----------

/** Up to this many selected tasks the client writes directly in batches; above it, `tasks-bulkUpdate`. */
export const TASK_CLIENT_BATCH_MAX = 50;
/** The most tasks one `tasks-bulkUpdate` call changes. */
export const TASK_BULK_MAX = 500;

/** A matter task, or (`matterId: null`) one of the caller's personal tasks. */
export const TaskRefSchema = z.object({ matterId: DocIdSchema.nullable(), taskId: DocIdSchema });
export type TaskRef = z.infer<typeof TaskRefSchema>;

export const BulkTaskChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), status: TaskStatusSchema }),
  /** `null` unassigns. Personal tasks keep their owner and are skipped. */
  z.object({ op: z.literal('assignee'), assigneeUid: DocIdSchema.nullable() }),
  /** `null` clears the due date. */
  z.object({ op: z.literal('dueDate'), dueDate: DateOnlySchema.nullable() }),
  z.object({ op: z.literal('priority'), priority: PrioritySchema }),
  /** Soft delete. */
  z.object({ op: z.literal('delete') }),
]);
export type BulkTaskChange = z.infer<typeof BulkTaskChangeSchema>;

export const taskRefKey = (ref: TaskRef) => `${ref.matterId ?? '~personal'}/${ref.taskId}`;

/** `tasks-bulkUpdate` (`task.edit`, idempotent): one change to up to 500 tasks. */
export const BulkUpdateTasksInput = z
  .object({
    requestId: z.uuid(),
    tasks: z.array(TaskRefSchema).min(1).max(TASK_BULK_MAX),
    change: BulkTaskChangeSchema,
  })
  .refine((input) => new Set(input.tasks.map(taskRefKey)).size === input.tasks.length, {
    message: 'Each task may be listed once',
    path: ['tasks'],
  });
export type BulkUpdateTasksInput = z.infer<typeof BulkUpdateTasksInput>;

export type BulkSkipReason = 'not_found' | 'deleted' | 'matter_unavailable' | 'personal_assignee' | 'unchanged';

export interface BulkUpdateTasksResult {
  /** Tasks written. */
  updated: number;
  /** Tasks left alone, and why. */
  skipped: { matterId: string | null; taskId: string; reason: BulkSkipReason }[];
}

/** The callable's name, as deployed. */
export const TASK_CALLABLES = { bulkUpdate: 'tasks-bulkUpdate' } as const;
