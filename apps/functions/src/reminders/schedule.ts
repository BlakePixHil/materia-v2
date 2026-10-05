import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

import { nextReminderAt, reminderSlots, VIC_CALENDARS, type ReminderCalendar, type StoredReminder } from '@materia/deadlines';
import { validTimeZone, type DateOnly } from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { localityCalendar } from '../deadlines/shared';

/*
 * Reminder scheduling (CORE-11): each live upcoming deadline carries `nextReminderAt`, the instant
 * its next reminder is due, so `reminders-dispatch` finds what to send with one query. It is set
 * when a deadline's date, criticality, reminder offsets or status change (`deadlines-onWrite`), and
 * for all of an org's deadlines when its time zone or locality calendar changes
 * (`reminders-onOrgWrite`).
 */

type Data = Record<string, unknown>;

/** The org's time zone and locality calendar, which place its reminders. */
export async function reminderCalendar(db: Firestore, orgId: string): Promise<ReminderCalendar> {
  const org = (await db.doc(`orgs/${orgId}`).get()).data();
  return {
    timeZone: validTimeZone(typeof org?.['timezone'] === 'string' ? org['timezone'] : undefined),
    calendars: VIC_CALENDARS,
    locality: localityCalendar(org),
  };
}

export const toDate = (value: unknown): Date | undefined =>
  value instanceof Date
    ? value
    : value && typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : undefined;

/** A deadline's stored reminders, read defensively. */
export function storedReminders(data: Data | undefined): StoredReminder[] {
  const raw = data?.['reminders'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Data => !!r && typeof r === 'object' && Number.isInteger((r as Data)['offsetDays']))
    .map((r) => ({ offsetDays: r['offsetDays'] as number, sentAt: toDate(r['sentAt']) }));
}

/** A deadline that gets reminders: live, upcoming and dated. */
export function remindable(data: Data | undefined): data is Data & { dueDate: DateOnly } {
  return !!data && !isDeleted(data) && data['status'] === 'upcoming' && typeof data['dueDate'] === 'string';
}

/** The deadline's reminders as slots, or none when it gets no reminders. */
export function slotsOf(data: Data | undefined, cal: ReminderCalendar) {
  if (!remindable(data)) return [];
  return reminderSlots(
    { dueDate: data.dueDate, critical: data['critical'] === true, reminders: storedReminders(data) },
    cal,
  );
}

const offsets = (data: Data | undefined) =>
  storedReminders(data)
    .map((r) => r.offsetDays)
    .sort((a, b) => a - b)
    .join(',');

/**
 * Whether a write changed what the reminders depend on: the date, criticality, offsets (not their
 * sent marks, which the dispatcher writes), status or deletion. Edits to anything else keep the
 * schedule, so a reminder the dispatcher hasn't reached yet isn't lost.
 */
export function scheduleChanged(before: Data | undefined, after: Data | undefined): boolean {
  if (!before || !after) return !!after;
  return (
    before['dueDate'] !== after['dueDate'] ||
    (before['critical'] === true) !== (after['critical'] === true) ||
    offsets(before) !== offsets(after) ||
    before['status'] !== after['status'] ||
    isDeleted(before) !== isDeleted(after)
  );
}

/**
 * Re-reads the deadline and sets its `nextReminderAt`: the first reminder still ahead of `now`
 * (those already due aren't sent late), or removes it. A moved date also clears the escalation, so
 * the new date can escalate again. Writes nothing when the values are already current.
 */
export async function scheduleDeadline(
  db: Firestore,
  ref: DocumentReference,
  cal: ReminderCalendar,
  now: Date,
  options: { dateMoved?: boolean } = {},
): Promise<{ nextReminderAt: Date | undefined; written: boolean }> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!data) return { nextReminderAt: undefined, written: false };
    const next = nextReminderAt(slotsOf(data, cal), now);
    const update: Data = {};
    const stored = toDate(data['nextReminderAt']);
    if (stored?.getTime() !== next?.getTime()) update['nextReminderAt'] = next ?? FieldValue.delete();
    if (options.dateMoved && data['escalatedAt'] !== undefined) {
      update['escalatedAt'] = FieldValue.delete();
      update['escalatedTo'] = FieldValue.delete();
    }
    if (!Object.keys(update).length) return { nextReminderAt: next, written: false };
    tx.update(ref, update);
    return { nextReminderAt: next, written: true };
  });
}

/** Reschedules every upcoming deadline of the org (its time zone or calendar changed). */
export async function rescheduleOrg(db: Firestore, orgId: string, now: Date): Promise<number> {
  const cal = await reminderCalendar(db, orgId);
  const snap = await db
    .collectionGroup('deadlines')
    .where('orgId', '==', orgId)
    .where('status', '==', 'upcoming')
    .get();
  let written = 0;
  for (const doc of snap.docs) {
    if ((await scheduleDeadline(db, doc.ref, cal, now)).written) written += 1;
  }
  return written;
}
