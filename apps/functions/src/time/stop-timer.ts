import {
  can,
  computeTimeEntry,
  defaultBillable,
  DomainError,
  PERMISSIONS,
  StopTimerInput,
  TIME_ENTRY_MAX_MINUTES,
  TimeEntry,
  TIMER_DOC_ID,
  TIMER_MATTER_UNAVAILABLE,
  timerElapsedMs,
  timerEntries,
  type RateMatter,
  type RateMember,
  type StopTimerResult,
} from '@materia/domain';

import { rateOrg } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { matterPath } from '../matters/shared';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

export const timerPath = (uid: string) => `users/${uid}/timer/${TIMER_DOC_ID}`;

const asDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

/** The timer's elapsed time on the server's clock. */
export function serverElapsedMs(timer: Data, now: Date): number {
  return timerElapsedMs(
    {
      startedAt: asDate(timer['startedAt']),
      accumulatedMs: typeof timer['accumulatedMs'] === 'number' ? timer['accumulatedMs'] : 0,
      running: timer['running'] === true,
    },
    now.getTime(),
  );
}

/**
 * `time-stopTimer` (BILL-02; `time.record`, idempotent): saves the caller's timer as draft time
 * entries with `source: 'timer'` and deletes it, in one transaction, so a second tab or device
 * stopping it at the same moment can't save it twice (and a retried call returns the first result).
 *
 * The elapsed time is the server's (`startedAt` + `accumulatedMs`), rounded to whole minutes; the
 * entry is dated the day its time began (org time zone), or, with `split`, there is one entry per
 * day. Units, rate and amount are priced as `time-onWrite` would (it re-prices them anyway). The
 * matter must be live and visible to the caller: when the timer's matter was deleted or the caller
 * lost access, the call is refused with `FAILED_PRECONDITION` (`reason: timer_matter_unavailable`)
 * and the timer is kept, so the person can move the time to another matter (`matterId`).
 */
export const stopTimerDefinition = {
  name: 'time-stopTimer',
  input: StopTimerInput,
  roles: PERMISSIONS['time.record'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, requestId, clock: baseClock, log }): Promise<StopTimerResult> => {
    const clock = await orgClock(db, orgId, baseClock);
    const [timeZone, org, member] = await Promise.all([
      orgTimeZone(db, orgId),
      db.doc(`orgs/${orgId}`).get(),
      db.doc(`orgs/${orgId}/members/${uid}`).get(),
    ]);
    const billing = rateOrg(org.data());
    const timerRef = db.doc(timerPath(uid));

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(timerRef);
      const timer = snap.data() as Data | undefined;
      if (!snap.exists || !timer) throw new DomainError('NOT_FOUND', 'No timer to stop');
      if (timer['orgId'] !== orgId)
        throw new DomainError('FAILED_PRECONDITION', 'The timer belongs to another practice', {
          reason: 'timer_other_org',
        });
      const timerMatterId = String(timer['matterId']);
      const matterId = input.matterId ?? timerMatterId;
      const matterSnap = await tx.get(db.doc(matterPath(orgId, matterId)));
      const matter = matterSnap.data() as Data | undefined;
      if (!matter || isDeleted(matter) || (matter['privileged'] === true && !can(role, 'privileged.view')))
        throw new DomainError('FAILED_PRECONDITION', 'The matter can’t take time', {
          reason: TIMER_MATTER_UNAVAILABLE,
          matterId,
        });

      const now = clock.now();
      const elapsedMs = serverElapsedMs(timer, now);
      const parts = timerEntries(now.getTime(), elapsedMs, timeZone, input.split);
      if (parts.some((part) => part.minutes > TIME_ENTRY_MAX_MINUTES))
        throw new DomainError('INVALID_ARGUMENT', 'One entry can be at most 100 hours: split it by day', {
          field: 'split',
        });

      const billable = input.billable ?? defaultBillable(matter as RateMatter);
      const taskId = matterId === timerMatterId && typeof timer['taskId'] === 'string' ? timer['taskId'] : undefined;
      const narrative = input.narrative.trim();
      const entryIds: string[] = [];
      for (const part of parts) {
        const values = billing
          ? computeTimeEntry({
              minutes: part.minutes,
              date: part.date,
              org: billing,
              matter: matter as RateMatter,
              member: (member.data() as RateMember | undefined) ?? null,
            })
          : { units: 0, rateCents: 0, amountCents: 0 };
        const ref = db.collection(`${matterPath(orgId, matterId)}/timeEntries`).doc();
        tx.set(ref, {
          orgId,
          matterId,
          uid,
          date: part.date,
          minutes: part.minutes,
          units: values.units,
          rateCents: values.rateCents,
          amountCents: values.amountCents,
          narrative,
          billable,
          status: 'draft',
          source: 'timer',
          ...(taskId ? { taskId } : {}),
          wipCountedCents: 0,
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: TimeEntry.version,
          _requestId: requestId,
        });
        entryIds.push(ref.id);
      }
      tx.delete(timerRef);
      return { matterId, entryIds, minutes: parts.reduce((sum, part) => sum + part.minutes, 0) };
    });

    log.info('timer saved', {
      matterId: result.matterId,
      entries: result.entryIds.length,
      minutes: result.minutes,
      split: input.split,
    });
    return result;
  },
} satisfies CallableDefinition<typeof StopTimerInput, StopTimerResult>;

export const stopTimer = defineCallable(stopTimerDefinition);
