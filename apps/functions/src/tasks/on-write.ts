import { FieldValue } from 'firebase-admin/firestore';

import { Activity } from '@materia/domain';

import {
  activitySummary,
  actorOf,
  assignmentRecipient,
  completionPatch,
  planTaskSync,
  REMOVE,
  taskActivityKinds,
  type TaskSyncPlan,
} from './shared';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { recordMatterActivity } from '../matters/denormalise';
import { matterPath } from '../matters/shared';
import { notify } from '../notifications/notify';

type Data = Record<string, unknown>;

const toWrite = (patch: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value === REMOVE ? FieldValue.delete() : value]),
  );

export interface TaskWriteOutcome {
  countDelta: TaskSyncPlan['countDelta'];
  patched: string[];
  notified: string | null;
  activity: string[];
}

/**
 * `tasks-onWrite` (CORE-08), on every write of `orgs/{orgId}/matters/{matterId}/tasks/{taskId}`:
 *
 * 1. In one transaction on the task, brings `countedOpen`, `completedAt` and the matter's
 *    `openTaskCount` (a server increment) in line with the task's current state (`planTaskSync`).
 *    The transaction reads the task again, so concurrent and out-of-order events converge on the
 *    exact count; its own write plans nothing next time, so it doesn't loop.
 * 2. Notifies a new assignee (`task_assigned` in-app notification, one per event).
 * 3. Writes the matter's activity feed (created, completed, reopened, assigned, deleted, restored)
 *    and moves the matter's `lastActivityAt` forward.
 */
export async function syncTask(change: TriggerChange, ctx: TriggerContext): Promise<TaskWriteOutcome> {
  const { db, log, eventId } = ctx;
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const taskId = ctx.params['taskId'] as string;
  const before = change.before?.data() as Data | undefined;
  const after = change.after?.data() as Data | undefined;
  const taskRef = db.doc(`${matterPath(orgId, matterId)}/tasks/${taskId}`);
  const matterRef = db.doc(matterPath(orgId, matterId));
  const matter = await matterRef.get();

  const plan = await db.runTransaction(async (tx) => {
    const current = await tx.get(taskRef);
    const next = planTaskSync(current.exists ? (current.data() as Data) : undefined, before, ctx.time);
    if (next.countDelta && matter.exists)
      tx.update(matterRef, { openTaskCount: FieldValue.increment(next.countDelta) });
    if (current.exists && Object.keys(next.patch).length) tx.update(taskRef, toWrite(next.patch));
    return next;
  });

  const actorUid = actorOf(before, after);
  const title = typeof after?.['title'] === 'string' ? after['title'] : String(before?.['title'] ?? 'Task');
  const now = ctx.clock.now();
  const meta = { createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' };

  let notified: string | null = null;
  const recipient = matter.exists ? assignmentRecipient(before, after) : null;
  if (recipient) {
    // notify() leaves out anyone who is no longer an active member (FND-20).
    const number = matter.get('number');
    const sent = await notify(
      { db, orgId, clock: ctx.clock, log, ports: ctx.ports },
      {
        kind: 'task_assigned',
        taskId,
        matterId,
        recipients: [recipient],
        title: 'Task assigned to you',
        body: typeof number === 'string' && number ? `${title} · ${number}` : title,
        link: `/matters/${matterId}/tasks`,
        key: `task-${eventId}`,
      },
    );
    if (sent.ids.length) notified = recipient;
  }

  const kinds = matter.exists ? taskActivityKinds(before, after) : [];
  for (const kind of kinds) {
    const assignee = after?.['assigneeUid'];
    const activity = Activity.schema.parse({
      kind,
      summary: activitySummary(kind, title),
      actorUid,
      at: ctx.time,
      refs: { taskId, ...(kind === 'task.assigned' && typeof assignee === 'string' ? { assigneeUid: assignee } : {}) },
      ...meta,
      schemaVersion: Activity.version,
    });
    await db.doc(`${matterPath(orgId, matterId)}/activity/${eventId}-${kind.replace('.', '-')}`).set(activity);
  }
  if (kinds.length) await recordMatterActivity(db, orgId, matterId, ctx.time);

  const outcome = { countDelta: plan.countDelta, patched: Object.keys(plan.patch), notified, activity: kinds };
  log.info('task synced', { matterId, taskId, ...outcome, notified: !!notified });
  return outcome;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'tasks-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/tasks/{taskId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncTask(change, ctx)),
};

/**
 * `tasks-onPersonalWrite` (CORE-08): a personal task's `completedAt` follows its status, as a
 * matter task's does. Personal tasks have no matter, count, notification or activity.
 */
export async function syncPersonalTask(change: TriggerChange, ctx: TriggerContext): Promise<string[]> {
  if (!change.after) return [];
  const ref = ctx.db.doc(change.after.ref.path);
  const patched = await ctx.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return [];
    const patch = completionPatch(current.data() as Data, ctx.time);
    if (Object.keys(patch).length) tx.update(ref, toWrite(patch));
    return Object.keys(patch);
  });
  ctx.log.info('personal task synced', { taskId: ctx.params['taskId'], patched });
  return patched;
}

export const onPersonalWriteDefinition: TriggerDefinition = {
  name: 'tasks-onPersonalWrite',
  document: 'orgs/{orgId}/members/{uid}/tasks/{taskId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncPersonalTask(change, ctx)),
};

export const onWrite = defineTrigger(onWriteDefinition);
export const onPersonalWrite = defineTrigger(onPersonalWriteDefinition);
