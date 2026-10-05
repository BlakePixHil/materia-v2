import { z } from 'zod';

import { can } from './permissions';
import { DocIdSchema } from './schemas/common';
import {
  DeadlineKindSchema,
  EventKindSchema,
  type DeadlineStatus,
  type Jurisdiction,
  type Role,
} from './schemas/enums';
import {
  Deadline,
  DEADLINE_REASON_MAX,
  DEADLINE_REMINDERS_MAX,
  DEADLINE_TITLE_MAX,
  type DeadlineChangeCause,
  type DeadlineChangeKind,
  type DeadlineChangeStatus,
} from './schemas/matter-records';
import { endOfWeek } from './tasks';
import { addDays, compareDates, DateOnlySchema, type DateOnly } from './values/date-only';

/**
 * Deadlines in the product (CORE-10): the callables' inputs and results, and the pure helpers the
 * Deadlines screen and the matter's Deadlines tab use (grouping, filters, the month calendar,
 * traces, pending changes). The engine itself is `@materia/deadlines` (CORE-09).
 */

// ---------- paths and callables ----------

export const matterEventPath = (orgId: string, matterId: string, eventId?: string) =>
  `orgs/${orgId}/matters/${matterId}/events${eventId ? `/${eventId}` : ''}`;
export const deadlinePath = (orgId: string, matterId: string, deadlineId?: string) =>
  `orgs/${orgId}/matters/${matterId}/deadlines${deadlineId ? `/${deadlineId}` : ''}`;
export const deadlineChangePath = (orgId: string, matterId: string, changeId?: string) =>
  `orgs/${orgId}/matters/${matterId}/deadlineChanges${changeId ? `/${changeId}` : ''}`;

/** The deployed names of the `deadlines-*` callables. */
export const DEADLINE_CALLABLES = {
  upsertEvent: 'deadlines-upsertEvent',
  deleteEvent: 'deadlines-deleteEvent',
  recompute: 'deadlines-recompute',
  resolveChange: 'deadlines-resolveChange',
  override: 'deadlines-override',
  complete: 'deadlines-complete',
  proposeRulesetUpgrade: 'deadlines-proposeRulesetUpgrade',
} as const;

/** Shown wherever deadlines are listed while the rule set's practitioner-review flag is off. */
export const STATUTORY_DISABLED_MESSAGE = 'Statutory deadlines disabled pending review';

/** The flag gating a rule set version's statutory rules: `deadlines.ruleset.vic.v1`. */
export function ruleSetFlagKey(flagPrefix: string, version: number): string {
  return `${flagPrefix}.v${version}`;
}

/** The id of the deadline a rule computes on a matter: one per (matter, rule). */
export function computedDeadlineId(ruleId: string): string {
  return `rule-${ruleId}`;
}

const RequestId = z.uuid();
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' });
const Reason = z.string().trim().min(1, { message: 'Give a reason' }).max(DEADLINE_REASON_MAX);

/** One recompute's outcome, as the callables report it. */
export interface RecomputeSummary {
  /** False when the matter has no rule set (another jurisdiction), or it is closed. */
  ran: boolean;
  /** The matter's `recomputeVersion` after this recompute. */
  recomputeVersion: number;
  ruleSet?: { ruleSetId: string; version: number };
  created: string[];
  updated: string[];
  /** New `deadlineChanges` ids. */
  proposed: string[];
  /** Pending proposals that no longer hold. */
  superseded: string[];
  /** Deadlines blocked because a calendar year is missing (an ops alert is logged too). */
  calendarMissing: string[];
  createdTaskIds: string[];
  /** The rule set's statutory rules weren't applied: its practitioner-review flag is off. */
  statutoryDisabled: boolean;
}

/**
 * `deadlines-upsertEvent` (matter.edit, idempotent): records or edits a matter event and recomputes
 * the matter's deadlines in the same transaction. A `date_of_death` or `grant_issued` event also
 * sets the matter's key fact (`deceased.dateOfDeath`, `estate.grantDate`), and template tasks whose
 * due date was pending on the event get one. A date of death after today is INVALID_ARGUMENT on `date`.
 */
export const UpsertEventInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  /** Omit to add an event. */
  eventId: DocIdSchema.optional(),
  kind: EventKindSchema,
  date: DateOnlySchema,
  time: TimeOfDay.optional(),
  label: z.string().trim().max(200).optional(),
  sourceDocumentId: DocIdSchema.optional(),
  /** Event details rules read: `periodDays` on an offer, `days` on an order, `datePrecision` (`day`, `month`, `year`). */
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type UpsertEventInput = z.infer<typeof UpsertEventInput>;
export interface UpsertEventResult {
  eventId: string;
  recompute: RecomputeSummary;
  /** Template tasks whose pending due date was filled from this event (CORE-07b). */
  filledTaskIds: string[];
}

/** `deadlines-deleteEvent` (matter.edit, idempotent): soft-deletes an event and recomputes. */
export const DeleteEventInput = z.object({ requestId: RequestId, matterId: DocIdSchema, eventId: DocIdSchema });
export type DeleteEventInput = z.infer<typeof DeleteEventInput>;
export interface DeleteEventResult {
  eventId: string;
  recompute: RecomputeSummary;
}

/** `deadlines-recompute` (matter.edit): recomputes a matter's deadlines. Idempotent by nature. */
export const RecomputeDeadlinesInput = z.object({ matterId: DocIdSchema });
export type RecomputeDeadlinesInput = z.infer<typeof RecomputeDeadlinesInput>;

/**
 * `deadlines-resolveChange` (deadline.override, idempotent): accepts or rejects a pending proposal.
 * Accepting one for a critical deadline needs `confirmation`, the matter number as typed
 * (INVALID_ARGUMENT on `confirmation` otherwise). A proposal that no longer holds comes back
 * `superseded`; one already decided is FAILED_PRECONDITION (`details.reason: 'change_not_pending'`).
 */
export const ResolveDeadlineChangeInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  changeId: DocIdSchema,
  accept: z.boolean(),
  confirmation: z.string().trim().max(60).optional(),
});
export type ResolveDeadlineChangeInput = z.infer<typeof ResolveDeadlineChangeInput>;
export interface ResolveDeadlineChangeResult {
  changeId: string;
  deadlineId: string;
  status: Extract<DeadlineChangeStatus, 'accepted' | 'rejected' | 'superseded'>;
}

/**
 * `deadlines-override` (deadline.override, idempotent): sets a computed deadline's date with a
 * reason, or clears the override (`dueDate: null`, back to the engine's date). The engine keeps
 * computing: a later date earlier than the override flags the deadline (`overrideConflict`).
 */
export const OverrideDeadlineInput = z
  .object({
    requestId: RequestId,
    matterId: DocIdSchema,
    deadlineId: DocIdSchema,
    dueDate: DateOnlySchema.nullable(),
    reason: z.string().trim().max(DEADLINE_REASON_MAX).optional(),
  })
  .refine((input) => input.dueDate === null || !!input.reason, {
    message: 'Give a reason for the override',
    path: ['reason'],
  });
export type OverrideDeadlineInput = z.infer<typeof OverrideDeadlineInput>;
export interface OverrideDeadlineResult {
  deadlineId: string;
  dueDate: string;
  overrideConflict: boolean;
}

/** How a deadline is closed: done, waived (lawyer and above, reason) or missed (after the missed check). */
export const DeadlineOutcomeSchema = z.enum(['done', 'waived', 'missed']);
export type DeadlineOutcome = z.infer<typeof DeadlineOutcomeSchema>;

/**
 * `deadlines-complete` (task.edit, idempotent): closes an upcoming deadline. `done` takes the
 * completion date (default today, never in the future); `waived` needs deadline.override and a
 * reason; `missed` needs deadline.override and is only possible once the daily check has asked
 * (`missedCheck`) or for a deadline past on creation. `completeLinkedTasks` marks its open linked
 * tasks done too; the result lists the ones still open so the UI can offer it.
 */
export const CompleteDeadlineInput = z
  .object({
    requestId: RequestId,
    matterId: DocIdSchema,
    deadlineId: DocIdSchema,
    outcome: DeadlineOutcomeSchema,
    completedOn: DateOnlySchema.optional(),
    reason: z.string().trim().max(DEADLINE_REASON_MAX).optional(),
    completeLinkedTasks: z.boolean().default(false),
  })
  .refine((input) => input.outcome !== 'waived' || !!input.reason, {
    message: 'Give a reason for waiving the deadline',
    path: ['reason'],
  });
export type CompleteDeadlineInput = z.input<typeof CompleteDeadlineInput>;
export interface CompleteDeadlineResult {
  deadlineId: string;
  status: Extract<DeadlineStatus, 'done' | 'waived' | 'missed'>;
  /** Linked tasks still open after the call (offer to complete them). */
  openLinkedTaskIds: string[];
  completedTaskIds: string[];
}

/**
 * `deadlines-proposeRulesetUpgrade` (org.settings: owners and admins, idempotent): recomputes the
 * org's live matters against the latest published rule set, so a version bump becomes proposals,
 * never silent changes. Processes up to `limit` matters from `cursor` (a matter id) and returns the
 * next cursor while more remain.
 */
export const ProposeRulesetUpgradeInput = z.object({
  requestId: RequestId,
  cursor: DocIdSchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type ProposeRulesetUpgradeInput = z.input<typeof ProposeRulesetUpgradeInput>;
export interface ProposeRulesetUpgradeResult {
  processed: number;
  /** Matters whose deadlines were computed with an older rule-set version. */
  upgraded: number;
  proposed: number;
  created: number;
  nextCursor?: string;
}

// ---------- manual deadlines (client-direct) ----------

/** Kinds a person may enter without a rule (CORE-10). */
export const MANUAL_DEADLINE_KINDS = ['contractual', 'internal', 'court'] as const;
export const ManualDeadlineKindSchema = DeadlineKindSchema.extract(MANUAL_DEADLINE_KINDS);
export type ManualDeadlineKind = z.infer<typeof ManualDeadlineKindSchema>;

/**
 * What a client writes to create a manual deadline (CORE-10), besides the meta fields the repository
 * stamps: `orgId` and `matterId` matching the path, `status: 'upcoming'`, a manual kind and no
 * computed provenance (the rules check each). Manual deadlines are edited directly afterwards.
 */
export const ManualDeadlineCreateInput = /* @__PURE__ */ z
  .object({
    orgId: DocIdSchema,
    matterId: DocIdSchema,
    title: z.string().trim().min(1).max(DEADLINE_TITLE_MAX),
    dueDate: DateOnlySchema,
    dueTime: TimeOfDay.optional(),
    kind: ManualDeadlineKindSchema,
    critical: z.boolean().default(false),
    status: z.literal('upcoming').default('upcoming'),
    assigneeUid: DocIdSchema,
    reminders: z
      .array(z.object({ offsetDays: z.number().int().min(0).max(365) }).strict())
      .max(DEADLINE_REMINDERS_MAX)
      .default([]),
  })
  .strict();
export type ManualDeadlineCreateInput = z.input<typeof ManualDeadlineCreateInput>;

/** The update a client may make to a manual deadline (the same fields, all optional). */
export const ManualDeadlineUpdateInput = /* @__PURE__ */ Deadline.update.extend({
  kind: ManualDeadlineKindSchema.optional(),
});

// ---------- permissions ----------

export function canOverrideDeadline(role: Role): boolean {
  return can(role, 'deadline.override');
}
/** Accepting or rejecting a proposal is a lawyer's decision (deadline.override). */
export function canResolveDeadlineChange(role: Role): boolean {
  return can(role, 'deadline.override');
}
export function canCompleteDeadline(role: Role, outcome: DeadlineOutcome): boolean {
  return outcome === 'done' ? can(role, 'task.edit') : can(role, 'deadline.override');
}

// ---------- the Deadlines screen ----------

/** A deadline as the lists read it (fields optional where blocked or older documents lack them). */
export interface DeadlineLike {
  id: string;
  matterId?: string | undefined;
  title: string;
  dueDate?: string | undefined;
  dueTime?: string | undefined;
  kind: string;
  critical: boolean;
  status: DeadlineStatus;
  assigneeUid?: string | undefined;
  pastOnCreation?: boolean | undefined;
  overrideConflict?: boolean | undefined;
  missedCheck?: unknown;
  deletedAt?: unknown;
}

export type DeadlineGroupId = 'overdue' | 'this_week' | 'next_30_days' | 'later';
export const DEADLINE_GROUPS: readonly { id: DeadlineGroupId; label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'this_week', label: 'This week' },
  { id: 'next_30_days', label: 'Next 30 days' },
  { id: 'later', label: 'Later' },
];

/**
 * A due date's group given today in the org's time zone: before today is Overdue; today up to
 * Sunday is This week (as My tasks); then up to 30 days from today is Next 30 days; then Later.
 */
export function deadlineGroup(dueDate: DateOnly, todayDate: DateOnly): DeadlineGroupId {
  if (compareDates(dueDate, todayDate) < 0) return 'overdue';
  if (compareDates(dueDate, endOfWeek(todayDate)) <= 0) return 'this_week';
  if (compareDates(dueDate, addDays(todayDate, 30)) <= 0) return 'next_30_days';
  return 'later';
}

/** Soonest first, then by time (untimed last on a day), critical first, then title and id. */
export function compareDeadlines(a: DeadlineLike, b: DeadlineLike): number {
  const date = (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31');
  if (date) return date;
  const time = (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99');
  if (time) return time;
  if (a.critical !== b.critical) return a.critical ? -1 : 1;
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export interface DeadlineGroup<T> {
  id: DeadlineGroupId;
  label: string;
  deadlines: T[];
}

const isLive = (row: { deletedAt?: unknown }) => row.deletedAt === undefined || row.deletedAt === null;

/**
 * The Deadlines screen's groups (Overdue, This week, Next 30 days, Later) of live upcoming
 * deadlines with a date, each sorted by `compareDeadlines`. Empty groups are kept (in order).
 */
export function groupDeadlines<T extends DeadlineLike>(rows: readonly T[], todayDate: DateOnly): DeadlineGroup<T>[] {
  const groups = DEADLINE_GROUPS.map((group) => ({ ...group, deadlines: [] as T[] }));
  for (const row of [...rows].sort(compareDeadlines)) {
    if (row.status !== 'upcoming' || !row.dueDate || !isLive(row)) continue;
    const id = deadlineGroup(row.dueDate as DateOnly, todayDate);
    groups.find((group) => group.id === id)?.deadlines.push(row);
  }
  return groups;
}

/** The matter a deadline belongs to, as the filters need it. */
export interface DeadlineMatterInfo {
  jurisdiction?: Jurisdiction | undefined;
  responsibleUid?: string | undefined;
  teamUids?: readonly string[] | undefined;
}

export interface DeadlineFilters {
  /** Assigned to this member. */
  mine?: boolean;
  /** On matters where this member is responsible or on the team. */
  team?: boolean;
  critical?: boolean;
  kinds?: readonly string[];
  jurisdictions?: readonly Jurisdiction[];
}

/** Whether a deadline passes the Deadlines screen's filters (`uid` is the signed-in member). */
export function deadlineMatchesFilters(
  row: DeadlineLike,
  filters: DeadlineFilters,
  context: { uid: string; matter?: DeadlineMatterInfo | undefined },
): boolean {
  if (filters.mine && row.assigneeUid !== context.uid) return false;
  if (filters.team) {
    const matter = context.matter;
    if (!matter || (matter.responsibleUid !== context.uid && !(matter.teamUids ?? []).includes(context.uid))) {
      return false;
    }
  }
  if (filters.critical && !row.critical) return false;
  if (filters.kinds?.length && !filters.kinds.includes(row.kind)) return false;
  if (filters.jurisdictions?.length) {
    const jurisdiction = context.matter?.jurisdiction;
    if (!jurisdiction || !filters.jurisdictions.includes(jurisdiction)) return false;
  }
  return true;
}

/** Past on creation and still upcoming: the review queue (never marked missed automatically). */
export function needsReview(row: DeadlineLike): boolean {
  return row.status === 'upcoming' && row.pastOnCreation === true && isLive(row);
}

/** Flags worth a badge: past on creation, an override the engine now undercuts, awaiting a missed confirmation. */
export function deadlineFlags(row: DeadlineLike): ('past_on_creation' | 'override_conflict' | 'missed_check')[] {
  const flags: ('past_on_creation' | 'override_conflict' | 'missed_check')[] = [];
  if (row.pastOnCreation) flags.push('past_on_creation');
  if (row.overrideConflict) flags.push('override_conflict');
  if (row.missedCheck) flags.push('missed_check');
  return flags;
}

// ---------- the month calendar ----------

export interface CalendarDay<T> {
  date: DateOnly;
  /** False for the leading and trailing days of the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  deadlines: T[];
}

/**
 * A month view (Monday-first weeks, padded with neighbouring days to whole weeks) with each day's
 * live deadlines sorted by `compareDeadlines`. `month` is `YYYY-MM`.
 */
export function monthCalendar<T extends DeadlineLike>(
  month: string,
  rows: readonly T[],
  todayDate: DateOnly,
): CalendarDay<T>[][] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Expected YYYY-MM, got ${month}`);
  const first = `${month}-01` as DateOnly;
  const weekdayOf = (date: DateOnly) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 ? 7 : day;
  };
  const start = addDays(first, 1 - weekdayOf(first));
  const byDate = new Map<string, T[]>();
  for (const row of [...rows].sort(compareDeadlines)) {
    if (!row.dueDate || !isLive(row)) continue;
    const list = byDate.get(row.dueDate) ?? [];
    list.push(row);
    byDate.set(row.dueDate, list);
  }
  const weeks: CalendarDay<T>[][] = [];
  let date = start;
  do {
    const week: CalendarDay<T>[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        date,
        inMonth: date.startsWith(month),
        isToday: date === todayDate,
        deadlines: byDate.get(date) ?? [],
      });
      date = addDays(date, 1);
    }
    weeks.push(week);
  } while (date.startsWith(month));
  return weeks;
}

// ---------- traces ----------

/** What the DeadlineChip tooltip and the deadline detail show. */
export interface DeadlineTraceView {
  /** "Computed by rule vic.fp.limitation (vic v1)", "Entered manually" or "Waiting: No grant yet". */
  heading: string;
  citation?: string;
  lines: string[];
  notes: string[];
}

interface TraceSource {
  status: DeadlineStatus;
  dueDate?: string | undefined;
  blockedReason?: string | undefined;
  computed?:
    | {
        ruleId: string;
        ruleSetId: string;
        ruleSetVersion: number;
        trace: readonly string[];
        citation?: string | undefined;
        dueDate?: string | undefined;
        approximate?: boolean | undefined;
        verify?: boolean | undefined;
      }
    | undefined;
  override?: { dueDate: string; reason: string } | undefined;
  overrideConflict?: boolean | undefined;
  pastOnCreation?: boolean | undefined;
}

/**
 * A deadline's trace for display: the engine's steps, then notes on the override, an engine date
 * earlier than it, an approximate anchor, a rule needing verification, and past-on-creation.
 */
export function deadlineTraceView(deadline: TraceSource): DeadlineTraceView {
  const computed = deadline.computed;
  const notes: string[] = [];
  if (deadline.override) {
    notes.push(`Overridden to ${deadline.override.dueDate}: ${deadline.override.reason}`);
    if (computed?.dueDate) notes.push(`The rule computes ${computed.dueDate}`);
  }
  if (deadline.overrideConflict) notes.push('The computed date is now earlier than the override');
  if (computed?.approximate) notes.push('Computed from an approximate date: the earliest possible date');
  if (computed?.verify) notes.push('This rule needs practitioner verification');
  if (deadline.pastOnCreation) notes.push('Already past when it was computed: review it');
  if (!computed) return { heading: 'Entered manually', lines: [], notes };
  const heading =
    deadline.status === 'blocked'
      ? `Waiting: ${deadline.blockedReason ?? 'not computed yet'}`
      : `Computed by rule ${computed.ruleId} (${computed.ruleSetId} v${computed.ruleSetVersion})`;
  return {
    heading,
    ...(computed.citation ? { citation: computed.citation } : {}),
    lines: [...computed.trace],
    notes,
  };
}

/** The trace as plain text (one line each), for a tooltip or a screen reader description. */
export function deadlineTraceText(deadline: TraceSource): string {
  const view = deadlineTraceView(deadline);
  return [view.heading, ...(view.citation ? [view.citation] : []), ...view.lines, ...view.notes].join('\n');
}

// ---------- pending changes ----------

interface ChangeLike {
  kind: DeadlineChangeKind;
  critical: boolean;
  fromDueDate: string;
  toDueDate?: string | undefined;
  earlier: boolean;
  intoPast: boolean;
  reason?: string | undefined;
  cause?: DeadlineChangeCause | undefined;
}

/** "Moves later: 2026-10-14 → 2026-10-21" or "Remove (mark superseded): No grant yet". */
export function deadlineChangeSummary(change: ChangeLike): string {
  if (change.kind === 'removed') {
    return `Remove (mark superseded)${change.reason ? `: ${change.reason}` : ''}`;
  }
  const direction = change.earlier ? 'earlier' : 'later';
  return `Moves ${direction}: ${change.fromDueDate} → ${change.toDueDate ?? '?'}`;
}

/** A critical deadline's proposal needs the matter number typed to accept it. */
export function requiresTypedConfirmation(change: Pick<ChangeLike, 'critical'>): boolean {
  return change.critical;
}

/** Whether the typed confirmation matches the matter number (ignoring case and outer spaces). */
export function confirmationMatches(typed: string | undefined | null, matterNumber: string): boolean {
  return !!typed && typed.trim().toUpperCase() === matterNumber.trim().toUpperCase();
}

/** A critical deadline moved into the past: a red banner (and a high-priority notification). */
export function isUrgentChange(change: Pick<ChangeLike, 'critical' | 'intoPast'>): boolean {
  return change.critical && change.intoPast;
}

/** A reason for waiving or overriding a deadline, for the forms. */
export const DeadlineReasonSchema = Reason;
