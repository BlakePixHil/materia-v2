import type { TaskItem, WithId } from '@materia/data-access/repository';
import {
  assigneeState,
  byOrder,
  DateOnlySchema,
  FORMER_MEMBER_LABEL,
  ORDER_STEP,
  TASK_CLIENT_BATCH_MAX,
  taskRefKey,
  type BulkTaskChange,
  type DateOnly,
  type MatterType,
  type MemberLike,
  type Priority,
  type TaskRef,
  type TaskStatus,
} from '@materia/domain';
import type { TaskRowVm } from '@materia/ui';

/**
 * The Tasks tab and My tasks (CORE-08): pure helpers that turn task records into rows and
 * sections, and words for statuses, priorities and bulk results. No data access here.
 */

export type TaskRecord = WithId<TaskItem>;

/** Someone a task can be assigned to. */
export interface TaskPerson {
  uid: string;
  name: string;
}

/** The matter a task is on, as My tasks shows it. */
export interface TaskMatterRef {
  id: string;
  number: string;
  title: string;
  /** Unknown while the matter loads, or when it can't be read. */
  type?: MatterType | undefined;
}

/** A task as a list shows it: the record, its row and what may be done with it. */
export interface TaskEntry {
  /** `taskRefKey`: unique across matters and personal tasks. */
  key: string;
  ref: TaskRef;
  task: TaskRecord;
  vm: TaskRowVm;
  /** The person may change it (task.edit for matter tasks; always for their personal ones). */
  editable: boolean;
  /** The matter (My tasks); null for a personal task, undefined on the matter's own tab. */
  matter?: TaskMatterRef | null | undefined;
}

/** A heading and its tasks. */
export interface TaskSectionVm {
  id: string;
  label: string;
  entries: TaskEntry[];
  /**
   * What a task dropped here from another section gets as its `group` (`null` clears it). Absent:
   * tasks can't be moved into this section.
   */
  group?: string | null;
}

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};
export const TASK_STATUS_ORDER: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

export const PRIORITY_NAMES: Readonly<Record<Priority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};
export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export const isClosed = (status: TaskStatus) => status === 'done' || status === 'cancelled';

export function refOf(task: TaskRecord): TaskRef {
  return { matterId: task.matterId ?? null, taskId: task.id };
}

export interface EntryOptions {
  members: readonly (MemberLike & { name: string })[];
  canEdit: boolean;
  /** Extra words for the second line (a template task's pending due date). */
  note?: string | null | undefined;
  matter?: TaskMatterRef | null | undefined;
}

/** A task's row: the assignee (or "Unassigned (former member)"), due date, status and notes. */
export function taskEntry(task: TaskRecord, options: EntryOptions): TaskEntry {
  const ref = refOf(task);
  const state = assigneeState(task.assigneeUid, options.members);
  const person = state === 'member' ? options.members.find((m) => m.uid === task.assigneeUid) : undefined;
  const parts: string[] = [];
  if (options.matter?.number) parts.push(`${options.matter.number} · ${options.matter.title}`);
  else if (options.matter === null) parts.push('Personal');
  if (task.status === 'in_progress' || task.status === 'blocked' || task.status === 'cancelled') {
    parts.push(TASK_STATUS_LABELS[task.status]);
  }
  if (state === 'former_member') parts.push(FORMER_MEMBER_LABEL);
  if (options.note) parts.push(options.note);
  const checklist = task.checklist ?? [];
  if (checklist.length) parts.push(`Checklist ${checklist.filter((item) => item.done).length}/${checklist.length}`);
  return {
    key: taskRefKey(ref),
    ref,
    task,
    matter: options.matter,
    editable: ref.matterId === null ? true : options.canEdit,
    vm: {
      id: task.id,
      title: task.title,
      done: isClosed(task.status),
      subtitle: parts.join(' · ') || undefined,
      matterType: options.matter?.type,
      assignee: person && task.assigneeUid ? { id: task.assigneeUid, name: person.name } : null,
      deadline: task.dueDate ? { due: task.dueDate } : null,
      priority: task.priority,
    },
  };
}

/** A stage (from the matter's template or its type) as the Tasks tab groups by it. */
export interface StageLike {
  id: string;
  title: string;
}

const fold = (value: string) => value.trim().toLowerCase();

/** Group names without blanks or repeats (ignoring case), first spelling kept, in the given order. */
export function uniqueGroups(names: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed || seen.has(fold(trimmed))) continue;
    seen.add(fold(trimmed));
    out.push(trimmed);
  }
  return out;
}

/**
 * Groups a matter's tasks (already in their manual order) by stage: a task whose `group` names a
 * stage (template tasks carry their stage's name) goes under it, in stage order. Other named groups
 * follow as their own sections (CORE-08e), in order of first appearance, and tasks without a group go
 * under "Other tasks". Empty stages are left out.
 */
export function sectionsByStage(entries: readonly TaskEntry[], stages: readonly StageLike[]): TaskSectionVm[] {
  const byName = new Map<string, StageLike>();
  for (const stage of stages) {
    byName.set(fold(stage.title), stage);
    byName.set(fold(stage.id), stage);
  }
  const sections = new Map<string, TaskSectionVm>(
    stages.map((stage) => [stage.id, { id: `stage:${stage.id}`, label: stage.title, entries: [], group: stage.title }]),
  );
  const groups = new Map<string, TaskSectionVm>();
  const other: TaskSectionVm = { id: 'stage:~other', label: 'Other tasks', entries: [], group: null };
  for (const entry of entries) {
    const name = entry.task.group?.trim();
    const stage = name ? byName.get(fold(name)) : undefined;
    if (stage) {
      (sections.get(stage.id) as TaskSectionVm).entries.push(entry);
    } else if (name) {
      let section = groups.get(fold(name));
      if (!section) {
        section = { id: `group:${fold(name)}`, label: name, entries: [], group: name };
        groups.set(fold(name), section);
      }
      section.entries.push(entry);
    } else {
      other.entries.push(entry);
    }
  }
  return [...sections.values(), ...groups.values(), other].filter((section) => section.entries.length);
}

/** Groups by the free-text `group`, in order of first appearance; "No group" last. */
export function sectionsByGroup(entries: readonly TaskEntry[]): TaskSectionVm[] {
  const sections = new Map<string, TaskSectionVm>();
  const none: TaskSectionVm = { id: 'group:~none', label: 'No group', entries: [], group: null };
  for (const entry of entries) {
    const name = entry.task.group?.trim();
    if (!name) {
      none.entries.push(entry);
      continue;
    }
    const key = fold(name);
    let section = sections.get(key);
    if (!section) {
      section = { id: `group:${key}`, label: name, entries: [], group: name };
      sections.set(key, section);
    }
    section.entries.push(entry);
  }
  return [...sections.values(), none].filter((section) => section.entries.length);
}

/** Tasks in their manual order (`byOrder`, ties by id). */
export function inOrder(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort(byOrder);
}

/** The order for a task added at the end of the list. */
export function orderAfterLast(tasks: readonly { order: number }[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.order), 0) + ORDER_STEP;
}

/** "Moved Lodge the inventory to position 2 of 5 in Grant application." */
export function moveAnnouncement(title: string, index: number, count: number, section: string): string {
  return `Moved ${title} to position ${index + 1} of ${count} in ${section}.`;
}

/** Changes to this many tasks go through `tasks-bulkUpdate`; fewer are written directly. */
export function usesBulkCallable(count: number): boolean {
  return count > TASK_CLIENT_BATCH_MAX;
}

/** How a bulk change is written to one task directly; null when there's nothing to write. */
export type ClientWrite =
  { kind: 'update'; patch: Record<string, unknown>; remove: string[] } | { kind: 'delete' } | null;

/** The direct write for one task (≤ `TASK_CLIENT_BATCH_MAX` selected), as `tasks-bulkUpdate` would do it. */
export function clientWrite(task: TaskRecord, change: BulkTaskChange): ClientWrite {
  switch (change.op) {
    case 'status':
      return task.status === change.status ? null : { kind: 'update', patch: { status: change.status }, remove: [] };
    case 'priority':
      return task.priority === change.priority
        ? null
        : { kind: 'update', patch: { priority: change.priority }, remove: [] };
    case 'assignee':
      // Personal tasks stay with their owner.
      if (!task.matterId || (task.assigneeUid ?? null) === change.assigneeUid) return null;
      return change.assigneeUid
        ? { kind: 'update', patch: { assigneeUid: change.assigneeUid }, remove: [] }
        : { kind: 'update', patch: {}, remove: ['assigneeUid'] };
    case 'dueDate':
      if ((task.dueDate ?? null) === change.dueDate) return null;
      return change.dueDate
        ? { kind: 'update', patch: { dueDate: change.dueDate }, remove: [] }
        : { kind: 'update', patch: {}, remove: ['dueDate'] };
    case 'group': {
      const group = change.group?.trim() || null;
      if ((task.group?.trim() || null) === group) return null;
      return group
        ? { kind: 'update', patch: { group }, remove: [] }
        : { kind: 'update', patch: {}, remove: ['group'] };
    }
    case 'delete':
      return { kind: 'delete' };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The toast after a bulk change: "3 tasks marked done", "2 tasks assigned to Priya Shah". */
export function bulkSummary(change: BulkTaskChange, count: number, personName?: string): string {
  const tasks = plural(count, 'task');
  switch (change.op) {
    case 'status':
      return change.status === 'done' ? `${tasks} marked done` : `${tasks} set to ${TASK_STATUS_LABELS[change.status]}`;
    case 'priority':
      return `${tasks} set to ${PRIORITY_NAMES[change.priority].toLowerCase()}`;
    case 'assignee':
      return change.assigneeUid ? `${tasks} assigned to ${personName ?? 'them'}` : `${tasks} unassigned`;
    case 'dueDate':
      return change.dueDate ? `Due date changed on ${tasks}` : `Due date cleared on ${tasks}`;
    case 'group':
      return change.group?.trim()
        ? `${tasks} moved to ${change.group.trim()}`
        : `${tasks} taken out of ${count === 1 ? 'its' : 'their'} group`;
    case 'delete':
      return `${tasks} deleted`;
  }
}

/** A date typed as DD/MM/YYYY (or YYYY-MM-DD); null when it isn't a real date. */
export function parseDueInput(text: string): DateOnly | null {
  const trimmed = text.trim();
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  const iso = local
    ? `${local[3]}-${(local[2] ?? '').padStart(2, '0')}-${(local[1] ?? '').padStart(2, '0')}`
    : /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? trimmed
      : null;
  const parsed = iso ? DateOnlySchema.safeParse(iso) : null;
  return parsed?.success ? parsed.data : null;
}

/** A date as the due date field starts it: `09/10/2026`. */
export function formatDueInput(date: DateOnly | undefined | null): string {
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}
