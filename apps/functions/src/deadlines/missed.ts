import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { Notification, today, type DateOnly } from '@materia/domain';

import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { createLog, functionsSink, type Log } from '../core/log';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';
import { orgTimeZone } from '../templates/shared';

/** Why a deadline was or wasn't asked about. */
export interface MissedCheckOutcome {
  checked: number;
  flagged: string[];
}

/**
 * The daily missed check for one org (CORE-10): each live upcoming deadline due before today (org
 * time zone) that wasn't past on creation and hasn't been asked about gets `missedCheck` {since:
 * its due date, at} and a `deadline_missed` notification to its assignee asking them to confirm
 * (deadlines-complete `missed`), mark it done or move it. Nothing is marked missed here. Each
 * deadline is updated in its own transaction (re-read, so a deadline closed meanwhile is skipped);
 * running it twice flags nothing new.
 */
export async function flagMissedDeadlines(
  db: Firestore,
  orgId: string,
  baseClock: Clock,
  log: Log,
): Promise<MissedCheckOutcome> {
  const clock = await orgClock(db, orgId, baseClock);
  const now = clock.now();
  const todayDate = today(await orgTimeZone(db, orgId), now);
  const snap = await db
    .collectionGroup('deadlines')
    .where('orgId', '==', orgId)
    .where('status', '==', 'upcoming')
    .where('dueDate', '<', todayDate)
    .get();
  const flagged: string[] = [];
  for (const doc of snap.docs) {
    const done = await db.runTransaction(async (tx) => {
      const current = await tx.get(doc.ref);
      const data = current.data();
      if (!data || isDeleted(data) || data['status'] !== 'upcoming') return false;
      if (data['pastOnCreation'] === true || data['missedCheck']) return false;
      const dueDate = data['dueDate'];
      if (typeof dueDate !== 'string' || dueDate >= todayDate) return false;
      const matterId = String(data['matterId']);
      tx.update(doc.ref, {
        missedCheck: { since: dueDate as DateOnly, at: now },
        updatedAt: now,
        updatedBy: 'system',
      });
      const recipient = data['assigneeUid'];
      if (typeof recipient === 'string' && recipient) {
        tx.set(
          db.doc(`orgs/${orgId}/notifications/dlmissed-${matterId}-${doc.id}-${dueDate}`),
          Notification.schema.parse({
            kind: 'deadline_missed',
            deadlineId: doc.id,
            matterId,
            recipientUid: recipient,
            title: 'Was this deadline missed?',
            body: `${String(data['title'] ?? 'Deadline')} was due ${dueDate}. Mark it done, move it or confirm it was missed.`,
            link: `/matters/${matterId}/deadlines`,
            channel: ['inapp'],
            priority: data['critical'] === true ? 'high' : 'normal',
            createdAt: now,
            createdBy: 'system',
            updatedAt: now,
            updatedBy: 'system',
            schemaVersion: Notification.version,
          }),
        );
      }
      return true;
    });
    if (done) flagged.push(`${String(doc.get('matterId'))}/${doc.id}`);
  }
  log.info('missed deadlines checked', { orgId, checked: snap.size, flagged: flagged.length });
  return { checked: snap.size, flagged };
}

/** Runs the missed check for every active org; one org's failure doesn't stop the others. */
export async function flagMissedAllOrgs(db: Firestore, clock: Clock, log: Log): Promise<number> {
  const orgs = await db.collection('orgs').get();
  let flagged = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    try {
      flagged += (await flagMissedDeadlines(db, org.id, clock, log)).flagged.length;
    } catch (error) {
      log.error('missed check failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return flagged;
}

/** `deadlines-flagMissed` (CORE-10): the daily missed check, early morning Melbourne time. */
export const flagMissed = onSchedule(
  { schedule: '30 5 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'deadlines-flagMissed' }, functionsSink);
    const flagged = await flagMissedAllOrgs(adminDb(), systemClock, log);
    log.info('ok', { flagged });
  },
);
