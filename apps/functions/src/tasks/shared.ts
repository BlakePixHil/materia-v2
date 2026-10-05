import { isOpenTask } from '@materia/domain';

/** Shared helpers for the tasks functions (CORE-08). */

type Data = Record<string, unknown>;

/** Marks a field for deletion in a plan (the trigger turns it into `FieldValue.delete()`). */
export const REMOVE = Symbol('remove');

export interface TaskSyncPlan {
  /** What to add to the matter's `openTaskCount`. */
  countDelta: -1 | 0 | 1;
  /** Server-owned task fields to write (`REMOVE` deletes the field). */
  patch: Record<string, unknown>;
}

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] === undefined || data['deletedAt'] === null);

/**
 * Whether a task is counted in its matter's `openTaskCount` now. `countedOpen` says so for every
 * task written since CORE-08 (client creates write `false`, server writers that count a task
 * themselves write `true`, and this trigger keeps it). A task without it predates CORE-08 and was
 * counted when open (CORE-07 counted its template tasks, the seed its open tasks), so the state
 * before this event decides; a create without it was counted by nobody.
 */
export function wasCounted(current: Data | undefined, before: Data | undefined): boolean {
  const marker = current?.['countedOpen'];
  if (typeof marker === 'boolean') return marker;
  return before ? isOpenTask(before) : false;
}

/**
 * The writes that bring a matter task and its matter's `openTaskCount` up to date with the task's
 * current state (read in a transaction): +1 or -1 when its open state and `countedOpen` disagree,
 * `completedAt` (the event time) when it is done without one, and `completedAt` removed when it is
 * no longer done. Converges: run again on the result, it plans nothing, so concurrent and
 * out-of-order events leave the count exact. `current` undefined is a hard-deleted task.
 */
export function planTaskSync(current: Data | undefined, before: Data | undefined, time: Date): TaskSyncPlan {
  if (!current) {
    const counted = typeof before?.['countedOpen'] === 'boolean' ? before['countedOpen'] === true : isOpenTask(before);
    return { countDelta: counted ? -1 : 0, patch: {} };
  }
  const patch: Record<string, unknown> = {};
  const open = isOpenTask(current);
  const counted = wasCounted(current, before);
  if (current['countedOpen'] !== open) patch['countedOpen'] = open;
  Object.assign(patch, completionPatch(current, time));
  return { countDelta: open === counted ? 0 : open ? 1 : -1, patch };
}

/** `completedAt` follows the status: set on done, removed on reopen (matter and personal tasks). */
export function completionPatch(current: Data, time: Date): Record<string, unknown> {
  const completed = current['completedAt'] !== undefined && current['completedAt'] !== null;
  if (current['status'] === 'done' && !completed) return { completedAt: time };
  if (current['status'] !== 'done' && completed) return { completedAt: REMOVE };
  return {};
}

export type TaskActivityKind =
  | 'task.created'
  | 'task.completed'
  | 'task.reopened'
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.deleted'
  | 'task.restored';

/**
 * What a task write means for the matter's activity feed (CORE-08). Template, migrated and rule (CORE-10) tasks
 * appear in bulk with the matter or a stage, so their creation isn't listed; ordering, titles,
 * dates and checklists aren't activity.
 */
export function taskActivityKinds(before: Data | undefined, after: Data | undefined): TaskActivityKind[] {
  if (!after) return [];
  if (!before) {
    const source = after['source'];
    if (source === 'template' || source === 'migration' || source === 'rule') return [];
    return isLive(after) ? ['task.created'] : [];
  }
  const kinds: TaskActivityKind[] = [];
  const wasLive = isLive(before);
  const live = isLive(after);
  if (wasLive && !live) return ['task.deleted'];
  if (!wasLive && live) kinds.push('task.restored');
  if (!live) return kinds;
  if (before['status'] !== 'done' && after['status'] === 'done') kinds.push('task.completed');
  if (before['status'] === 'done' && after['status'] !== 'done' && after['status'] !== 'cancelled') {
    kinds.push('task.reopened');
  }
  const assignee = after['assigneeUid'];
  if (assignee !== before['assigneeUid']) kinds.push(assignee ? 'task.assigned' : 'task.unassigned');
  return kinds;
}

/** The feed line for an activity kind, naming the task by its title. */
export function activitySummary(kind: TaskActivityKind, title: string): string {
  const quoted = `“${title}”`;
  switch (kind) {
    case 'task.created':
      return `Added task ${quoted}`;
    case 'task.completed':
      return `Completed ${quoted}`;
    case 'task.reopened':
      return `Reopened ${quoted}`;
    case 'task.assigned':
      return `Assigned ${quoted}`;
    case 'task.unassigned':
      return `Unassigned ${quoted}`;
    case 'task.deleted':
      return `Deleted task ${quoted}`;
    case 'task.restored':
      return `Restored task ${quoted}`;
  }
}

/**
 * Who to notify about an assignment (CORE-08, the `task_assigned` notification): the new assignee
 * of a live, open task, unless they assigned it to themselves. Template, migrated and rule tasks created
 * in bulk with a matter or stage don't notify; reassigning them later does.
 */
export function assignmentRecipient(before: Data | undefined, after: Data | undefined): string | null {
  if (!after || !isLive(after) || !isOpenTask(after)) return null;
  const assignee = after['assigneeUid'];
  if (typeof assignee !== 'string' || !assignee) return null;
  if (before?.['assigneeUid'] === assignee) return null;
  if (!before && ['template', 'migration', 'rule'].includes(String(after['source']))) return null;
  if (actorOf(before, after) === assignee) return null;
  return assignee;
}

/** Who made the write: the last editor, else the creator, else the system. */
export function actorOf(before: Data | undefined, after: Data | undefined): string {
  const by = after?.['updatedBy'] ?? after?.['createdBy'] ?? before?.['updatedBy'];
  return typeof by === 'string' && by ? by : 'system';
}
