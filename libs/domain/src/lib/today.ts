import { fyTotals, type BillingEntryLike } from './billing';
import { isUrgentChange } from './deadlines';
import type { DeadlineStatus, Priority, TaskStatus } from './schemas/enums';
import { endOfWeek, OPEN_TASK_STATUSES, PRIORITY_RANK } from './tasks';
import { addDays, addMonths, compareDates, dateOnly, dateOnlyAt, type DateOnly } from './values/date-only';
import { cents, type Cents } from './values/money';

/**
 * The Today screen (CORE-14): pure helpers that put the person's overdue deadlines, pending
 * deadline changes, escalations, and this week's deadlines and tasks into its sections, in order,
 * and work out their WIP this month. No data access here; the web feature reads the rows and the
 * matters they're on.
 */

/** The most rows a Today section shows; past this it links to the full list. */
export const TODAY_SECTION_LIMIT = 50;
/** Rows in the short My tasks list on Today. */
export const TODAY_TASKS_SHOWN = 8;
/** Recent matters on Today (the latest opened in the current org). */
export const RECENT_MATTERS_SHOWN = 8;

/** Today and the Sunday that ends this (Monday to Sunday) week, in the org's time zone. */
export interface TodayWindow {
  today: DateOnly;
  weekEnd: DateOnly;
}

export function todayWindow(todayDate: DateOnly): TodayWindow {
  return { today: todayDate, weekEnd: endOfWeek(todayDate) };
}

const isLive = (row: { deletedAt?: unknown }) => row.deletedAt === undefined || row.deletedAt === null;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- rows ----------

/** A deadline as Today needs it (a `DeadlineItem` with its id). */
export interface TodayDeadlineLike {
  id: string;
  matterId?: string | undefined;
  title: string;
  dueDate?: string | undefined;
  dueTime?: string | undefined;
  critical: boolean;
  status: DeadlineStatus;
  deletedAt?: unknown;
}

/** A task as Today needs it (matter or personal, `matterId: null`). */
export interface TodayTaskLike {
  id: string;
  matterId?: string | null | undefined;
  title: string;
  dueDate?: string | undefined;
  priority: Priority;
  status: TaskStatus;
  order?: number | undefined;
  deletedAt?: unknown;
}

/** A pending deadline change (a `DeadlineChangeItem` with its id). */
export interface TodayChangeLike {
  id: string;
  matterId: string;
  title: string;
  critical: boolean;
  intoPast: boolean;
  status: string;
}

/**
 * An escalation waiting for the person to acknowledge it. Escalations arrive with reminders and
 * escalation (CORE-11); until then the source is empty and this is the shape it will fill.
 */
export interface TodayEscalationLike {
  id: string;
  matterId?: string | undefined;
  title: string;
}

/** `deadline:m-1/d-1`, `task:m-1/t-1`, `task:personal/t-2`: unique across the screen. */
export function todayItemKey(
  kind: 'deadline' | 'task' | 'change' | 'escalation',
  row: { id: string; matterId?: string | null | undefined },
): string {
  return `${kind}:${row.matterId ?? 'personal'}/${row.id}`;
}

// ---------- Needs attention ----------

export type AttentionItem<D, C, E> =
  | { kind: 'escalation'; key: string; row: E }
  | { kind: 'change'; key: string; row: C; urgent: boolean }
  | { kind: 'overdue'; key: string; row: D };

/** A section's rows (at most the limit), and how many there were before cutting. */
export interface TodaySection<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

function cut<T>(items: T[], limit: number): TodaySection<T> {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

/**
 * Needs attention: what can't wait. In order: changes that would move a critical deadline into the
 * past, escalations awaiting acknowledgement, overdue deadlines (oldest first, critical first on a
 * day), then the other pending deadline changes (in the order given, newest first from the query).
 * Only live upcoming deadlines due before today count as overdue, and only pending changes.
 */
export function needsAttention<D extends TodayDeadlineLike, C extends TodayChangeLike, E extends TodayEscalationLike>(
  input: { overdue: readonly D[]; changes: readonly C[]; escalations: readonly E[] },
  todayDate: DateOnly,
  limit = TODAY_SECTION_LIMIT,
): TodaySection<AttentionItem<D, C, E>> {
  const changes = input.changes.filter((change) => change.status === 'pending');
  const urgent = changes.filter((change) => isUrgentChange(change));
  const other = changes.filter((change) => !isUrgentChange(change));
  const overdue = input.overdue
    .filter(
      (row) =>
        row.status === 'upcoming' &&
        isLive(row) &&
        !!row.dueDate &&
        compareDates(row.dueDate as DateOnly, todayDate) < 0,
    )
    .sort(compareDueDeadlines);
  const items: AttentionItem<D, C, E>[] = [
    ...urgent.map((row) => ({ kind: 'change' as const, key: todayItemKey('change', row), row, urgent: true })),
    ...input.escalations.map((row) => ({ kind: 'escalation' as const, key: todayItemKey('escalation', row), row })),
    ...overdue.map((row) => ({ kind: 'overdue' as const, key: todayItemKey('deadline', row), row })),
    ...other.map((row) => ({ kind: 'change' as const, key: todayItemKey('change', row), row, urgent: false })),
  ];
  return cut(items, limit);
}

// ---------- Due today and this week ----------

/**
 * Where a deadline sits among tasks of the same day: a critical deadline before everything (even
 * urgent tasks), any other deadline with high-priority tasks. Deadlines are obligations to someone
 * outside the firm, so they never sort below a task of the same priority.
 */
export function deadlinePriority(deadline: Pick<TodayDeadlineLike, 'critical'>): number {
  return deadline.critical ? -1 : PRIORITY_RANK.high;
}

export type DueItem<D, T> =
  | { kind: 'deadline'; key: string; dueDate: DateOnly; rank: number; row: D }
  | { kind: 'task'; key: string; dueDate: DateOnly; rank: number; row: T };

/** Soonest first, then by time (untimed last), critical first, then title and id. */
function compareDueDeadlines(a: TodayDeadlineLike, b: TodayDeadlineLike): number {
  const date = byText(a.dueDate ?? '', b.dueDate ?? '');
  if (date) return date;
  if (a.critical !== b.critical) return a.critical ? -1 : 1;
  return byText(a.dueTime ?? '99:99', b.dueTime ?? '99:99') || byText(a.title, b.title) || byText(a.id, b.id);
}

/** Due date, then priority (`deadlinePriority` for deadlines), deadlines before tasks, then time, order, title. */
export function compareDueItems<D extends TodayDeadlineLike, T extends TodayTaskLike>(
  a: DueItem<D, T>,
  b: DueItem<D, T>,
): number {
  const date = compareDates(a.dueDate, b.dueDate);
  if (date) return date;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.kind !== b.kind) return a.kind === 'deadline' ? -1 : 1;
  if (a.kind === 'deadline' && b.kind === 'deadline') {
    const time = byText(a.row.dueTime ?? '99:99', b.row.dueTime ?? '99:99');
    if (time) return time;
  }
  if (a.kind === 'task' && b.kind === 'task') {
    const order = (a.row.order ?? 0) - (b.row.order ?? 0);
    if (order) return order;
  }
  return byText(a.row.title, b.row.title) || byText(a.key, b.key);
}

const inWindow = (date: string | undefined, window: TodayWindow): date is DateOnly =>
  !!date && compareDates(date as DateOnly, window.today) >= 0 && compareDates(date as DateOnly, window.weekEnd) <= 0;

/**
 * Due today and this week: the person's live upcoming deadlines and open tasks due from today to
 * Sunday, merged and sorted by due date then priority (`compareDueItems`). Overdue rows are left
 * out (deadlines are in Needs attention, tasks in My tasks).
 */
export function dueThisWeek<D extends TodayDeadlineLike, T extends TodayTaskLike>(
  input: { deadlines: readonly D[]; tasks: readonly T[] },
  window: TodayWindow,
  limit = TODAY_SECTION_LIMIT,
): TodaySection<DueItem<D, T>> {
  const deadlines = input.deadlines
    .filter((row) => row.status === 'upcoming' && isLive(row) && inWindow(row.dueDate, window))
    .map((row): DueItem<D, T> => ({
      kind: 'deadline',
      key: todayItemKey('deadline', row),
      dueDate: row.dueDate as DateOnly,
      rank: deadlinePriority(row),
      row,
    }));
  const tasks = input.tasks
    .filter(
      (row) =>
        (OPEN_TASK_STATUSES as readonly string[]).includes(row.status) && isLive(row) && inWindow(row.dueDate, window),
    )
    .map((row): DueItem<D, T> => ({
      kind: 'task',
      key: todayItemKey('task', row),
      dueDate: row.dueDate as DateOnly,
      rank: PRIORITY_RANK[row.priority],
      row,
    }));
  return cut([...deadlines, ...tasks].sort(compareDueItems), limit);
}

/** The due list in two headings: Today, and Later this week. Empty headings are left out. */
export function groupDueItems<T extends { dueDate: DateOnly }>(
  items: readonly T[],
  todayDate: DateOnly,
): { id: 'today' | 'this_week'; label: string; items: T[] }[] {
  const today = items.filter((item) => compareDates(item.dueDate, todayDate) <= 0);
  const later = items.filter((item) => compareDates(item.dueDate, todayDate) > 0);
  return [
    { id: 'today' as const, label: 'Today', items: today },
    { id: 'this_week' as const, label: 'Later this week', items: later },
  ].filter((group) => group.items.length);
}

// ---------- WIP this month ----------

/** The first and last days of the month `todayDate` falls in. */
export function monthWindow(todayDate: DateOnly): { start: DateOnly; end: DateOnly } {
  const start = dateOnly(`${todayDate.slice(0, 7)}-01`);
  return { start, end: addDays(addMonths(start, 1), -1) };
}

/**
 * WIP this month: the billable value of the person's live time dated this month that isn't billed
 * yet (drafts and final entries; written-off time doesn't count, and a write-down counts at its
 * reduced value). BILL-03's `fyTotals`, over the month rather than the year.
 */
export function wipThisMonth(entries: readonly BillingEntryLike[], todayDate: DateOnly): Cents {
  const { recordedCents, billedCents } = fyTotals(entries, monthWindow(todayDate));
  return cents(recordedCents - billedCents);
}

// ---------- the header ----------

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** The hour (0–23) of an instant in a time zone. */
export function hourIn(instant: Date, timeZone: string): number {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', hourCycle: 'h23' });
    hourFormatters.set(timeZone, formatter);
  }
  return Number(formatter.formatToParts(instant).find((part) => part.type === 'hour')?.value ?? 0) % 24;
}

/** "Good morning" before noon, "Good afternoon" until 6 pm, then "Good evening". */
export function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Good morning, Jordan": the first word of the person's name, or just the greeting. */
export function greeting(hour: number, displayName: string | null | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0];
  return first && !first.includes('@') ? `${greetingFor(hour)}, ${first}` : greetingFor(hour);
}

const longDay = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "Monday 5 October" (en-AU, no comma). */
export function longDayLabel(date: DateOnly): string {
  return longDay.format(new Date(`${date}T00:00:00Z`)).replace(',', '');
}

/** "Melbourne" for `Australia/Melbourne`, "Port Moresby" for `Pacific/Port_Moresby`. */
export function timeZoneCity(timeZone: string): string {
  return (timeZone.split('/').at(-1) ?? timeZone).replace(/_/g, ' ');
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string): string {
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
  return formatter.format(instant);
}

/**
 * Whether the device's time zone differs from the org's right now (a different wall clock), and
 * if so the two city names for the hint ("Dates follow Melbourne time; this device is on London
 * time"). Null when they agree, or when the device's zone is unknown or invalid.
 */
export function timeZoneHint(
  orgTimeZone: string,
  deviceTimeZone: string | null | undefined,
  now: Date,
): { org: string; device: string; deviceToday: DateOnly } | null {
  if (!deviceTimeZone || deviceTimeZone === orgTimeZone) return null;
  try {
    if (wallClock(now, orgTimeZone) === wallClock(now, deviceTimeZone)) return null;
    return {
      org: timeZoneCity(orgTimeZone),
      device: timeZoneCity(deviceTimeZone),
      deviceToday: dateOnlyAt(now, deviceTimeZone),
    };
  } catch {
    return null;
  }
}

// ---------- a new practice ----------

export type OnboardingStepId = 'matter' | 'team' | 'calendar';

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  description: string;
  done: boolean;
  /** Not built yet: shown, but can't be started. */
  comingSoon: boolean;
}

/**
 * The checklist Today shows while the practice has no matters: create a matter (for roles that
 * can), invite the team (owners and admins), and connect a calendar (not built yet, CORE-21 and
 * INT-02, so it says "coming soon").
 */
export function onboardingSteps(input: {
  matterCount: number;
  memberCount: number;
  canCreateMatter: boolean;
  canInvite: boolean;
}): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (input.canCreateMatter) {
    steps.push({
      id: 'matter',
      label: 'Create your first matter',
      description: 'Open a file for a client. Its deadlines and tasks then show here.',
      done: input.matterCount > 0,
      comingSoon: false,
    });
  }
  if (input.canInvite) {
    steps.push({
      id: 'team',
      label: 'Invite your team',
      description: 'Add the lawyers and staff who work on your matters.',
      done: input.memberCount > 1,
      comingSoon: false,
    });
  }
  steps.push({
    id: 'calendar',
    label: 'Connect a calendar',
    description: 'Coming soon: court dates and deadlines in your calendar.',
    done: false,
    comingSoon: true,
  });
  return steps;
}
