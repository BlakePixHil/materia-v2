import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import {
  BulkUpdateTasksInput,
  can,
  chunkWrites,
  DomainError,
  matterTaskPath,
  personalTaskPath,
  ROLES,
  taskRefKey,
  type BulkSkipReason,
  type BulkTaskChange,
  type BulkUpdateTasksResult,
  type TaskRef,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { writableMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** Writes per batch (a Firestore batch takes 500). */
export const BULK_BATCH_SIZE = 250;

/** The field changes for one task, or why it is left alone. */
export function bulkPatch(
  task: Data,
  change: BulkTaskChange,
  personal: boolean,
): { patch: Data } | { skip: BulkSkipReason } {
  if (isDeleted(task)) return { skip: 'deleted' };
  switch (change.op) {
    case 'status':
      return task['status'] === change.status ? { skip: 'unchanged' } : { patch: { status: change.status } };
    case 'priority':
      return task['priority'] === change.priority ? { skip: 'unchanged' } : { patch: { priority: change.priority } };
    case 'assignee':
      // A personal task always belongs to its owner.
      if (personal) return { skip: 'personal_assignee' };
      if ((task['assigneeUid'] ?? null) === change.assigneeUid) return { skip: 'unchanged' };
      return { patch: { assigneeUid: change.assigneeUid ?? FieldValue.delete() } };
    case 'dueDate':
      if ((task['dueDate'] ?? null) === change.dueDate) return { skip: 'unchanged' };
      return { patch: { dueDate: change.dueDate ?? FieldValue.delete() } };
    case 'group': {
      const group = change.group?.trim() || null;
      if (((task['group'] as string | undefined)?.trim() || null) === group) return { skip: 'unchanged' };
      return { patch: { group: group ?? FieldValue.delete() } };
    }
    case 'delete':
      // The caller stamps deletedAt and deletedBy.
      return { patch: {} };
  }
}

/**
 * `tasks-bulkUpdate` (CORE-08; idempotent): one change (status, assignee, due date, priority,
 * group or soft delete) to up to 500 tasks, for selections larger than the client writes itself
 * (`TASK_CLIENT_BATCH_MAX`). Matter tasks need `task.edit` (PERMISSION_DENIED otherwise) and a
 * live matter the caller can see; personal tasks (`matterId: null`) are the caller's own. A new
 * assignee must be an active member (INVALID_ARGUMENT on `change.assigneeUid`). Tasks that are
 * missing, deleted, on an unavailable matter or already so are skipped and listed. The writes go
 * in batches stamped with the request id (the audit trigger links each to the call), and
 * `tasks-onWrite` updates counts, completion, notifications and activity per task.
 */
export const bulkUpdateDefinition = {
  name: 'tasks-bulkUpdate',
  input: BulkUpdateTasksInput,
  // Everyone may bulk-edit their own personal tasks; matter tasks are checked below.
  roles: ROLES,
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, requestId, clock, log }): Promise<BulkUpdateTasksResult> => {
    const matterIds = [...new Set(input.tasks.flatMap((ref) => (ref.matterId ? [ref.matterId] : [])))];
    if (matterIds.length && !can(role, 'task.edit')) {
      throw new DomainError('PERMISSION_DENIED', 'Your role can’t edit matter tasks', { action: 'task.edit' });
    }
    const { change } = input;
    if (change.op === 'assignee' && change.assigneeUid) {
      const member = await db.doc(`orgs/${orgId}/members/${change.assigneeUid}`).get();
      if (member.get('status') !== 'active') {
        throw new DomainError('INVALID_ARGUMENT', 'The assignee isn’t an active member', {
          field: 'change.assigneeUid',
        });
      }
    }

    const matterSnaps = matterIds.length
      ? await db.getAll(...matterIds.map((id) => db.doc(matterPath(orgId, id))))
      : [];
    const available = new Set(
      matterSnaps
        .filter((snap) => {
          try {
            writableMatter(snap, role, snap.id);
            return true;
          } catch {
            return false;
          }
        })
        .map((snap) => snap.id),
    );

    const refFor = (ref: TaskRef): DocumentReference =>
      db.doc(ref.matterId ? matterTaskPath(orgId, ref.matterId, ref.taskId) : personalTaskPath(orgId, uid, ref.taskId));
    const skipped: BulkUpdateTasksResult['skipped'] = [];
    const reachable = input.tasks.filter((ref) => {
      if (ref.matterId && !available.has(ref.matterId)) {
        skipped.push({ ...ref, reason: 'matter_unavailable' });
        return false;
      }
      return true;
    });
    const snaps = reachable.length ? await db.getAll(...reachable.map(refFor)) : [];

    const now = clock.now();
    const writes: { ref: DocumentReference; patch: Data }[] = [];
    reachable.forEach((ref, i) => {
      const snap = snaps[i];
      if (!snap?.exists) {
        skipped.push({ ...ref, reason: 'not_found' });
        return;
      }
      const planned = bulkPatch(snap.data() as Data, change, ref.matterId === null);
      if ('skip' in planned) {
        skipped.push({ ...ref, reason: planned.skip });
        return;
      }
      const patch = change.op === 'delete' ? { deletedAt: now, deletedBy: uid } : planned.patch;
      writes.push({ ref: snap.ref, patch: { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId } });
    });

    for (const batchWrites of chunkWrites(writes, BULK_BATCH_SIZE)) {
      const batch = db.batch();
      for (const write of batchWrites) batch.update(write.ref, write.patch);
      await batch.commit();
    }
    const order = new Map(input.tasks.map((ref, i) => [taskRefKey(ref), i]));
    skipped.sort((a, b) => (order.get(taskRefKey(a)) ?? 0) - (order.get(taskRefKey(b)) ?? 0));
    log.info('bulk update', {
      op: change.op,
      requested: input.tasks.length,
      updated: writes.length,
      skipped: skipped.length,
    });
    return { updated: writes.length, skipped };
  },
} satisfies CallableDefinition<typeof BulkUpdateTasksInput, BulkUpdateTasksResult>;

export const bulkUpdate = defineCallable(bulkUpdateDefinition);
