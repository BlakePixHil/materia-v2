import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { dateOnlyAt, disclosureReminderDue, today, withDisclosureEvent, type DateOnly } from '@materia/domain';

import { cleanDisclosure, disclosureDue, disclosureOf } from './shared';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { isEnabled } from '../core/flags';
import { createLog, functionsSink, type Log } from '../core/log';
import { mattersPath } from '../matters/shared';
import type { Clock, Ports } from '../ports';
import { ports as systemPorts, systemClock } from '../ports/container';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

/** Matters a reminder can be about: engaged ones (a lead waits on its conflict check; closed ones are done). */
const REMINDED_STATUSES = new Set(['open', 'on_hold']);

const toDate = (value: unknown): Date | undefined =>
  value instanceof Date
    ? value
    : value && typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : undefined;

/** The day a matter opened, for disclosures from before BILL-06 that have no `requiredSince`. */
function openedOn(matter: Data, timeZone: string): DateOnly | undefined {
  const created = toDate(matter['createdAt']);
  return created ? dateOnlyAt(created, timeZone) : undefined;
}

/**
 * The nightly run for one org (BILL-06), while `billing.costsDisclosure` is on: every open matter
 * whose disclosure has been `required` for 7 days without being sent gets a "Send the costs
 * disclosure" task for its responsible lawyer and a `costs_disclosure` notification, once per time
 * it falls due (`remindedOn`). Each matter is its own transaction, so one failure skips only it.
 */
export async function disclosureRemindersForOrg(
  db: Firestore,
  orgId: string,
  baseClock: Clock,
  log: Log,
  ports: Pick<Ports, 'tasks'>,
): Promise<{ reminded: string[] } | null> {
  const clock = await orgClock(db, orgId, baseClock);
  if (!(await isEnabled({ orgId, db, clock }, 'billing.costsDisclosure'))) return null;
  const timeZone = await orgTimeZone(db, orgId);
  const now = clock.now();
  const asOf = today(timeZone, now);
  const snap = await db.collection(mattersPath(orgId)).where('costsDisclosure.status', '==', 'required').get();
  const reminded: string[] = [];
  for (const doc of snap.docs) {
    const matter = doc.data();
    if (isDeleted(matter) || matter['destroyedAt'] || !REMINDED_STATUSES.has(String(matter['status']))) continue;
    if (!disclosureReminderDue(disclosureOf(matter), asOf, openedOn(matter, timeZone))) continue;
    try {
      let dispatch: () => Promise<void> = async () => undefined;
      const done = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        const data = fresh.data();
        if (!data || isDeleted(data) || !REMINDED_STATUSES.has(String(data['status']))) return false;
        const current = disclosureOf(data);
        const since = current.requiredSince ?? openedOn(data, timeZone);
        if (!since || !disclosureReminderDue(current, asOf, since)) return false;
        const due = await disclosureDue(
          { db, orgId, clock, log, ports },
          { tx, matterRef: doc.ref, matter: data, kind: 'due', since, today: asOf },
        );
        dispatch = due.dispatch;
        const next = {
          ...current,
          requiredSince: since,
          remindedOn: asOf,
          taskId: due.taskId,
          history: withDisclosureEvent(current.history, {
            at: now,
            by: 'system',
            action: 'reminded',
            status: current.status,
          }),
        };
        tx.update(doc.ref, { costsDisclosure: cleanDisclosure(next), updatedAt: now, updatedBy: 'system' });
        return true;
      });
      if (done) {
        await dispatch();
        reminded.push(doc.id);
      }
    } catch (error) {
      log.error('disclosure reminder failed', {
        orgId,
        matterId: doc.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  log.info('disclosure reminders', { orgId, reminded: reminded.length });
  return { reminded };
}

/** Every org; one org's failure doesn't stop the others. */
export async function disclosureRemindersAllOrgs(
  db: Firestore,
  clock: Clock,
  log: Log,
  ports: Pick<Ports, 'tasks'>,
): Promise<number> {
  const orgs = await db.collection('orgs').get();
  let reminded = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    try {
      reminded += (await disclosureRemindersForOrg(db, org.id, clock, log, ports))?.reminded.length ?? 0;
    } catch (error) {
      log.error('disclosure reminders failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return reminded;
}

/** `costs-disclosureNightly` (BILL-06): the 7-day costs disclosure reminders, at 02:00 Melbourne time. */
export const disclosureNightly = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'costs-disclosureNightly' }, functionsSink);
    const reminded = await disclosureRemindersAllOrgs(adminDb(), systemClock, log, systemPorts());
    log.info('ok', { reminded });
  },
);
