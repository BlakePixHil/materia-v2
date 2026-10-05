import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  businessDayOnOrBefore,
  dueInWords,
  dueReminder,
  escalationAt,
  escalationHorizon,
  nextReminderAt,
  REMINDER_MINUTE_OF_DAY,
  type ReminderCalendar,
} from '@materia/deadlines';
import {
  addDays,
  DEADLINE_ESCALATION_RECIPIENTS_MAX,
  DEFAULT_TASK_REMINDER_DAYS,
  OPEN_TASK_STATUSES,
  readNotificationPrefs,
  TASK_REMINDER_DAYS_MAX,
  wallClockAt,
  type DateOnly,
} from '@materia/domain';

import { reminderCalendar, remindable, slotsOf, toDate } from './schedule';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { createLog, functionsSink, type Log } from '../core/log';
import { CLOSED_STATUSES } from '../deadlines/shared';
import { matterPath } from '../matters/shared';
import { notify, type NotifyContext, type NotifyResult } from '../notifications/notify';
import type { Clock, Ports } from '../ports';
import { ports as container, systemClock } from '../ports/container';

/*
 * `reminders-dispatch` (CORE-11): every 15 minutes, for each org, sends the deadline reminders that
 * are due, escalates critical deadlines nobody has acknowledged, and sends task due-date reminders,
 * all through `notify()` (FND-20). Each item is decided in its own transaction (re-read, so a
 * deadline closed or acknowledged meanwhile is skipped), and marks what it sent, so a second run
 * sends nothing new. The run records a heartbeat (`heartbeats/reminders-dispatch`) for the
 * "job not running" alert.
 */

type Data = Record<string, unknown>;

/** The heartbeat document the "reminders not running" alert and the ops screens read. */
export const HEARTBEAT_PATH = 'heartbeats/reminders-dispatch';

export interface DispatchOutcome {
  reminders: string[];
  escalations: string[];
  taskReminders: string[];
  /** Due but not sent: the matter is closed, or nobody is left to tell. */
  skipped: string[];
}

interface OrgRun {
  db: Firestore;
  orgId: string;
  now: Date;
  today: DateOnly;
  cal: ReminderCalendar;
  log: Log;
  notifyCtx: NotifyContext;
  outcome: DispatchOutcome;
  members: Map<string, Data>;
}

const matterIdOf = (ref: DocumentReference) => ref.parent.parent?.id as string;

/** Active members of the org, by uid. */
async function activeMembers(db: Firestore, orgId: string): Promise<Map<string, Data>> {
  const snap = await db.collection(`orgs/${orgId}/members`).where('status', '==', 'active').get();
  return new Map(snap.docs.map((doc) => [doc.id, doc.data()]));
}

const admins = (members: Map<string, Data>) =>
  [...members.entries()]
    .filter(([, m]) => m['role'] === 'owner' || m['role'] === 'admin')
    .map(([uid]) => uid)
    .sort();

const unique = (uids: readonly unknown[]) => [
  ...new Set(uids.filter((uid): uid is string => typeof uid === 'string' && uid.length > 0)),
];

const matterLabel = (matter: Data | undefined) =>
  typeof matter?.['number'] === 'string' && matter['number'] ? matter['number'] : 'a matter';

/** A deadline reminder: due between its stored `nextReminderAt` and now. */
async function sendReminder(run: OrgRun, ref: DocumentReference): Promise<void> {
  const matterId = matterIdOf(ref);
  let notified: NotifyResult | undefined;
  const result = await run.db.runTransaction(async (tx) => {
    notified = undefined;
    const snap = await tx.get(ref);
    const data = snap.data();
    const matter = (await tx.get(run.db.doc(matterPath(run.orgId, matterId)))).data();
    const scheduledFrom = toDate(data?.['nextReminderAt']);
    if (!data || !scheduledFrom) return 'gone';
    const slots = slotsOf(data, run.cal);
    const due = remindable(data) ? dueReminder(slots, scheduledFrom, run.now) : null;
    const covered = new Set(due?.covered ?? []);
    const marked = slots.map((s) => ({
      offsetDays: s.offsetDays,
      ...(s.sentAt ? { sentAt: s.sentAt } : covered.has(s.offsetDays) ? { sentAt: run.now } : {}),
    }));
    const next = nextReminderAt(
      marked.map((m, i) => ({ ...(slots[i] as (typeof slots)[number]), sentAt: m.sentAt })),
      run.now,
    );
    const closed = !matter || isDeleted(matter) || CLOSED_STATUSES.has(matter['status']);
    const update: Data = { nextReminderAt: next ?? FieldValue.delete() };
    if (!due || closed) {
      tx.update(ref, update);
      return due ? 'skipped' : 'none';
    }
    const assignee =
      typeof data['assigneeUid'] === 'string' && run.members.has(data['assigneeUid']) ? data['assigneeUid'] : null;
    // No assignee (or one who has left): the responsible lawyer and the admins.
    const recipients = unique(
      assignee ? [assignee, matter['responsibleUid']] : [matter['responsibleUid'], ...admins(run.members)],
    );
    tx.update(ref, { ...update, reminders: marked, updatedAt: run.now, updatedBy: 'system' });
    if (!recipients.length) return 'skipped';
    const critical = data['critical'] === true;
    const when = dueInWords(run.today, data['dueDate'] as DateOnly);
    notified = await notify(
      run.notifyCtx,
      {
        kind: 'deadline_reminder',
        deadlineId: ref.id,
        matterId,
        recipients,
        // The subject names the matter by number only (no matter content in email subjects).
        title: `${due.late ? 'Late reminder: d' : 'D'}eadline ${when}: ${matterLabel(matter)}`,
        body: `${String(data['title'] ?? 'A deadline')} is due ${String(data['dueDate'])}${critical ? ' (critical)' : ''}.`,
        link: `/matters/${matterId}/deadlines`,
        // Critical deadlines always email, whatever the person's preferences (FND-20).
        priority: critical ? 'critical' : 'normal',
        key: `dlrem-${matterId}-${ref.id}-${due.slot.offsetDays}`,
      },
      { tx },
    );
    return 'sent';
  });
  await notified?.dispatch();
  if (result === 'sent') run.outcome.reminders.push(`${matterId}/${ref.id}`);
  if (result === 'skipped') run.outcome.skipped.push(`${matterId}/${ref.id}`);
}

/**
 * A critical deadline that may escalate: not acknowledged or escalated yet, not already past (the
 * missed check asks about those) and not past when it was computed (the review queue has those).
 */
function escalatable(data: Data, today: DateOnly): boolean {
  return (
    data['critical'] === true &&
    !data['ackAt'] &&
    !data['escalatedAt'] &&
    data['pastOnCreation'] !== true &&
    typeof data['dueDate'] === 'string' &&
    data['dueDate'] >= today
  );
}

/** Escalates a critical deadline three business days out that nobody has acknowledged. */
async function escalate(run: OrgRun, ref: DocumentReference): Promise<void> {
  const matterId = matterIdOf(ref);
  let notified: NotifyResult | undefined;
  const result = await run.db.runTransaction(async (tx) => {
    notified = undefined;
    const data = (await tx.get(ref)).data();
    const matter = (await tx.get(run.db.doc(matterPath(run.orgId, matterId)))).data();
    if (!remindable(data) || !escalatable(data, run.today)) return 'none';
    if (run.now.getTime() < escalationAt(data.dueDate, run.cal).getTime()) return 'none';
    if (!matter || isDeleted(matter) || CLOSED_STATUSES.has(matter['status'])) return 'skipped';
    const responsible =
      typeof matter['responsibleUid'] === 'string' ? run.members.get(matter['responsibleUid']) : undefined;
    const recipients = unique([responsible?.['supervisorUid'], ...admins(run.members)])
      .filter((uid) => run.members.has(uid))
      .sort()
      .slice(0, DEADLINE_ESCALATION_RECIPIENTS_MAX);
    tx.update(ref, { escalatedAt: run.now, escalatedTo: recipients, updatedAt: run.now, updatedBy: 'system' });
    if (!recipients.length) return 'skipped';
    notified = await notify(
      run.notifyCtx,
      {
        kind: 'deadline_escalation',
        deadlineId: ref.id,
        matterId,
        recipients,
        title: `Critical deadline ${dueInWords(run.today, data.dueDate)}, not acknowledged: ${matterLabel(matter)}`,
        body: `${String(data['title'] ?? 'A critical deadline')} is due ${data.dueDate} and nobody has acknowledged it. Open it to acknowledge.`,
        link: `/matters/${matterId}/deadlines`,
        key: `dlesc-${matterId}-${ref.id}-${data.dueDate}`,
      },
      { tx },
    );
    return 'sent';
  });
  await notified?.dispatch();
  if (result === 'sent') run.outcome.escalations.push(`${matterId}/${ref.id}`);
  if (result === 'skipped') run.outcome.skipped.push(`${matterId}/${ref.id}`);
}

/** The day a task's reminder goes out: `days` before it is due, on a business day. */
export function taskReminderDate(cal: ReminderCalendar, dueDate: DateOnly, days: number): DateOnly {
  return days === 0 ? dueDate : businessDayOnOrBefore(cal, addDays(dueDate, -days));
}

/** A task's due-date reminder, once per due date, from 08:00 on its reminder day. */
async function remindTask(run: OrgRun, ref: DocumentReference, reminderDays: Map<string, number>): Promise<void> {
  // Matter tasks live under the matter; personal tasks under the member (`matterId: null`).
  const matterId = ref.parent.parent?.parent.id === 'matters' ? (ref.parent.parent.id as string) : undefined;
  let notified: NotifyResult | undefined;
  const result = await run.db.runTransaction(async (tx) => {
    notified = undefined;
    const data = (await tx.get(ref)).data();
    const matter = matterId ? (await tx.get(run.db.doc(matterPath(run.orgId, matterId)))).data() : undefined;
    if (!data || isDeleted(data) || !(OPEN_TASK_STATUSES as readonly string[]).includes(String(data['status'])))
      return 'none';
    const dueDate = data['dueDate'];
    const assignee = data['assigneeUid'];
    if (typeof dueDate !== 'string' || dueDate < run.today || data['reminderSentFor'] === dueDate) return 'none';
    if (typeof assignee !== 'string' || !run.members.has(assignee)) return 'none';
    const days = reminderDays.get(assignee) ?? DEFAULT_TASK_REMINDER_DAYS;
    if (taskReminderDate(run.cal, dueDate as DateOnly, days) > run.today) return 'none';
    if (matterId && (!matter || isDeleted(matter) || CLOSED_STATUSES.has(matter['status']))) return 'skipped';
    tx.update(ref, { reminderSentFor: dueDate });
    const title = String(data['title'] ?? 'A task');
    notified = await notify(
      run.notifyCtx,
      {
        kind: 'task_reminder',
        taskId: ref.id,
        ...(matterId ? { matterId } : {}),
        recipients: [assignee],
        title: `Task due ${dueInWords(run.today, dueDate as DateOnly)}${matterId ? `: ${matterLabel(matter)}` : ''}`,
        body: title,
        link: matterId ? `/matters/${matterId}/tasks` : '/tasks',
        key: `taskrem-${ref.id}-${dueDate}`,
      },
      { tx },
    );
    return 'sent';
  });
  await notified?.dispatch();
  if (result === 'sent') run.outcome.taskReminders.push(matterId ? `${matterId}/${ref.id}` : ref.id);
  if (result === 'skipped') run.outcome.skipped.push(matterId ? `${matterId}/${ref.id}` : ref.id);
}

/** Each assignee's `taskReminderDays` preference. */
async function taskReminderDays(db: Firestore, uids: readonly string[]): Promise<Map<string, number>> {
  const days = new Map<string, number>();
  for (const uid of uids) {
    const prefs = readNotificationPrefs((await db.doc(`users/${uid}`).get()).get('prefs.notifications'));
    days.set(uid, prefs.taskReminderDays ?? DEFAULT_TASK_REMINDER_DAYS);
  }
  return days;
}

/**
 * One org's run: reminders due by `now`, escalations whose time has come and, from 08:00 org time,
 * task reminders. One item's failure is logged and doesn't stop the others.
 */
export async function dispatchOrg(
  db: Firestore,
  orgId: string,
  baseClock: Clock,
  log: Log,
  ports: Pick<Ports, 'tasks'>,
): Promise<DispatchOutcome> {
  const clock = await orgClock(db, orgId, baseClock);
  const now = clock.now();
  const cal = await reminderCalendar(db, orgId);
  const local = wallClockAt(now, cal.timeZone);
  const run: OrgRun = {
    db,
    orgId,
    now,
    today: local.date,
    cal,
    log,
    notifyCtx: { db, orgId, clock, log, ports },
    outcome: { reminders: [], escalations: [], taskReminders: [], skipped: [] },
    members: await activeMembers(db, orgId),
  };
  const each = async (refs: DocumentReference[], step: (ref: DocumentReference) => Promise<void>, what: string) => {
    for (const ref of refs) {
      try {
        await step(ref);
      } catch (error) {
        log.error(`${what} failed`, {
          orgId,
          id: ref.id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  };

  const due = await db
    .collectionGroup('deadlines')
    .where('orgId', '==', orgId)
    .where('nextReminderAt', '<=', now)
    .get();
  await each(
    due.docs.map((doc) => doc.ref),
    (ref) => sendReminder(run, ref),
    'reminder',
  );

  const critical = await db
    .collectionGroup('deadlines')
    .where('orgId', '==', orgId)
    .where('status', '==', 'upcoming')
    .where('critical', '==', true)
    .where('dueDate', '>=', run.today)
    .where('dueDate', '<=', escalationHorizon(run.today))
    .get();
  const toEscalate = critical.docs.filter((doc) => !isDeleted(doc.data()) && escalatable(doc.data(), run.today));
  await each(
    toEscalate.map((doc) => doc.ref),
    (ref) => escalate(run, ref),
    'escalation',
  );

  if (local.minutes >= REMINDER_MINUTE_OF_DAY) {
    const tasks = await db
      .collectionGroup('tasks')
      .where('orgId', '==', orgId)
      .where('status', 'in', [...OPEN_TASK_STATUSES])
      .where('dueDate', '>=', run.today)
      .where('dueDate', '<=', addDays(run.today, TASK_REMINDER_DAYS_MAX + 7))
      .get();
    const pending = tasks.docs.filter((doc) => {
      const data = doc.data();
      return !isDeleted(data) && data['reminderSentFor'] !== data['dueDate'] && typeof data['assigneeUid'] === 'string';
    });
    const days = await taskReminderDays(db, unique(pending.map((doc) => doc.get('assigneeUid'))));
    await each(
      pending.map((doc) => doc.ref),
      (ref) => remindTask(run, ref, days),
      'task reminder',
    );
  }

  log.info('reminders dispatched', {
    orgId,
    reminders: run.outcome.reminders.length,
    escalations: run.outcome.escalations.length,
    taskReminders: run.outcome.taskReminders.length,
    skipped: run.outcome.skipped.length,
  });
  return run.outcome;
}

/** Every active org, then the heartbeat. One org's failure doesn't stop the others. */
export async function dispatchAllOrgs(
  db: Firestore,
  clock: Clock,
  log: Log,
  ports: Pick<Ports, 'tasks'>,
): Promise<{ orgs: number; sent: number; failed: number }> {
  const startedAt = clock.now();
  const orgs = await db.collection('orgs').get();
  let sent = 0;
  let failed = 0;
  let count = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    count += 1;
    try {
      const outcome = await dispatchOrg(db, org.id, clock, log, ports);
      sent += outcome.reminders.length + outcome.escalations.length + outcome.taskReminders.length;
    } catch (error) {
      failed += 1;
      log.error('reminders dispatch failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  await db.doc(HEARTBEAT_PATH).set(
    {
      lastRunAt: startedAt,
      finishedAt: clock.now(),
      ...(failed ? {} : { lastOkAt: startedAt }),
      orgs: count,
      sent,
      failed,
    },
    { merge: true },
  );
  return { orgs: count, sent, failed };
}

/** `reminders-dispatch` (CORE-11): every 15 minutes. */
export const dispatch = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'reminders-dispatch' }, functionsSink);
    const result = await dispatchAllOrgs(adminDb(), systemClock, log, container());
    // The "reminders not running" alert counts these lines (infra: reminders_dispatch_ok).
    log.info('ok', result);
  },
);
