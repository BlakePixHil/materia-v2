import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import { nextDeadlineOf, type DeadlineLike, type NextDeadline } from '@materia/domain';

import { deadlinesPath } from './shared';
import { orgClock } from '../core/emulator-clock';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { matterPath } from '../matters/shared';
import { reminderCalendar, scheduleChanged, scheduleDeadline } from '../reminders/schedule';

type Data = Record<string, unknown>;

const same = (a: unknown, b: NextDeadline | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function asRow(id: string, data: Data): DeadlineLike {
  return {
    id,
    title: typeof data['title'] === 'string' ? data['title'] : '',
    dueDate: typeof data['dueDate'] === 'string' ? data['dueDate'] : undefined,
    dueTime: typeof data['dueTime'] === 'string' ? data['dueTime'] : undefined,
    kind: String(data['kind'] ?? ''),
    critical: data['critical'] === true,
    status: data['status'] as DeadlineLike['status'],
    deletedAt: data['deletedAt'],
  };
}

/**
 * Brings a matter's `nextDeadline` ({id, dueDate, title, critical}) up to date with its deadlines
 * (`nextDeadlineOf`: the soonest live upcoming deadline with a date), removing it when there is
 * none. One transaction reads the matter and all its deadlines, so concurrent events converge;
 * nothing is written when the value is already current. Returns the value, or null when the
 * matter is gone.
 */
export async function syncNextDeadline(
  db: Firestore,
  orgId: string,
  matterId: string,
): Promise<{ next: NextDeadline | undefined; written: boolean } | null> {
  const matterRef = db.doc(matterPath(orgId, matterId));
  return db.runTransaction(async (tx) => {
    const matter = await tx.get(matterRef);
    if (!matter.exists) return null;
    const deadlines = await tx.get(db.collection(deadlinesPath(orgId, matterId)));
    const next = nextDeadlineOf(deadlines.docs.map((doc) => asRow(doc.id, doc.data())));
    if (same(matter.get('nextDeadline'), next)) return { next, written: false };
    tx.update(matterRef, { nextDeadline: next ?? FieldValue.delete() });
    return { next, written: true };
  });
}

/**
 * `deadlines-onWrite` (CORE-10), on every write of `orgs/{orgId}/matters/{matterId}/deadlines/{id}`:
 * denormalises the matter's `nextDeadline` for the matters list and dashboard, and (CORE-11) sets
 * the deadline's `nextReminderAt` when its date, criticality, reminders or status changed.
 */
export async function onDeadlineWrite(ctx: TriggerContext, change?: TriggerChange): Promise<void> {
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const before = change?.before?.data();
  const after = change?.after?.data();
  if (change?.after?.exists && scheduleChanged(before, after)) {
    const scheduled = await scheduleDeadline(
      ctx.db,
      change.after.ref,
      await reminderCalendar(ctx.db, orgId),
      (await orgClock(ctx.db, orgId, ctx.clock)).now(),
      {
        dateMoved: !!before && before['dueDate'] !== after?.['dueDate'],
      },
    );
    ctx.log.info('reminders scheduled', {
      matterId,
      deadlineId: ctx.params['deadlineId'],
      nextReminderAt: scheduled.nextReminderAt?.toISOString() ?? null,
      written: scheduled.written,
    });
  }
  const result = await syncNextDeadline(ctx.db, orgId, matterId);
  ctx.log.info('next deadline synced', {
    matterId,
    deadlineId: ctx.params['deadlineId'],
    written: result?.written ?? false,
    nextId: result?.next?.id ?? null,
  });
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'deadlines-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/deadlines/{deadlineId}',
  on: 'written',
  handler: async (change, ctx) => onDeadlineWrite(ctx, change),
};

export const onWrite = defineTrigger(onWriteDefinition);
