import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { forgottenReason, type TimerForgottenReason } from '@materia/domain';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { createLog, functionsSink, type Log } from '../core/log';
import { notify, type NotifyResult } from '../notifications/notify';
import type { Clock, Ports } from '../ports';
import { ports as container, systemClock } from '../ports/container';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

export interface ForgottenOutcome {
  checked: number;
  /** `{uid}`: the owners told about their timer. */
  flagged: string[];
}

const asDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

const timerClock = (data: Data) => ({
  startedAt: asDate(data['startedAt']),
  accumulatedMs: typeof data['accumulatedMs'] === 'number' ? data['accumulatedMs'] : 0,
  running: data['running'] === true,
  forgotten: data['forgotten'],
});

const BODY: Record<TimerForgottenReason, (number: string) => string> = {
  long: (number) => `Your timer on ${number} has been running for more than 10 hours. Stop it or keep it going.`,
  midnight: (number) => `Your timer on ${number} has been running since yesterday. Stop it or keep it going.`,
};

/**
 * The forgotten-timer check (BILL-02): every running timer (the `timer` collection group, by
 * `running`) that has run more than 10 hours, or whose running segment started before today in its
 * org's time zone, gets `forgotten: {reason, at}` and an in-app `system` notification to its owner
 * (email and push only if they turned them on, held for quiet hours as usual), linking to the
 * matter's Time tab. Each timer is re-read in its own transaction, so one stopped meanwhile is left
 * alone, and a flagged timer isn't flagged again (pausing and resuming keeps the flag). The app
 * shows a banner from the flag on its next load.
 */
export async function checkForgottenTimers(
  db: Firestore,
  baseClock: Clock,
  log: Log,
  ports: Pick<Ports, 'tasks'>,
): Promise<ForgottenOutcome> {
  const snap = await db.collectionGroup('timer').where('running', '==', true).get();
  const zones = new Map<string, Promise<string>>();
  const clocks = new Map<string, Promise<Clock>>();
  const flagged: string[] = [];
  for (const doc of snap.docs) {
    const uid = doc.ref.parent.parent?.id;
    const orgId = doc.get('orgId');
    if (!uid || typeof orgId !== 'string' || !orgId) continue;
    try {
      if (!zones.has(orgId)) zones.set(orgId, orgTimeZone(db, orgId));
      if (!clocks.has(orgId)) clocks.set(orgId, orgClock(db, orgId, baseClock));
      const [timeZone, clock] = await Promise.all([zones.get(orgId), clocks.get(orgId)]);
      if (!timeZone || !clock) continue;
      const now = clock.now();
      let notified: NotifyResult | undefined;
      const done = await db.runTransaction(async (tx) => {
        notified = undefined;
        const current = await tx.get(doc.ref);
        const data = current.data() as Data | undefined;
        if (!data || data['orgId'] !== orgId) return false;
        const reason = forgottenReason(timerClock(data), now, timeZone);
        if (!reason) return false;
        tx.update(doc.ref, { forgotten: { reason, at: now } });
        const matterId = String(data['matterId']);
        const number = String(data['matterNumber'] ?? 'a matter');
        const startedAt = asDate(data['startedAt'])?.getTime() ?? 0;
        notified = await notify(
          { db, orgId, clock, log, ports },
          {
            kind: 'system',
            recipients: [uid],
            title: 'Your timer is still running',
            body: BODY[reason](number),
            link: `/matters/${matterId}/time`,
            key: `timer-forgotten-${uid}-${startedAt}`,
          },
          { tx },
        );
        return true;
      });
      await notified?.dispatch();
      if (done) flagged.push(uid);
    } catch (error) {
      log.error('forgotten timer check failed', {
        orgId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  log.info('forgotten timers checked', { checked: snap.size, flagged: flagged.length });
  return { checked: snap.size, flagged };
}

/**
 * `time-flagForgottenTimers` (BILL-02): every 30 minutes, so a timer left running over midnight is
 * flagged by 00:30 and a 10-hour one within half an hour. In-app notices are immediate; email and
 * push wait for the end of the person's quiet hours (FND-20).
 */
export const flagForgottenTimers = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'time-flagForgottenTimers' }, functionsSink);
    const result = await checkForgottenTimers(adminDb(), systemClock, log, container());
    log.info('ok', { checked: result.checked, flagged: result.flagged.length });
  },
);
