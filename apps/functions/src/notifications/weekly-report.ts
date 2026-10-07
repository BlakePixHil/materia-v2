import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  addDays,
  readNotificationPrefs,
  sumMetricValues,
  validTimeZone,
  WEEKLY_REPORT_AHEAD_DAYS,
  WEEKLY_REPORT_ROLES,
  WEEKLY_REPORT_TOP_MATTERS,
  weeklyReportDue,
  weeklyReportId,
  weeklyReportModel,
  weeklyReportWeek,
  type DateOnly,
  type MetricValues,
  type WeeklyReportInput,
} from '@materia/domain';

import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { createLog, functionsSink, type Log } from '../core/log';
import { RESEND_API_KEY } from '../core/secrets';
import { valuesOf } from '../metrics/shared';
import { appUrl } from '../orgs/shared';
import { MailError, type Clock, type Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

/** Report records expire after this (Firestore TTL on `digests.expireAt`, as the daily digest's). */
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type WeeklyReportStatus = 'sent' | 'skipped' | 'failed';

export interface WeeklyReportDeps {
  db: Firestore;
  clock: Clock;
  ports: Pick<Ports, 'mail'>;
  log: Log;
}

export interface WeeklyReportRun {
  orgs: number;
  outcomes: Partial<Record<WeeklyReportStatus, number>>;
}

type Data = Record<string, unknown>;

/** A day's figures: its `metrics/day-…` document with its counter shards (ADR-048). */
async function dayValues(db: Firestore, orgId: string, day: DateOnly): Promise<MetricValues> {
  const path = `orgs/${orgId}/metrics/day-${day}`;
  const [main, shards] = await Promise.all([db.doc(path).get(), db.collection(`${path}/shards`).get()]);
  return sumMetricValues([valuesOf(main.data()), ...shards.docs.map((shard) => valuesOf(shard.data() as Data))]);
}

const cents = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * What one org's report says for the week before `monday`: the week's figures from the INS-01
 * rollups, WIP now and the five live matters holding most of it (numbers only), and how many
 * critical deadlines on live matters fall due from `monday` to the Sunday after.
 */
export async function weeklyReportContent(
  db: Firestore,
  orgId: string,
  monday: DateOnly,
): Promise<Omit<WeeklyReportInput, 'orgName'>> {
  const week = weeklyReportWeek(monday);
  const [days, matters, critical] = await Promise.all([
    Promise.all(week.days.map((day) => dayValues(db, orgId, day))),
    db.collection(`orgs/${orgId}/matters`).get(),
    db
      .collectionGroup('deadlines')
      .where('orgId', '==', orgId)
      .where('status', '==', 'upcoming')
      .where('critical', '==', true)
      .where('dueDate', '>=', monday)
      .where('dueDate', '<=', addDays(monday, WEEKLY_REPORT_AHEAD_DAYS - 1))
      .get(),
  ]);
  const live = new Map<string, Data>();
  for (const matter of matters.docs) {
    const data = matter.data();
    if (!isDeleted(data) && !data['destroyedAt']) live.set(matter.id, data);
  }
  const wip = [...live].map(([matterId, data]) => ({
    matterId,
    number: String(data['number'] ?? ''),
    wipCents: cents(data['wipCents']) + cents(data['disbursementWipCents']),
  }));
  const topMatters = wip
    .filter((matter) => matter.wipCents > 0)
    .sort((a, b) => b.wipCents - a.wipCents || a.number.localeCompare(b.number))
    .slice(0, WEEKLY_REPORT_TOP_MATTERS);
  const criticalDue = critical.docs.filter((deadline) => {
    const data = deadline.data();
    return !isDeleted(data) && live.has(String(data['matterId']));
  }).length;
  return {
    monday,
    days,
    wipCents: wip.reduce((sum, matter) => sum + matter.wipCents, 0),
    topMatters,
    criticalDue,
  };
}

/**
 * The reports due in one org now: Mondays from 07:00 in the org's time zone, to each active owner
 * and admin who opted in (`prefs.notifications.weeklyReport`). A record
 * `orgs/{orgId}/digests/weekly-{uid}-{monday}` is created first, so two runs never send twice; a
 * transient mail failure removes it to try again next run.
 */
export async function runOrgWeeklyReports(
  deps: WeeklyReportDeps,
  orgId: string,
  org: Data,
): Promise<Partial<Record<WeeklyReportStatus, number>>> {
  const { db, log } = deps;
  const now = deps.clock.now();
  const monday = weeklyReportDue(now, validTimeZone(org['timezone'] as string | undefined));
  const outcomes: Partial<Record<WeeklyReportStatus, number>> = {};
  if (!monday) return outcomes;
  const members = await db
    .collection(`orgs/${orgId}/members`)
    .where('status', '==', 'active')
    .where('role', 'in', [...WEEKLY_REPORT_ROLES])
    .get();
  if (members.empty) return outcomes;
  const users = await db.getAll(...members.docs.map((doc) => db.doc(`users/${doc.id}`)));
  let content: Promise<Omit<WeeklyReportInput, 'orgName'>> | undefined;

  for (const [i, member] of members.docs.entries()) {
    const user = users[i] as DocumentSnapshot;
    const prefs = readNotificationPrefs(user.get('prefs.notifications'));
    if (prefs.weeklyReport !== true) continue;
    const id = weeklyReportId(member.id, monday);
    const ref = db.doc(`orgs/${orgId}/digests/${id}`);
    try {
      await ref.create({
        uid: member.id,
        date: monday,
        kind: 'weekly_report',
        status: 'sending',
        createdAt: now,
        updatedAt: now,
        expireAt: new Date(now.getTime() + RECORD_TTL_MS),
      });
    } catch {
      continue; // Already sent (or being sent) this week.
    }
    const record = async (status: WeeklyReportStatus, extra: Data = {}) => {
      await ref.update({ status, ...extra, updatedAt: deps.clock.now() });
      outcomes[status] = (outcomes[status] ?? 0) + 1;
      log.info('weekly report', { reportId: id, status, reason: extra['reason'] ?? null });
    };
    const email = user.get('email') ?? member.get('email');
    if (typeof email !== 'string' || !email.includes('@')) {
      await record('skipped', { reason: 'no_address' });
      continue;
    }
    if (user.get('emailDeliverability.status') === 'undeliverable') {
      await record('skipped', { reason: 'undeliverable' });
      continue;
    }
    try {
      content ??= weeklyReportContent(db, orgId, monday);
      const model = weeklyReportModel(
        { ...(await content), orgName: String(org['name'] ?? 'your practice') },
        appUrl(),
      );
      const sent = await deps.ports.mail.send({ to: email, template: 'weekly_report', model, idempotencyKey: id });
      await record('sent', { providerId: sent.id });
    } catch (error) {
      const failure = error instanceof MailError ? error.failure : 'transient';
      if (failure === 'not_configured') {
        await record('skipped', { reason: 'not_configured' });
      } else if (failure !== 'transient') {
        await record('failed', { reason: failure });
      } else {
        content = undefined;
        await ref.delete();
        log.warn('weekly report not sent; retried next run', {
          reportId: id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
  return outcomes;
}

/** Every live org's weekly reports; one org's failure doesn't stop the others. */
export async function runWeeklyReports(deps: WeeklyReportDeps): Promise<WeeklyReportRun> {
  const orgs = await deps.db.collection('orgs').get();
  const run: WeeklyReportRun = { orgs: 0, outcomes: {} };
  for (const org of orgs.docs) {
    const data = org.data();
    if (isDeleted(data)) continue;
    run.orgs++;
    try {
      const outcomes = await runOrgWeeklyReports(deps, org.id, data);
      for (const [status, count] of Object.entries(outcomes) as [WeeklyReportStatus, number][]) {
        run.outcomes[status] = (run.outcomes[status] ?? 0) + count;
      }
    } catch (error) {
      deps.log.error('weekly reports failed for org', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return run;
}

/**
 * `notifications-weeklyReport` (INS-03): every 15 minutes, so Monday's reports go out soon after
 * 07:00 in each org's own time zone. Most runs only read the org list.
 */
export const weeklyReport = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 0,
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const log = createLog({ fn: 'notifications-weeklyReport' }, functionsSink);
    const run = await runWeeklyReports({ db: adminDb(), clock: systemClock, ports: ports(), log });
    log.info('ok', { orgs: run.orgs, ...run.outcomes });
  },
);
