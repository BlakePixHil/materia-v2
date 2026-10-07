import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  digestDueDate,
  digestId,
  digestSubject,
  longDayLabel,
  OPEN_TASK_STATUSES,
  readNotificationPrefs,
  sortDigestItems,
  toDisplay,
  validTimeZone,
  type DateOnly,
  type DigestContent,
  type DigestItem,
} from '@materia/domain';

import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { createLog, functionsSink, type Log } from '../core/log';
import { RESEND_API_KEY } from '../core/secrets';
import { appUrl } from '../orgs/shared';
import { MailError, type Clock, type Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

/** At most this many deadlines and tasks are read per person (the email links to the rest). */
export const DIGEST_ITEM_LIMIT = 50;
/** Digest records expire after this (Firestore TTL on `digests.expireAt`). */
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DigestStatus = 'sent' | 'empty' | 'skipped' | 'failed';

export interface DigestDeps {
  db: Firestore;
  clock: Clock;
  ports: Pick<Ports, 'mail'>;
  log: Log;
}

export interface DigestRun {
  checked: number;
  outcomes: Partial<Record<DigestStatus, number>>;
}

type Data = Record<string, unknown>;

const asDate = (value: unknown): DateOnly | undefined => (typeof value === 'string' ? (value as DateOnly) : undefined);

/**
 * What the digest reports for one person on `date` (their local day): their deadlines and open
 * tasks due that day or overdue, and how many mentions they haven't read. Items on a deleted or
 * missing matter are left out; on a privileged matter they show only the matter number.
 */
export async function digestContent(db: Firestore, orgId: string, uid: string, date: DateOnly): Promise<DigestContent> {
  const [deadlines, tasks, mentions] = await Promise.all([
    db
      .collectionGroup('deadlines')
      .where('orgId', '==', orgId)
      .where('assigneeUid', '==', uid)
      .where('status', '==', 'upcoming')
      .where('dueDate', '<=', date)
      .orderBy('dueDate', 'asc')
      .limit(DIGEST_ITEM_LIMIT)
      .get(),
    db
      .collectionGroup('tasks')
      .where('orgId', '==', orgId)
      .where('assigneeUid', '==', uid)
      .where('status', 'in', [...OPEN_TASK_STATUSES])
      .where('dueDate', '<=', date)
      .orderBy('dueDate', 'asc')
      .limit(DIGEST_ITEM_LIMIT)
      .get(),
    db
      .collection(`orgs/${orgId}/notifications`)
      .where('recipientUid', '==', uid)
      .where('kind', '==', 'mention')
      .where('readAt', '==', null)
      .count()
      .get(),
  ]);
  const rows = [
    ...deadlines.docs.map((doc) => ({ kind: 'deadline' as const, doc })),
    ...tasks.docs.map((doc) => ({ kind: 'task' as const, doc })),
  ].filter(({ doc }) => !isDeleted(doc.data()) && asDate(doc.get('dueDate')));
  const matterIds = [
    ...new Set(rows.map(({ doc }) => doc.get('matterId')).filter((id): id is string => typeof id === 'string' && !!id)),
  ];
  const matters = new Map<string, Data | undefined>();
  if (matterIds.length) {
    const snaps = await db.getAll(...matterIds.map((id) => db.doc(`orgs/${orgId}/matters/${id}`)));
    for (const snap of snaps) matters.set(snap.id, snap.data());
  }

  const items: DigestItem[] = [];
  for (const { kind, doc } of rows) {
    const matterId = doc.get('matterId');
    const matter = typeof matterId === 'string' && matterId ? matters.get(matterId) : null;
    if (matter === undefined || (matter && isDeleted(matter))) continue;
    const number = matter && typeof matter['number'] === 'string' ? matter['number'] : null;
    const title = typeof doc.get('title') === 'string' ? (doc.get('title') as string) : null;
    items.push({
      kind,
      title: matter?.['privileged'] === true ? null : title,
      dueDate: doc.get('dueDate') as DateOnly,
      matterNumber: number,
      critical: kind === 'deadline' && doc.get('critical') === true,
      link: matter ? `/matters/${String(matterId)}/${kind === 'deadline' ? 'deadlines' : 'tasks'}` : '/tasks',
    });
  }
  const sorted = sortDigestItems(items);
  return {
    dueToday: sorted.filter((item) => item.dueDate === date),
    overdue: sorted.filter((item) => item.dueDate < date),
    unreadMentions: mentions.data().count,
  };
}

/** The `digest` template's model. */
export function digestModel(content: DigestContent, date: DateOnly, subject: string): Record<string, unknown> {
  const base = appUrl();
  const item = (entry: DigestItem) => ({
    label: entry.title ?? `${entry.kind === 'deadline' ? 'Deadline' : 'Task'} on a privileged matter`,
    matterNumber: entry.matterNumber,
    critical: entry.critical,
    dueLabel: toDisplay(entry.dueDate),
    link: `${base}${entry.link}`,
  });
  const mentions = content.unreadMentions;
  return {
    subject,
    dateLabel: longDayLabel(date),
    dueToday: content.dueToday.map(item),
    overdue: content.overdue.map(item),
    unreadMentions: mentions,
    unreadMentionsLabel: `${mentions} unread ${mentions === 1 ? 'mention' : 'mentions'}`,
    inboxLink: `${base}/inbox`,
    link: `${base}/today`,
    settingsLink: `${base}/settings`,
  };
}

interface Person {
  uid: string;
  member: DocumentSnapshot;
  user: DocumentSnapshot;
}

/** Builds and sends one person's digest. A transient failure throws (the record is removed to retry). */
async function sendDigest(
  deps: DigestDeps,
  orgId: string,
  person: Person,
  date: DateOnly,
): Promise<{ status: DigestStatus; reason?: string; providerId?: string; counts?: Record<string, number> }> {
  const email = person.user.get('email') ?? person.member.get('email');
  if (typeof email !== 'string' || !email.includes('@')) return { status: 'skipped', reason: 'no_address' };
  if (person.user.get('emailDeliverability.status') === 'undeliverable') {
    return { status: 'skipped', reason: 'undeliverable' };
  }
  const content = await digestContent(deps.db, orgId, person.uid, date);
  const counts = {
    dueToday: content.dueToday.length,
    overdue: content.overdue.length,
    mentions: content.unreadMentions,
  };
  const subject = digestSubject(content);
  if (!subject) return { status: 'empty', counts };
  try {
    const sent = await deps.ports.mail.send({
      to: email,
      template: 'digest',
      model: digestModel(content, date, subject),
      idempotencyKey: digestId(person.uid, date),
    });
    return { status: 'sent', providerId: sent.id, counts };
  } catch (error) {
    const failure = error instanceof MailError ? error.failure : 'transient';
    if (failure === 'transient') throw error;
    return failure === 'not_configured'
      ? { status: 'skipped', reason: 'not_configured', counts }
      : { status: 'failed', reason: failure, counts };
  }
}

/**
 * The digests due in one org now: each active member whose digest hour has arrived in their time
 * zone (theirs, else the org's) and who hasn't had one for that local day. A record
 * `orgs/{orgId}/digests/digest-{uid}-{date}` is created first, so two runs never send twice; it
 * keeps the outcome (`empty` when there was nothing to report and nothing was sent).
 */
export async function runOrgDigests(deps: DigestDeps, orgId: string, orgTimeZone: unknown): Promise<DigestRun> {
  const { db, log } = deps;
  const now = deps.clock.now();
  const members = await db.collection(`orgs/${orgId}/members`).where('status', '==', 'active').get();
  const users = members.empty ? [] : await db.getAll(...members.docs.map((doc) => db.doc(`users/${doc.id}`)));
  const run: DigestRun = { checked: members.size, outcomes: {} };
  for (const [i, member] of members.docs.entries()) {
    const user = users[i] as DocumentSnapshot;
    const prefs = readNotificationPrefs(user.get('prefs.notifications'));
    const date = digestDueDate(now, validTimeZone(user.get('prefs.timezone'), orgTimeZone as string), prefs);
    if (!date) continue;
    const id = digestId(member.id, date);
    const ref = db.doc(`orgs/${orgId}/digests/${id}`);
    try {
      await ref.create({
        uid: member.id,
        date,
        status: 'sending',
        createdAt: now,
        updatedAt: now,
        expireAt: new Date(now.getTime() + RECORD_TTL_MS),
      });
    } catch {
      continue; // Already sent (or being sent) for this day.
    }
    try {
      const outcome = await sendDigest(deps, orgId, { uid: member.id, member, user }, date);
      await ref.update({ ...outcome, updatedAt: deps.clock.now() });
      run.outcomes[outcome.status] = (run.outcomes[outcome.status] ?? 0) + 1;
      log.info('digest', { digestId: id, status: outcome.status, reason: outcome.reason ?? null });
    } catch (error) {
      await ref.delete();
      log.warn('digest not sent; retried next run', {
        digestId: id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return run;
}

/** Every live org's digests; one org's failure doesn't stop the others. */
export async function runDigests(deps: DigestDeps): Promise<DigestRun> {
  const orgs = await deps.db.collection('orgs').get();
  const total: DigestRun = { checked: 0, outcomes: {} };
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    try {
      const run = await runOrgDigests(deps, org.id, org.get('timezone'));
      total.checked += run.checked;
      for (const [status, count] of Object.entries(run.outcomes) as [DigestStatus, number][]) {
        total.outcomes[status] = (total.outcomes[status] ?? 0) + count;
      }
    } catch (error) {
      deps.log.error('digests failed for org', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return total;
}

/** `notifications-digest` (FND-20): every 15 minutes, the daily digests whose hour has come. */
export const digest = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 0,
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const log = createLog({ fn: 'notifications-digest' }, functionsSink);
    const run = await runDigests({ db: adminDb(), clock: systemClock, ports: ports(), log });
    log.info('ok', { checked: run.checked, ...run.outcomes });
  },
);
