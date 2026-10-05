import {
  burstSummaryId,
  DEFAULT_NOTIFICATION_PREFS,
  deliverAfter,
  digestDueDate,
  digestId,
  digestSubject,
  NOTIFICATION_KIND_IDS,
  NOTIFICATION_KINDS,
  notificationKindSpec,
  NotificationPrefsSchema,
  quietHoursEnd,
  readNotificationPrefs,
  resolveChannels,
  sortDigestItems,
  validTimeZone,
  wallClockAt,
  type DigestItem,
  type NotificationPrefs,
} from './notifications';
import { Notification, NotificationPayloadSchema } from './schemas/org-records';
import { User } from './schemas/tenancy';
import { dateOnly } from './values/date-only';

/** FND-20 unit tests: the kind registry, preference resolution, quiet hours and the digest. */

const MEL = 'Australia/Melbourne';
const prefs = (extra: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...extra,
});

describe('the kind registry', () => {
  it('has defaults for every kind in the schema, including those already in use', () => {
    expect([...NOTIFICATION_KIND_IDS].sort()).toEqual(Object.keys(NOTIFICATION_KINDS).sort());
    for (const kind of [
      'invite',
      'mention',
      'assignment',
      'deadline_reminder',
      'deadline_escalation',
      'deadline_changed',
      'suggestion_ready',
      'document_ready',
      'integration_error',
      'export_ready',
      'budget_alert',
      'system',
      'deadline_missed',
      'task_assigned',
      'suggestion',
      'conflict_alert',
      'invite_accepted',
    ]) {
      expect(NOTIFICATION_KIND_IDS).toContain(kind);
    }
  });

  it('sends mentions and assignments in-app and by email; escalations are critical', () => {
    expect(notificationKindSpec('mention').channels).toEqual(['inapp', 'email']);
    expect(notificationKindSpec('assignment').channels).toEqual(['inapp', 'email']);
    expect(notificationKindSpec('task_assigned').channels).toEqual(['inapp', 'email']);
    expect(notificationKindSpec('deadline_escalation').priority).toBe('critical');
    for (const spec of Object.values(NOTIFICATION_KINDS)) {
      expect(spec.channels.length).toBeGreaterThan(0);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('validates each kind’s payload and the v2 fields', () => {
    const base = {
      recipientUid: 'u1',
      title: 'Task assigned to you',
      body: 'Lodge the inventory',
      link: '/tasks',
      channels: ['inapp'],
      priority: 'critical',
      readAt: null,
    };
    expect(NotificationPayloadSchema.safeParse({ ...base, kind: 'task_assigned', taskId: 't1' }).success).toBe(true);
    expect(NotificationPayloadSchema.safeParse({ ...base, kind: 'document_ready', matterId: 'm1' }).success).toBe(
      false,
    );
    expect(NotificationPayloadSchema.safeParse({ ...base, kind: 'system', channels: [] }).success).toBe(false);
    expect(NotificationPayloadSchema.safeParse({ ...base, kind: 'system', priority: 'urgent' }).success).toBe(false);
    expect(
      NotificationPayloadSchema.safeParse({
        ...base,
        kind: 'system',
        deliveries: [{ channel: 'email', status: 'skipped', reason: 'not_configured', at: new Date(), attempt: 0 }],
      }).success,
    ).toBe(true);
    expect(Notification.version).toBe(2);
    expect(Notification.update.safeParse({ readAt: null }).success).toBe(true);
    expect(Notification.update.safeParse({ title: 'x' }).success).toBe(false);
  });
});

describe('preferences', () => {
  it('are part of the user document, with kinds, quiet hours and a time zone', () => {
    const notifications = {
      email: true,
      push: true,
      digestHour: 8,
      digest: false,
      quietHours: { start: '20:30', end: '06:00' },
      kinds: { mention: { email: false }, deadline_escalation: { email: false } },
    };
    expect(NotificationPrefsSchema.safeParse(notifications).success).toBe(true);
    expect(
      NotificationPrefsSchema.safeParse({ ...notifications, quietHours: { start: '25:00', end: '06:00' } }).success,
    ).toBe(false);
    expect(NotificationPrefsSchema.safeParse({ ...notifications, kinds: { mention: { sms: true } } }).success).toBe(
      false,
    );
    expect(
      User.update.safeParse({
        prefs: { theme: 'system', density: 'compact', shortcuts: true, notifications, timezone: 'Australia/Perth' },
      }).success,
    ).toBe(true);
    expect(Object.keys(User.update.shape)).not.toContain('emailDeliverability');
  });

  it('reads stored preferences defensively, field by field', () => {
    expect(readNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(readNotificationPrefs({ email: 'yes', push: true, digestHour: 99 })).toEqual({
      email: true,
      push: true,
      digestHour: 7,
    });
    expect(
      readNotificationPrefs({
        email: false,
        push: false,
        digestHour: 6,
        digest: false,
        quietHours: null,
        kinds: { mention: { push: true } },
      }),
    ).toEqual({
      email: false,
      push: false,
      digestHour: 6,
      digest: false,
      quietHours: null,
      kinds: { mention: { push: true } },
    });
    expect(readNotificationPrefs({ quietHours: { start: 'late' }, kinds: 'all' })).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(readNotificationPrefs({ quietHours: { start: '22:00', end: '06:30' } }).quietHours).toEqual({
      start: '22:00',
      end: '06:30',
    });
  });
});

describe('resolveChannels', () => {
  it('uses the kind’s defaults with default preferences (push is off until a person turns it on)', () => {
    expect(resolveChannels({ kind: 'mention', priority: 'normal' })).toEqual(['inapp', 'email']);
    expect(resolveChannels({ kind: 'conflict_alert', priority: 'high' })).toEqual(['inapp']);
    expect(resolveChannels({ kind: 'deadline_escalation', priority: 'critical', prefs: prefs() })).toEqual([
      'inapp',
      'email',
    ]);
    expect(
      resolveChannels({ kind: 'deadline_escalation', priority: 'critical', prefs: prefs({ push: true }) }),
    ).toEqual(['inapp', 'email', 'push']);
  });

  it('lets a person turn a channel on or off for one kind', () => {
    expect(
      resolveChannels({ kind: 'mention', priority: 'normal', prefs: prefs({ kinds: { mention: { email: false } } }) }),
    ).toEqual(['inapp']);
    expect(
      resolveChannels({
        kind: 'document_ready',
        priority: 'normal',
        prefs: prefs({ push: true, kinds: { document_ready: { push: true, email: true } } }),
      }),
    ).toEqual(['inapp', 'email', 'push']);
    expect(
      resolveChannels({ kind: 'system', priority: 'normal', prefs: prefs({ kinds: { system: { inapp: false } } }) }),
    ).toEqual([]);
  });

  it('switches email and push off everywhere with the master switches', () => {
    const off = prefs({ email: false, push: false, kinds: { mention: { email: true, push: true } } });
    expect(resolveChannels({ kind: 'mention', priority: 'normal', prefs: off })).toEqual(['inapp']);
    expect(resolveChannels({ kind: 'integration_error', priority: 'high', prefs: off })).toEqual(['inapp']);
  });

  it('never lets critical email (or in-app) be turned off', () => {
    const refuses = prefs({
      email: false,
      kinds: { deadline_escalation: { email: false, inapp: false }, deadline_reminder: { email: false } },
    });
    expect(resolveChannels({ kind: 'deadline_escalation', priority: 'critical', prefs: refuses })).toEqual([
      'inapp',
      'email',
    ]);
    // A critical reminder (a critical deadline due soon) too, even with the caller asking for in-app only.
    expect(
      resolveChannels({ kind: 'deadline_reminder', priority: 'critical', channels: ['inapp'], prefs: refuses }),
    ).toEqual(['inapp', 'email']);
  });

  it('keeps within the caller’s channels', () => {
    const wantsAll = prefs({ push: true, kinds: { system: { email: true, push: true } } });
    expect(resolveChannels({ kind: 'system', priority: 'high', channels: ['inapp'], prefs: wantsAll })).toEqual([
      'inapp',
    ]);
    expect(
      resolveChannels({ kind: 'system', priority: 'normal', channels: ['inapp', 'push'], prefs: wantsAll }),
    ).toEqual(['inapp', 'push']);
  });
});

describe('time zones and wall clocks', () => {
  it('falls back to the next valid zone, then Melbourne', () => {
    expect(validTimeZone('Not/AZone', 'Australia/Perth')).toBe('Australia/Perth');
    expect(validTimeZone(undefined, null, '')).toBe(MEL);
  });

  it('reads the local date and minute', () => {
    expect(wallClockAt(new Date('2026-10-05T09:30:00Z'), MEL)).toEqual({ date: '2026-10-05', minutes: 20 * 60 + 30 });
    expect(wallClockAt(new Date('2026-10-05T14:00:00Z'), MEL)).toEqual({ date: '2026-10-06', minutes: 60 });
  });
});

describe('quiet hours', () => {
  const night = { start: '19:00', end: '07:00' };

  it('holds email and push until 07:00 local, and lets the day through', () => {
    // 20:00 AEDT on Monday 5 October 2026 → 07:00 AEDT on the 6th.
    expect(quietHoursEnd(new Date('2026-10-05T09:00:00Z'), MEL, night)?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    // 19:00 is quiet, 07:00 is not.
    expect(quietHoursEnd(new Date('2026-10-05T08:00:00Z'), MEL, night)?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-10-05T20:00:00Z'), MEL, night)).toBeNull();
    // 02:15 local, after midnight.
    expect(quietHoursEnd(new Date('2026-10-05T15:15:30Z'), MEL, night)?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-10-05T00:00:00Z'), MEL, night)).toBeNull();
  });

  it('lands on 07:00 local across the daylight-saving changes', () => {
    // Saturday 3 October 2026, 20:00 AEST; clocks go forward that night.
    expect(quietHoursEnd(new Date('2026-10-03T10:00:00Z'), MEL, night)?.toISOString()).toBe('2026-10-03T20:00:00.000Z');
    // Saturday 4 April 2026, 20:00 AEDT; clocks go back that night.
    expect(quietHoursEnd(new Date('2026-04-04T09:00:00Z'), MEL, night)?.toISOString()).toBe('2026-04-04T21:00:00.000Z');
  });

  it('supports a daytime window, and none', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(quietHoursEnd(new Date('2026-10-05T01:30:00Z'), MEL, lunch)?.toISOString()).toBe('2026-10-05T02:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-10-05T02:30:00Z'), MEL, lunch)).toBeNull();
    expect(quietHoursEnd(new Date('2026-10-05T09:00:00Z'), MEL, null)).toBeNull();
    expect(quietHoursEnd(new Date('2026-10-05T09:00:00Z'), MEL, { start: '07:00', end: '07:00' })).toBeNull();
  });

  it('applies the default 19:00–07:00 to non-critical notifications only, in the recipient’s zone', () => {
    const evening = new Date('2026-10-05T09:00:00Z'); // 20:00 Melbourne, 17:00 Perth
    expect(deliverAfter('normal', evening, MEL, prefs())?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(deliverAfter('high', evening, MEL, undefined)?.toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(deliverAfter('critical', evening, MEL, prefs())).toBeNull();
    expect(deliverAfter('normal', evening, 'Australia/Perth', prefs())).toBeNull();
    expect(deliverAfter('normal', evening, MEL, prefs({ quietHours: null }))).toBeNull();
  });
});

describe('the daily digest', () => {
  it('is due once the digest hour has arrived locally, unless turned off', () => {
    expect(digestDueDate(new Date('2026-10-05T20:15:00Z'), MEL, prefs())).toBe('2026-10-06');
    expect(digestDueDate(new Date('2026-10-05T19:45:00Z'), MEL, prefs())).toBeNull();
    expect(digestDueDate(new Date('2026-10-05T19:45:00Z'), MEL, prefs({ digestHour: 6 }))).toBe('2026-10-06');
    expect(digestDueDate(new Date('2026-10-05T20:15:00Z'), MEL, prefs({ digest: false }))).toBeNull();
    expect(digestDueDate(new Date('2026-10-05T20:15:00Z'), MEL, prefs({ email: false }))).toBeNull();
    expect(digestId('u1', dateOnly('2026-10-06'))).toBe('digest-u1-2026-10-06');
  });

  const item = (extra: Partial<DigestItem>): DigestItem => ({
    kind: 'deadline',
    title: 'File the probate application',
    dueDate: dateOnly('2026-10-06'),
    matterNumber: 'M-2026-0142',
    critical: false,
    link: '/matters/m1/deadlines',
    ...extra,
  });

  it('has a subject of counts only, and none when there is nothing to report', () => {
    expect(digestSubject({ dueToday: [], overdue: [], unreadMentions: 0 })).toBeNull();
    expect(digestSubject({ dueToday: [item({}), item({})], overdue: [item({})], unreadMentions: 1 })).toBe(
      'Your day in Materia: 2 due today, 1 overdue, 1 unread mention',
    );
    expect(digestSubject({ dueToday: [], overdue: [], unreadMentions: 3 })).toBe(
      'Your day in Materia: 3 unread mentions',
    );
  });

  it('orders critical first, then by date, deadlines before tasks', () => {
    const items = sortDigestItems([
      item({ kind: 'task', title: 'B', dueDate: dateOnly('2026-10-01') }),
      item({ title: 'C', dueDate: dateOnly('2026-10-01') }),
      item({ title: 'A', dueDate: dateOnly('2026-10-03'), critical: true }),
      item({ title: 'D', dueDate: dateOnly('2026-10-01') }),
    ]);
    expect(items.map((i) => i.title)).toEqual(['A', 'C', 'D', 'B']);
  });
});

describe('bursts', () => {
  it('collapse into one summary per person per minute', () => {
    expect(burstSummaryId('u1', new Date('2026-10-05T09:07:42.120Z'))).toBe('burst-u1-202610050907');
  });
});
