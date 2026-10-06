import { FieldValue, type Firestore, type QueryDocumentSnapshot, type Transaction } from 'firebase-admin/firestore';

import {
  keyFactEventsSet,
  pendingTaskDue,
  today,
  type AnchorContext,
  type DateOnly,
  type EventKind,
  type FactMatter,
  type Template,
} from '@materia/domain';

import { anchorContext, orgTimeZone, readEvents, readTemplate, readWith } from './shared';
import { isDeleted } from '../contacts/shared';
import { orgClock } from '../core/emulator-clock';
import type { Log } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { matterPath } from '../matters/shared';
import type { Clock } from '../ports';

type Data = Record<string, unknown>;

/** A pending template due date to fill (CORE-07b). */
export interface PendingFill {
  taskId: string;
  dueDate: DateOnly;
}

export interface PendingFillPlan {
  fills: PendingFill[];
  /** Does the writes, with the caller's `updatedAt`/`updatedBy` stamp. */
  write: (stamp: Data) => void;
}

/**
 * Plans filling the due dates of a matter's template tasks waiting on `kinds` (`duePending`),
 * now that those events are known (CORE-07b): each open task's date comes from its template
 * task's due rule in the matter's template version (`pendingTaskDue`, the same DateOnly maths as
 * creation), and `duePending` is cleared. Done, cancelled and deleted tasks, and tasks that have a
 * `dueDate` (set by hand), are left alone, so re-running finds nothing to do. Reads first, so call
 * it before any other write in the transaction.
 */
export async function planPendingFills(
  db: Firestore,
  tx: Transaction,
  args: {
    orgId: string;
    matterId: string;
    kinds: readonly EventKind[];
    template: Template | undefined;
    ctx: AnchorContext;
    stageEnteredOn: DateOnly;
  },
): Promise<PendingFillPlan> {
  const { orgId, matterId, kinds, template, ctx, stageEnteredOn } = args;
  const tasks = db.collection(`${matterPath(orgId, matterId)}/tasks`);
  const unique = [...new Set(kinds)];
  const snaps = await Promise.all(unique.map((kind) => tx.get(tasks.where('duePending', '==', kind))));
  const fills: (PendingFill & { doc: QueryDocumentSnapshot })[] = [];
  unique.forEach((kind, i) => {
    for (const doc of snaps[i]?.docs ?? []) {
      const task = doc.data();
      const definition = template?.tasks.find((t) => t.key === task['templateTaskKey']);
      const dueDate = pendingTaskDue(task, definition, kind, ctx, stageEnteredOn);
      if (dueDate) fills.push({ taskId: doc.id, dueDate, doc });
    }
  });
  return {
    fills: fills.map(({ taskId, dueDate }) => ({ taskId, dueDate })),
    write: (stamp) => {
      for (const { doc, dueDate } of fills) {
        tx.update(doc.ref, { dueDate, duePending: FieldValue.delete(), ...stamp });
      }
    },
  };
}

export interface FillPendingRequest {
  orgId: string;
  matterId: string;
  kinds: readonly EventKind[];
  /** The org's clock (pinned in the emulator by `emulatorClock/{orgId}`). */
  clock: Clock;
  log: Log;
}

/**
 * Fills the pending template due dates of a live matter for `kinds` in one transaction (CORE-07b),
 * as `system`. Returns the filled task ids (none when the matter is gone, has no template, or
 * nothing is waiting): idempotent.
 */
export async function fillPendingDueDates(db: Firestore, request: FillPendingRequest): Promise<string[]> {
  const { orgId, matterId, kinds, clock, log } = request;
  if (!kinds.length) return [];
  const timeZone = await orgTimeZone(db, orgId);
  const ref = db.doc(matterPath(orgId, matterId));
  const filled = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const matter = snap.data();
    if (!snap.exists || !matter || isDeleted(matter)) return [];
    const templateId = matter['templateId'];
    const version = matter['templateVersion'];
    if (typeof templateId !== 'string' || !templateId) return [];
    const template = await readTemplate(
      db,
      readWith(tx),
      orgId,
      templateId,
      typeof version === 'number' && version >= 1 ? version : undefined,
    );
    if (!template) return [];
    const now = clock.now();
    const plan = await planPendingFills(db, tx, {
      orgId,
      matterId,
      kinds,
      template,
      ctx: anchorContext(matter, await readEvents(db, tx, orgId, matterId)),
      stageEnteredOn: (matter['stageEnteredOn'] as DateOnly | undefined) ?? today(timeZone, now),
    });
    plan.write({ updatedAt: now, updatedBy: 'system' });
    return plan.fills.map((fill) => fill.taskId);
  });
  log.info('pending due dates filled', { matterId, kinds: [...kinds], filled: filled.length });
  return filled;
}

/**
 * Part of `matters-denormalise` (CORE-07b): when a matter write sets or changes a key fact that
 * stands for an event (`deceased.dateOfDeath`, `estate.grantDate`), fills the due dates of the
 * template tasks waiting on that event. Recording the event (`deadlines-upsertEvent`) fills them
 * in its own transaction; this covers the fact being edited on the matter directly. Its own task
 * writes don't touch the matter, so it doesn't loop.
 */
export async function fillFromKeyFacts(change: TriggerChange, ctx: TriggerContext): Promise<string[]> {
  const after = change.after?.data() as Data | undefined;
  if (!after || isDeleted(after)) return [];
  const before = change.before?.data() as Data | undefined;
  const kinds = keyFactEventsSet(before as FactMatter | undefined, after as FactMatter);
  if (!kinds.length) return [];
  const orgId = ctx.params['orgId'] as string;
  return fillPendingDueDates(ctx.db, {
    orgId,
    matterId: ctx.params['matterId'] as string,
    kinds,
    clock: await orgClock(ctx.db, orgId, ctx.clock),
    log: ctx.log,
  });
}
