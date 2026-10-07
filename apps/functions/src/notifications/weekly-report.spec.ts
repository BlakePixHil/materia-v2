import type { DateOnly } from '@materia/domain';

import { runWeeklyReports, weeklyReportContent } from './weekly-report';
import { createLog } from '../core/log';
import { renderMail } from '../mail/templates';
import { memoryFirestore } from '../orgs/testing';
import { MailError, type MailMessage, type MailPort } from '../ports';
import { FakeClock, FakeMail } from '../ports/fakes';

/** Unit tests for the weekly practice report (INS-03). All fictional. */

const ORG = 'org-w';
const M = `orgs/${ORG}/matters`;
// 06:59, 07:00 and 07:15 on Monday 5 October 2026 in Melbourne (UTC+11).
const BEFORE = new Date('2026-10-04T19:59:00Z');
const SEVEN = new Date('2026-10-04T20:00:00Z');
const LATER = new Date('2026-10-04T20:15:00Z');
// 07:00 on Tuesday 6 October.
const TUESDAY = new Date('2026-10-05T20:00:00Z');

type Data = Record<string, unknown>;
const meta = { createdAt: SEVEN, createdBy: 'seed', updatedAt: SEVEN, updatedBy: 'seed', schemaVersion: 1 };
const member = (role: string, status = 'active') => ({ ...meta, role, status });
const user = (email: string, weeklyReport?: boolean, extra: Data = {}) => ({
  ...meta,
  email,
  ...(weeklyReport === undefined
    ? {}
    : { prefs: { notifications: { email: true, push: false, digestHour: 7, weeklyReport } } }),
  ...extra,
});
const matter = (number: string, wipCents: number, extra: Data = {}) => ({
  ...meta,
  number,
  title: `Estate of Secret Client ${number}`,
  wipCents,
  ...extra,
});
const critical = (matterId: string, dueDate: string, extra: Data = {}) => ({
  ...meta,
  orgId: ORG,
  matterId,
  title: 'Secret deadline name',
  status: 'upcoming',
  critical: true,
  dueDate,
  ...extra,
});

function world(extra: Record<string, Data> = {}, now = SEVEN) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Harbour Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`users/user-owner`]: user('olive.fictional@example.com', true),
    [`orgs/${ORG}/members/user-admin`]: member('admin'),
    [`users/user-admin`]: user('adam.fictional@example.com'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`users/user-lawyer`]: user('ben.fictional@example.com', true),
    [`orgs/${ORG}/members/user-gone`]: member('owner', 'removed'),
    [`users/user-gone`]: user('gone.fictional@example.com', true),
    [`orgs/${ORG}/metrics/day-2026-09-28`]: { values: { 'billing.invoicedCents': 110000, 'matters.opened': 1 } },
    [`orgs/${ORG}/metrics/day-2026-10-04`]: {
      values: { 'billing.collectedCents': 50000, 'time.billable.minutes': 90 },
    },
    [`orgs/${ORG}/metrics/day-2026-10-04/shards/3`]: { values: { 'time.billable.minutes': 30 } },
    // Outside the week: not counted.
    [`orgs/${ORG}/metrics/day-2026-10-05`]: { values: { 'billing.invoicedCents': 999900 } },
    [`${M}/m1`]: matter('0041', 50000, { disbursementWipCents: 1000 }),
    [`${M}/m2`]: matter('0042', 90000, { privileged: true }),
    [`${M}/m3`]: matter('0043', 0),
    [`${M}/m4`]: matter('0044', 70000, { deletedAt: SEVEN }),
    [`${M}/m1/deadlines/d1`]: critical('m1', '2026-10-05'),
    [`${M}/m1/deadlines/d2`]: critical('m1', '2026-10-11'),
    [`${M}/m1/deadlines/d3`]: critical('m1', '2026-10-12'),
    [`${M}/m1/deadlines/d4`]: critical('m1', '2026-10-06', { status: 'done' }),
    [`${M}/m4/deadlines/d5`]: critical('m4', '2026-10-06'),
    ...extra,
  });
  const clock = new FakeClock(now);
  const mail = new FakeMail();
  const logged: Data[] = [];
  const log = createLog({ fn: 'test' }, (_severity, message, entry) => void logged.push({ message, ...entry }));
  const deps = (port: MailPort = mail) => ({ db: store.db, clock, ports: { mail: port }, log });
  return { ...store, clock, mail, logged, deps };
}

describe('weeklyReportContent', () => {
  it('adds up last week, ranks WIP and counts this week’s critical deadlines on live matters', async () => {
    const w = world();
    const content = await weeklyReportContent(w.db, ORG, '2026-10-05' as DateOnly);
    expect(content.wipCents).toBe(50000 + 1000 + 90000);
    expect(content.topMatters).toEqual([
      { matterId: 'm2', number: '0042', wipCents: 90000 },
      { matterId: 'm1', number: '0041', wipCents: 51000 },
    ]);
    expect(content.criticalDue).toBe(2);
    expect(content.days.reduce((sum, day) => sum + (day?.['time.billable.minutes'] ?? 0), 0)).toBe(120);
    expect(content.days.reduce((sum, day) => sum + (day?.['billing.invoicedCents'] ?? 0), 0)).toBe(110000);
  });
});

describe('runWeeklyReports', () => {
  it('sends nothing before 07:00 on Monday, org time', async () => {
    const w = world({}, BEFORE);
    expect(await runWeeklyReports(w.deps())).toEqual({ orgs: 1, outcomes: {} });
    expect(w.mail.sent).toEqual([]);
  });

  it('emails opted-in owners and admins at 07:00 on Monday, once', async () => {
    const w = world();
    expect(await runWeeklyReports(w.deps())).toEqual({ orgs: 1, outcomes: { sent: 1 } });
    expect(w.mail.sent).toHaveLength(1);
    const [message] = w.mail.sent as MailMessage[];
    expect(message).toMatchObject({
      to: 'olive.fictional@example.com',
      template: 'weekly_report',
      idempotencyKey: 'weekly-user-owner-2026-10-05',
    });
    const rendered = renderMail('weekly_report', message?.model ?? {});
    expect(rendered.subject).toMatch(/^Weekly practice report for Fictional Harbour Legal: 28 Sept? – 4 Oct$/);
    expect(rendered.text).toContain('Billed (ex GST): $1,100.00');
    expect(rendered.text).toContain('Billable time: 2.0 h');
    expect(rendered.text).toContain('- 0042 · $900.00: ');
    expect(rendered.text).toContain('2 critical deadlines due this week');
    expect(rendered.html).toContain('Open Insights');
    // Figures and matter numbers only: no titles, client names or deadline names.
    for (const secret of ['Secret', 'Estate of']) {
      expect(rendered.html).not.toContain(secret);
      expect(rendered.text).not.toContain(secret);
    }
    expect(w.docs.get(`orgs/${ORG}/digests/weekly-user-owner-2026-10-05`)).toMatchObject({ status: 'sent' });

    w.clock.set(LATER);
    expect(await runWeeklyReports(w.deps())).toEqual({ orgs: 1, outcomes: {} });
    w.clock.set(TUESDAY);
    expect(await runWeeklyReports(w.deps())).toEqual({ orgs: 1, outcomes: {} });
    expect(w.mail.sent).toHaveLength(1);
    expect(JSON.stringify(w.logged)).not.toContain('olive.fictional');
  });

  it('follows the org’s own time zone', async () => {
    const w = world({ [`orgs/${ORG}`]: { name: 'Fictional Swan Legal', timezone: 'Australia/Perth' } });
    // 07:00 in Melbourne is 04:00 in Perth.
    expect((await runWeeklyReports(w.deps())).outcomes).toEqual({});
    // 07:00 in Perth.
    w.clock.set(new Date('2026-10-04T23:00:00Z'));
    expect((await runWeeklyReports(w.deps())).outcomes).toEqual({ sent: 1 });
  });

  it('tries again next run after a transient mail failure, and records Postmark not being set up', async () => {
    const w = world();
    const failing: MailPort = {
      send: async () => {
        throw new MailError('transient');
      },
    };
    expect((await runWeeklyReports(w.deps(failing))).outcomes).toEqual({});
    expect(w.docs.has(`orgs/${ORG}/digests/weekly-user-owner-2026-10-05`)).toBe(false);

    const unconfigured: MailPort = {
      send: async () => {
        throw new MailError('not_configured');
      },
    };
    expect((await runWeeklyReports(w.deps(unconfigured))).outcomes).toEqual({ skipped: 1 });
    expect(w.docs.get(`orgs/${ORG}/digests/weekly-user-owner-2026-10-05`)).toMatchObject({
      status: 'skipped',
      reason: 'not_configured',
    });
  });
});
