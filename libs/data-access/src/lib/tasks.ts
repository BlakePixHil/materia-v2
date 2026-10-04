import { inject } from '@angular/core';
import { z } from 'zod';

import {
  chunkWrites,
  DomainError,
  MatterTaskCreateInput,
  OPEN_TASK_STATUSES,
  PersonalTask,
  PersonalTaskCreateInput,
  SoftDeleteShape,
  Task,
  TASK_CALLABLES,
  type BulkUpdateTasksInput,
  type BulkUpdateTasksResult,
  type OrderUpdate,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

const task = Task.schema.shape;

/**
 * A task as the Tasks tab and My tasks read it (CORE-08): matter tasks and personal tasks
 * (`matterId: null`) alike. Other fields are dropped, not rejected.
 */
export const TaskItemSchema = /* @__PURE__ */ z.object({
  orgId: task.orgId.optional(),
  /** `null` for a personal task. */
  matterId: task.matterId.nullable().optional(),
  title: task.title,
  descriptionMd: task.descriptionMd,
  status: task.status,
  priority: task.priority,
  assigneeUid: task.assigneeUid,
  dueDate: task.dueDate,
  deadlineId: task.deadlineId,
  group: task.group,
  checklist: task.checklist,
  order: task.order,
  source: task.source,
  completedAt: task.completedAt,
  /** Template tasks (CORE-07): `tpl-{key}` ids, and the event a pending due date waits for. */
  templateTaskKey: task.templateTaskKey,
  duePending: task.duePending,
  createdAt: task.createdAt.optional(),
  updatedAt: task.updatedAt.optional(),
  updatedBy: task.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

/** What the quick-add line or a form gives a new task; the repository adds org, matter and source. */
export type NewTaskFields = Omit<
  z.input<typeof MatterTaskCreateInput>,
  'orgId' | 'matterId' | 'source' | 'countedOpen'
>;

/**
 * A matter's tasks (`orgs/{orgId}/matters/{matterId}/tasks`, CORE-08): live queries, client-direct
 * creates (`create(fields)` adds `orgId`, `matterId`, `source: 'manual'` and `countedOpen: false`,
 * which the rules require), updates of the whitelisted fields (`Task.update`: title, status,
 * priority, assigneeUid, dueDate, checklist, order, group; clear `dueDate`/`assigneeUid` with
 * `{ remove: [...] }`) and soft deletes. Offline writes queue and sync later.
 */
export function matterTaskRepository(matterId: () => string | null): Repository<TaskItem> {
  const context = inject(OrgContext);
  const base = repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/tasks`, {
    schema: TaskItemSchema,
    version: Task.version,
    create: MatterTaskCreateInput,
    update: Task.update,
  });
  return {
    ...base,
    create: (fields, options) => {
      const id = matterId();
      if (!id)
        return Promise.reject(
          new DomainError('INVALID_ARGUMENT', 'No matter to add the task to', { field: 'matterId' }),
        );
      return base.create({ ...fields, orgId: context.requireOrgId(), matterId: id }, options);
    },
  };
}

/**
 * The signed-in member's personal tasks (`orgs/{orgId}/members/{uid}/tasks`): private to them.
 * `create(fields)` adds `orgId`, `matterId: null` and the member as the assignee.
 */
export function personalTaskRepository(): Repository<TaskItem> {
  const context = inject(OrgContext);
  const base = repo((orgId) => `orgs/${orgId}/members/${context.uid() ?? '-'}/tasks`, {
    schema: TaskItemSchema,
    version: PersonalTask.version,
    create: PersonalTaskCreateInput,
    update: PersonalTask.update,
  });
  return {
    ...base,
    create: (fields, options) =>
      base.create({ ...fields, orgId: context.requireOrgId(), assigneeUid: context.requireUid() }, options),
  };
}

/**
 * Tasks across the org (the `tasks` collection group, scoped to the active org). Through the group
 * every member reads the tasks assigned to them, personal ones included; only roles with
 * privileged.view read other people's (ADR-026). Writes go through `matterTaskRepository` or
 * `personalTaskRepository` by the row's `matterId`.
 */
export function taskGroupRepository(): GroupRepository<TaskItem> {
  return groupRepo('tasks', { schema: TaskItemSchema, version: Task.version });
}

/** A matter's tasks in their manual order (the Tasks tab groups and filters them). */
export const MATTER_TASKS_QUERY: QuerySpec<TaskItem> = { orderBy: [['order', 'asc']], pageSize: 500 };

/**
 * My open tasks across every matter plus my personal tasks (indexed: orgId, assigneeUid, status).
 * No `orderBy`: tasks without a due date must come too; `sectionMyTasks` sorts them.
 */
export const myOpenTasksQuery = (uid: string): QuerySpec<TaskItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', 'in', [...OPEN_TASK_STATUSES]],
  ],
  pageSize: 500,
});

/**
 * Writes new orders (`planMove`) through a repository in chunks of `size` concurrent updates, so a
 * 500-task rebalance doesn't open 500 writes at once. Each update is a whitelisted `order` change.
 */
export async function writeTaskOrders(
  tasks: Pick<Repository<TaskItem>, 'update'>,
  updates: readonly OrderUpdate[],
  size = 50,
): Promise<void> {
  for (const batch of chunkWrites(updates, size)) {
    await Promise.all(batch.map((update) => tasks.update(update.id, { order: update.order })));
  }
}

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The `tasks-*` callables (CORE-08). */
export interface TaskCallables {
  /**
   * `tasks-bulkUpdate`: one change to up to 500 tasks (use it above `TASK_CLIENT_BATCH_MAX`).
   * PERMISSION_DENIED without task.edit for matter tasks; INVALID_ARGUMENT on `change.assigneeUid`
   * for an assignee who isn't an active member. Skipped tasks come back with a reason.
   */
  bulkUpdate(input: Input<BulkUpdateTasksInput>): Promise<BulkUpdateTasksResult>;
}

export function taskCallables(client: Pick<CallableClient, 'call'>): TaskCallables {
  return {
    bulkUpdate: (input) =>
      client.call<Input<BulkUpdateTasksInput>, BulkUpdateTasksResult>(TASK_CALLABLES.bulkUpdate, input, {
        idempotent: true,
      }),
  };
}
