import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  archiveCutoff,
  dateOnlyAt,
  laterDestroyAfter,
  retentionDate,
  today as todayIn,
  type DateOnly,
} from '@materia/domain';

import { readRetentionSettings, retentionSettings } from './closing';
import { destructionRequestPath } from './reopen';
import { mattersPath } from './shared';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { createLog, functionsSink, type Log } from '../core/log';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

/*
 * Retention housekeeping (CORE-19): the nightly `matters-archiveClosed` archives matters closed 90
 * days ago or more (read-only from then on), and `matters-onRetentionChanged` moves destruction
 * dates later when an org lengthens its retention period (never earlier).
 */

const toDate = (value: unknown): Date | undefined =>
  value && typeof (value as { toDate?: unknown }).toDate === 'function'
    ? (value as { toDate: () => Date }).toDate()
    : value instanceof Date
      ? value
      : undefined;

/** Firestore batches hold at most 500 writes. */
const BATCH = 400;

/** Archives one org's matters closed on or before the cutoff day. Returns the ids archived. */
export async function archiveOrg(db: Firestore, orgId: string, baseClock: Clock, log: Log): Promise<string[]> {
  const now = (await orgClock(db, orgId, baseClock)).now();
  const { timeZone } = await readRetentionSettings(db, orgId);
  const cutoff = archiveCutoff(todayIn(timeZone, now));
  // Closed matters are few; filtering here avoids a composite index on (status, closedAt).
  const closed = await db.collection(mattersPath(orgId)).where('status', '==', 'closed').get();
  const due = closed.docs.filter((doc) => {
    const closedAt = toDate(doc.get('closedAt'));
    return !isDeleted(doc.data()) && !!closedAt && dateOnlyAt(closedAt, timeZone) <= cutoff;
  });
  for (let start = 0; start < due.length; start += BATCH) {
    const batch = db.batch();
    for (const doc of due.slice(start, start + BATCH)) {
      batch.update(doc.ref, { status: 'archived', archivedAt: now, updatedAt: now, updatedBy: 'system' });
    }
    await batch.commit();
  }
  if (due.length) log.info('matters archived', { orgId, count: due.length });
  return due.map((doc) => doc.id);
}

/** Every live org; one org's failure doesn't stop the others. */
export async function archiveAllOrgs(
  db: Firestore,
  clock: Clock,
  log: Log,
): Promise<{ orgs: number; archived: number; failed: number }> {
  const orgs = await db.collection('orgs').get();
  let archived = 0;
  let failed = 0;
  let count = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    count += 1;
    try {
      archived += (await archiveOrg(db, org.id, clock, log)).length;
    } catch (error) {
      failed += 1;
      log.error('archive failed', { orgId: org.id, errorType: error instanceof Error ? error.name : typeof error });
    }
  }
  return { orgs: count, archived, failed };
}

/** `matters-archiveClosed` (CORE-19): nightly at 02:15 Melbourne time. */
export const archiveClosed = onSchedule(
  { schedule: '15 2 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 1 },
  async () => {
    const log = createLog({ fn: 'matters-archiveClosed' }, functionsSink);
    log.info('ok', await archiveAllOrgs(adminDb(), systemClock, log));
  },
);

/**
 * When an org's `retentionYears` changes, each closed or archived matter's `destroyAfter` is
 * recomputed from its closing day and moved only if the new date is later; a queued destruction
 * that is no longer due is cancelled. A shorter period changes nothing: an earlier date needs an
 * explicit admin action. Returns the ids moved.
 */
export async function applyRetentionChange(db: Firestore, orgId: string, now: Date, log: Log): Promise<string[]> {
  const { timeZone, retentionYears } = retentionSettings((await db.doc(`orgs/${orgId}`).get()).data());
  const today = todayIn(timeZone, now);
  const matters = await db.collection(mattersPath(orgId)).where('status', 'in', ['closed', 'archived']).get();
  const moved: string[] = [];
  let batch = db.batch();
  let writes = 0;
  for (const doc of matters.docs) {
    const current = doc.get('destroyAfter') as DateOnly | undefined;
    const closedAt = toDate(doc.get('closedAt'));
    if (isDeleted(doc.data()) || doc.get('destroyedAt') || !current || !closedAt) continue;
    const later = laterDestroyAfter(current, retentionDate(dateOnlyAt(closedAt, timeZone), retentionYears));
    if (!later) continue;
    batch.update(doc.ref, { destroyAfter: later, updatedAt: now, updatedBy: 'system' });
    const queued = await db.doc(destructionRequestPath(orgId, doc.id)).get();
    if (queued.get('status') === 'pending' && later >= today) {
      batch.update(queued.ref, {
        status: 'cancelled',
        cancelledReason: 'not_due',
        updatedAt: now,
        updatedBy: 'system',
      });
      writes += 1;
    }
    moved.push(doc.id);
    writes += 1;
    if (writes >= BATCH) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }
  if (writes) await batch.commit();
  if (moved.length) log.info('destruction dates moved later', { orgId, count: moved.length });
  return moved;
}

export async function onRetentionUpdate(change: TriggerChange, ctx: TriggerContext): Promise<void> {
  const before = change.before?.data();
  const after = change.after?.data();
  if (!before || !after || before['retentionYears'] === after['retentionYears']) return;
  const orgId = ctx.params['orgId'] as string;
  await applyRetentionChange(ctx.db, orgId, (await orgClock(ctx.db, orgId, ctx.clock)).now(), ctx.log);
}

export const onRetentionChangedDefinition: TriggerDefinition = {
  name: 'matters-onRetentionChanged',
  document: 'orgs/{orgId}',
  on: 'updated',
  handler: onRetentionUpdate,
};

export const onRetentionChanged = defineTrigger(onRetentionChangedDefinition);
