import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { isOpenSuggestion, OPEN_SUGGESTION_STATUSES } from '@materia/domain';

import { asDate, countOutcomes, metricOf, SYSTEM_ACTOR, type Data, type MetricEntry } from './shared';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, functionsSink, type Log } from '../core/log';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

/** Suggestions expired per query page. */
const PAGE = 300;

export interface ExpireOutcome {
  expired: number;
  orgs: number;
}

/**
 * Marks every open (proposed or stale) suggestion past its `expiresAt` as `expired` (AI-07), across
 * orgs through the `suggestions` collection group (index: status, expiresAt). Each one is
 * re-read in its own transaction, so one accepted or dismissed meanwhile is left alone, and a
 * second run expires nothing new. Counted per org in the Clerk metrics.
 */
export async function expireSuggestions(db: Firestore, clock: Clock, log: Log): Promise<ExpireOutcome> {
  const now = clock.now();
  const byOrg = new Map<string, MetricEntry[]>();
  let expired = 0;
  for (;;) {
    const snap = await db
      .collectionGroup('suggestions')
      .where('status', 'in', [...OPEN_SUGGESTION_STATUSES])
      .where('expiresAt', '<=', now)
      .limit(PAGE)
      .get();
    let changed = 0;
    for (const doc of snap.docs) {
      const data = await db.runTransaction(async (tx) => {
        const current = (await tx.get(doc.ref)).data() as Data | undefined;
        const expiresAt = asDate(current?.['expiresAt']);
        if (!current || !isOpenSuggestion(current['status']) || !expiresAt || expiresAt > now) return null;
        tx.update(doc.ref, {
          status: 'expired',
          resolvedBy: SYSTEM_ACTOR,
          resolvedAt: now,
          updatedAt: now,
          updatedBy: SYSTEM_ACTOR,
        });
        return current;
      });
      if (!data) continue;
      changed += 1;
      const orgId = String(data['orgId'] ?? doc.ref.path.split('/')[1]);
      byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), metricOf(data, 'expired')]);
    }
    expired += changed;
    if (snap.size < PAGE || !changed) break;
  }
  for (const [orgId, entries] of byOrg) await countOutcomes(db, orgId, now, entries, log);
  log.info('suggestions expired', { expired, orgs: byOrg.size });
  return { expired, orgs: byOrg.size };
}

/** `suggestions-expire` (AI-07): hourly. */
export const expire = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'suggestions-expire' }, functionsSink);
    const result = await expireSuggestions(adminDb(), systemClock, log);
    log.info('ok', { ...result });
  },
);
