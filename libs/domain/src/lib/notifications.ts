import * as z from 'zod';

import { DEFAULT_ORG_TIMEZONE } from './constants';
import { DocIdSchema } from './schemas/common';
import {
  NOTIFICATION_CHANNELS,
  NotificationPayloadSchema,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPriority,
} from './schemas/notification-records';
import type { DateOnly } from './values/date-only';

/*
 * Notifications (FND-20): the kind registry, preferences and the pure routing rules that
 * `notify()` (apps/functions) and its delivery worker apply. ADR-030 records the design.
 */

// ---------- the kind registry ----------

export interface NotificationKindSpec {
  /** What a person sees in their notification settings. */
  label: string;
  /** The channels it goes out on unless the recipient's preferences say otherwise. */
  channels: readonly NotificationChannel[];
  /** The priority when the caller doesn't give one. */
  priority: NotificationPriority;
}

/**
 * Every notification kind with its defaults. Mentions and assignments go in-app and by email;
 * deadline escalations are critical (always emailed, never collapsed or held for quiet hours);
 * everything else is in-app unless a person turns more on. A kind in `NotificationPayloadSchema`
 * without an entry here fails the type check.
 */
export const NOTIFICATION_KINDS = {
  invite: { label: 'Invitations to another practice', channels: ['inapp', 'email'], priority: 'normal' },
  mention: { label: 'Mentions', channels: ['inapp', 'email'], priority: 'normal' },
  assignment: { label: 'Matters assigned to you', channels: ['inapp', 'email'], priority: 'normal' },
  task_assigned: { label: 'Tasks assigned to you', channels: ['inapp', 'email'], priority: 'normal' },
  task_reminder: { label: 'Task due reminders', channels: ['inapp', 'email'], priority: 'normal' },
  deadline_reminder: { label: 'Deadline reminders', channels: ['inapp', 'email'], priority: 'normal' },
  deadline_escalation: { label: 'Deadline escalations', channels: ['inapp', 'email', 'push'], priority: 'critical' },
  deadline_changed: { label: 'Deadline changes to decide', channels: ['inapp'], priority: 'normal' },
  deadline_missed: { label: 'Possibly missed deadlines', channels: ['inapp'], priority: 'normal' },
  suggestion: { label: 'Clerk suggestions', channels: ['inapp'], priority: 'normal' },
  suggestion_ready: { label: 'Clerk finished a request', channels: ['inapp'], priority: 'normal' },
  conflict_alert: { label: 'Conflict alerts', channels: ['inapp'], priority: 'high' },
  invite_accepted: { label: 'Invitations accepted', channels: ['inapp'], priority: 'normal' },
  document_ready: { label: 'Documents ready', channels: ['inapp'], priority: 'normal' },
  // CORE-12: an upload failed the malware scan and was deleted. High (a toast while online) and
  // emailed, so the uploader and the owners and admins hear of it even if they've moved on.
  document_infected: { label: 'Infected uploads removed', channels: ['inapp', 'email'], priority: 'high' },
  integration_error: { label: 'Integration problems', channels: ['inapp', 'email'], priority: 'high' },
  export_ready: { label: 'Exports ready', channels: ['inapp', 'email'], priority: 'normal' },
  // SEC-05: the practice will be deleted (or no longer will). High and emailed: everyone must hear.
  org_deletion: { label: 'Practice deletion notices', channels: ['inapp', 'email'], priority: 'high' },
  // CORE-17: a testator whose original will is in safe custody has died. High and emailed.
  safe_custody: { label: 'Safe custody wills', channels: ['inapp', 'email'], priority: 'high' },
  budget_alert: { label: 'Budget alerts', channels: ['inapp'], priority: 'normal' },
  costs_disclosure: { label: 'Costs disclosures due', channels: ['inapp'], priority: 'normal' },
  system: { label: 'Account and system messages', channels: ['inapp'], priority: 'normal' },
} as const satisfies Record<NotificationKind, NotificationKindSpec>;

/** Every kind, in the schema's order. */
export const NOTIFICATION_KIND_IDS = NotificationPayloadSchema.options.map(
  (option) => option.shape.kind.value,
) as readonly NotificationKind[];

export function notificationKindSpec(kind: NotificationKind): NotificationKindSpec {
  return NOTIFICATION_KINDS[kind];
}

/** How long a notification is kept: Firestore TTL deletes it this long after it was sent (CORE-22). */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** When a notification sent at `sentAt` expires (its `expireAt`). */
export function notificationExpiry(sentAt: Date): Date {
  return new Date(sentAt.getTime() + NOTIFICATION_RETENTION_DAYS * 86_400_000);
}

// ---------- the inbox's filters (CORE-22) ----------

/** The inbox's filter chips, in order; `all` shows everything. */
export const INBOX_FILTERS = ['all', 'mentions', 'assigned', 'deadlines', 'clerk', 'system'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** Which chip each kind falls under (every kind under exactly one; `all` holds them all). */
export const INBOX_FILTER_OF = {
  mention: 'mentions',
  assignment: 'assigned',
  task_assigned: 'assigned',
  deadline_reminder: 'deadlines',
  deadline_escalation: 'deadlines',
  deadline_changed: 'deadlines',
  deadline_missed: 'deadlines',
  task_reminder: 'deadlines',
  suggestion: 'clerk',
  suggestion_ready: 'clerk',
  invite: 'system',
  invite_accepted: 'system',
  conflict_alert: 'system',
  document_ready: 'system',
  document_infected: 'system',
  integration_error: 'system',
  export_ready: 'system',
  org_deletion: 'system',
  safe_custody: 'system',
  budget_alert: 'system',
  costs_disclosure: 'system',
  system: 'system',
} as const satisfies Record<NotificationKind, Exclude<InboxFilter, 'all'>>;

/** Whether a notification of `kind` shows under `filter`. */
export function inInboxFilter(kind: NotificationKind, filter: InboxFilter): boolean {
  return filter === 'all' || INBOX_FILTER_OF[kind] === filter;
}

/** More than this many notifications for one person within the window are collapsed. */
export const NOTIFICATION_BURST_LIMIT = 100;
export const NOTIFICATION_BURST_WINDOW_MS = 60_000;

/** The summary a burst collapses into: one per person per minute (UTC), `burst-{uid}-{yyyyMMddHHmm}`. */
export function burstSummaryId(uid: string, now: Date): string {
  return `burst-${uid}-${now.toISOString().slice(0, 16).replace(/[-T:]/g, '')}`;
}

// ---------- push on a device (MOB-04) ----------

/** A device that hasn't opened Materia for this many days gets no more pushes and is deleted. */
export const PUSH_DEVICE_STALE_DAYS = 60;

/**
 * What every push says under its title. Lock screens are public, so a push never carries the
 * notification's body (deadline and task titles can name clients); titles name the matter by
 * number at most (`Deadline in 3 days: M-2026-0142`).
 */
export const PUSH_BODY = 'Open Materia to see it.';

/** `notifications-testPush` (MOB-04): one of the caller's own devices. */
export const TestPushInput = z.object({ deviceId: DocIdSchema });
export type TestPushInput = z.infer<typeof TestPushInput>;

// ---------- preferences: users/{uid}.prefs.notifications ----------

const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:mm' });

/** Email and push wait while it's quiet hours for the recipient (local time, wraps midnight). */
export const QuietHoursSchema = z.object({ start: ClockTimeSchema, end: ClockTimeSchema }).strict();
export type QuietHours = z.infer<typeof QuietHoursSchema>;
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '19:00', end: '07:00' };

/** A person's choice per kind; a channel left out follows the kind's default. */
export const ChannelPrefsSchema = z
  .object({ inapp: z.boolean(), email: z.boolean(), push: z.boolean() })
  .partial()
  .strict();
export type ChannelPrefs = z.infer<typeof ChannelPrefsSchema>;

/** A task's reminder goes out this many days before it is due unless its assignee chose otherwise. */
export const DEFAULT_TASK_REMINDER_DAYS = 1;
export const TASK_REMINDER_DAYS_MAX = 14;

/**
 * `users/{uid}.prefs.notifications`. `email` and `push` switch a channel off for everything
 * except critical notifications, which always email; `kinds` turns a channel on or off for one
 * kind. `digest` (default on) sends the daily email at `digestHour`; `quietHours` defaults to
 * 19:00–07:00 (`null` turns them off).
 */
export const NotificationPrefsSchema = z.object({
  email: z.boolean(),
  push: z.boolean(),
  digestHour: z.number().int().min(0).max(23),
  digest: z.boolean().optional(),
  quietHours: QuietHoursSchema.nullable().optional(),
  kinds: z.record(z.string().regex(/^[a-z][a-z_]{0,39}$/), ChannelPrefsSchema).optional(),
  /** Days before a task's due date that its reminder goes out, at 08:00 (CORE-11; default 1). */
  taskReminderDays: z.number().int().min(0).max(TASK_REMINDER_DAYS_MAX).optional(),
  /** The weekly practice report on Mondays (INS-03; owners and admins; off unless chosen). */
  weeklyReport: z.boolean().optional(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { email: true, push: false, digestHour: 7 };

/**
 * Reads stored preferences defensively: a missing or invalid field takes its default, so a
 * half-written settings document never stops a notification.
 */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const field = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : fallback;
  };
  const prefs: NotificationPrefs = {
    email: field(z.boolean(), data['email'], DEFAULT_NOTIFICATION_PREFS.email),
    push: field(z.boolean(), data['push'], DEFAULT_NOTIFICATION_PREFS.push),
    digestHour: field(
      NotificationPrefsSchema.shape.digestHour,
      data['digestHour'],
      DEFAULT_NOTIFICATION_PREFS.digestHour,
    ),
  };
  if (typeof data['digest'] === 'boolean') prefs.digest = data['digest'];
  if (data['quietHours'] === null) prefs.quietHours = null;
  else if (data['quietHours'] !== undefined) {
    const quiet = QuietHoursSchema.safeParse(data['quietHours']);
    if (quiet.success) prefs.quietHours = quiet.data;
  }
  const kinds = NotificationPrefsSchema.shape.kinds.safeParse(data['kinds']);
  if (kinds.success && kinds.data) prefs.kinds = kinds.data;
  const taskDays = NotificationPrefsSchema.shape.taskReminderDays.safeParse(data['taskReminderDays']);
  if (taskDays.success && taskDays.data !== undefined) prefs.taskReminderDays = taskDays.data;
  if (typeof data['weeklyReport'] === 'boolean') prefs.weeklyReport = data['weeklyReport'];
  return prefs;
}

export interface ChannelChoice {
  kind: NotificationKind;
  priority: NotificationPriority;
  /** The caller's channels: the most it may go out on (default: any the person turns on). */
  channels?: readonly NotificationChannel[] | undefined;
  prefs?: NotificationPrefs | null | undefined;
}

/**
 * The channels one recipient gets a notification on:
 *
 * 1. Start from the caller's channels, or the kind's defaults.
 * 2. The person's choice for the kind turns a channel on or off (within the caller's channels).
 * 3. `email: false` or `push: false` switches that channel off.
 * 4. Critical notifications always go in-app and by email, whatever the preferences say: the
 *    constraint is enforced here, on the server, not by the settings screen.
 */
export function resolveChannels(choice: ChannelChoice): NotificationChannel[] {
  const prefs = choice.prefs ?? DEFAULT_NOTIFICATION_PREFS;
  const defaults = choice.channels ?? NOTIFICATION_KINDS[choice.kind].channels;
  const allowed = choice.channels ?? NOTIFICATION_CHANNELS;
  const own = prefs.kinds?.[choice.kind] ?? {};
  const master: Record<NotificationChannel, boolean> = { inapp: true, email: prefs.email, push: prefs.push };
  return NOTIFICATION_CHANNELS.filter((channel) => {
    if (choice.priority === 'critical' && (channel === 'email' || channel === 'inapp')) return true;
    const wanted = own[channel] ?? defaults.includes(channel);
    return wanted && allowed.includes(channel) && master[channel];
  });
}

// ---------- time: quiet hours and the digest ----------

const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA time zone: the first valid one given, else the org default. */
export function validTimeZone(...zones: (string | null | undefined)[]): string {
  for (const zone of zones) {
    if (!zone) continue;
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: zone });
      return zone;
    } catch {
      // Not a time zone this runtime knows; try the next.
    }
  }
  return DEFAULT_ORG_TIMEZONE;
}

/** The local date and minute of the day of an instant in a time zone. */
export function wallClockAt(instant: Date, timeZone: string): { date: DateOnly; minutes: number } {
  let formatter = wallClocks.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    wallClocks.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}` as DateOnly,
    minutes: (Number(parts['hour']) % 24) * 60 + Number(parts['minute']),
  };
}

const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * When quiet hours end, if `now` is inside them (in `timeZone`); `null` when it isn't, or when
 * quiet hours are off. Lands on the end minute's wall-clock time across a daylight-saving change.
 */
export function quietHoursEnd(now: Date, timeZone: string, quiet: QuietHours | null): Date | null {
  if (!quiet) return null;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return null;
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  const { minutes } = wallClockAt(new Date(minuteStart), timeZone);
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return null;
  let at = minuteStart + ((end - minutes + 1440) % 1440) * 60_000;
  // A daylight-saving change in between moves the wall clock by an hour: correct for it.
  for (let i = 0; i < 2; i++) {
    const off = (((end - wallClockAt(new Date(at), timeZone).minutes + 1440 + 720) % 1440) - 720) * 60_000;
    if (!off) break;
    at += off;
  }
  return new Date(at);
}

/**
 * When email and push may go out: now (`null`) for critical notifications and outside quiet
 * hours, else the end of the recipient's quiet hours (default 19:00–07:00, their time zone).
 */
export function deliverAfter(
  priority: NotificationPriority,
  now: Date,
  timeZone: string,
  prefs: NotificationPrefs | null | undefined,
): Date | null {
  if (priority === 'critical') return null;
  const quiet = prefs?.quietHours === undefined ? DEFAULT_QUIET_HOURS : prefs.quietHours;
  return quietHoursEnd(now, timeZone, quiet);
}

/** The local date whose digest is due at `now` (its `digestHour` has arrived), or `null`. */
export function digestDueDate(now: Date, timeZone: string, prefs: NotificationPrefs): DateOnly | null {
  if (prefs.digest === false || !prefs.email) return null;
  const { date, minutes } = wallClockAt(now, timeZone);
  return minutes >= prefs.digestHour * 60 ? date : null;
}

/** The daily digest's idempotency key: one per person per local day. */
export function digestId(uid: string, date: DateOnly): string {
  return `digest-${uid}-${date}`;
}

export interface DigestItem {
  kind: 'deadline' | 'task';
  /** A deadline or task title; `null` on a privileged matter (the email shows only its number). */
  title: string | null;
  dueDate: DateOnly;
  matterNumber: string | null;
  critical: boolean;
  link: string;
}

export interface DigestContent {
  dueToday: DigestItem[];
  overdue: DigestItem[];
  unreadMentions: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The digest email's subject, or `null` when there is nothing to report (and nothing is sent).
 * Counts only: matter content never goes in a subject line.
 */
export function digestSubject(content: DigestContent): string | null {
  const parts = [
    content.dueToday.length ? `${content.dueToday.length} due today` : '',
    content.overdue.length ? `${content.overdue.length} overdue` : '',
    content.unreadMentions ? plural(content.unreadMentions, 'unread mention', 'unread mentions') : '',
  ].filter(Boolean);
  return parts.length ? `Your day in Materia: ${parts.join(', ')}` : null;
}

/** Orders digest items: critical first, then by date, deadlines before tasks. */
export function sortDigestItems(items: readonly DigestItem[]): DigestItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.critical) - Number(a.critical) ||
      a.dueDate.localeCompare(b.dueDate) ||
      (a.kind === b.kind ? 0 : a.kind === 'deadline' ? -1 : 1),
  );
}
