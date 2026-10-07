import type { DeadlineChangeItem, DeadlineItem, WithId } from '@materia/data-access/repository';
import {
  DomainError,
  ruleSetFlagKey,
  type DateOnly,
  type DeadlineStatus,
  type EventKind,
  type FlagKey,
  type Jurisdiction,
  type RecomputeSummary,
} from '@materia/domain';

import { errorCopy } from '../../core/error-copy';

/**
 * Words and small helpers for the Deadlines screen and the matter's Deadlines tab (CORE-10). The
 * grouping, filters, calendar and traces themselves are pure helpers in `@materia/domain`.
 */

export const DEADLINE_KIND_LABELS: Readonly<Record<string, string>> = {
  statutory: 'Statutory',
  court: 'Court',
  contractual: 'Contractual',
  internal: 'Internal',
  court_watch: 'Court watch',
};

export function deadlineKindLabel(kind: string): string {
  return DEADLINE_KIND_LABELS[kind] ?? kind;
}

/** Matter event kinds in words ("Grant issued"), for requirement notes and template due dates. */
export const EVENT_KIND_LABELS: Readonly<Record<EventKind, string>> = {
  date_of_death: 'Date of death',
  will_located: 'Will located',
  notice_published: 'Notice of intended application published',
  probate_filed: 'Probate application filed',
  grant_issued: 'Grant issued',
  statutory_notice_published: 'Statutory notice to claimants published',
  caveat_lodged: 'Caveat lodged',
  grant_served: 'Grant served',
  fp_claim_filed: 'Family provision claim filed',
  hearing: 'Hearing',
  order_made: 'Order made',
  offer_made: 'Offer made',
  custom: 'Custom event',
};

export function eventKindLabel(kind: EventKind): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}

export const DEADLINE_STATUS_LABELS: Readonly<Record<DeadlineStatus, string>> = {
  upcoming: 'Upcoming',
  done: 'Done',
  missed: 'Missed',
  waived: 'Waived',
  superseded: 'Superseded',
  blocked: 'Waiting',
};

/** The badges `deadlineFlags` asks for. */
export const DEADLINE_FLAG_LABELS = {
  past_on_creation: 'Already past when computed',
  override_conflict: 'Computed date now earlier',
  missed_check: 'Past due: confirm',
} as const;

/** What made a recompute propose a change. */
export const CHANGE_CAUSE_LABELS: Readonly<Record<string, string>> = {
  event: 'An event changed',
  stage: 'The stage changed',
  recompute: 'Recomputed',
  ruleset_upgrade: 'Rule set upgraded',
  matter_created: 'Matter opened',
};

/**
 * The feature flag gating a jurisdiction's statutory rules (the rule set's practitioner review):
 * Victoria's rule set v1 for now. Undefined where no rule set exists yet.
 */
const STATUTORY_FLAGS: Partial<Record<Jurisdiction, FlagKey>> = {
  VIC: ruleSetFlagKey('deadlines.ruleset.vic', 1) as FlagKey,
};

export function statutoryFlagFor(jurisdiction: Jurisdiction | undefined): FlagKey | undefined {
  return jurisdiction ? STATUTORY_FLAGS[jurisdiction] : undefined;
}

/** Every rule-set flag the screens check. */
export const STATUTORY_FLAG_KEYS: readonly FlagKey[] = Object.values(STATUTORY_FLAGS) as FlagKey[];

// ---------- months ----------

/** `2026-10` for a date. */
export function monthOf(date: DateOnly): string {
  return date.slice(0, 7);
}

/** The month `delta` months from `month` (`YYYY-MM`). */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const monthFormatter = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormatter = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** `October 2026`. */
export function monthLabel(month: string): string {
  return monthFormatter.format(new Date(`${month}-01T00:00:00Z`));
}

/** `Monday 5 October`, for a calendar day's accessible name. */
export function dayLabel(date: DateOnly): string {
  return dayFormatter.format(new Date(`${date}T00:00:00Z`));
}

/** The weekday headings of a Monday-first week. */
export const WEEKDAYS = [
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
  { short: 'Sun', long: 'Sunday' },
] as const;

// ---------- results and errors ----------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a recompute changed, in words for a toast and the live region: "2 deadline changes need
 * review · 1 deadline added". Empty when nothing changed.
 */
export function recomputeSummaryText(summary: Pick<RecomputeSummary, 'proposed' | 'created'> | undefined): string {
  if (!summary) return '';
  const parts: string[] = [];
  if (summary.proposed.length) {
    parts.push(
      `${plural(summary.proposed.length, 'deadline change')} ${summary.proposed.length === 1 ? 'needs' : 'need'} review`,
    );
  }
  if (summary.created.length) parts.push(`${plural(summary.created.length, 'deadline')} added`);
  return parts.join(' · ');
}

/**
 * What a deadlines callable refused, in words: the reason the server named, or the field it
 * flagged (a date of death in the future, a confirmation that doesn't match), else the code's copy.
 */
export function deadlineErrorCopy(error: unknown): string {
  const details = error instanceof DomainError ? error.details : undefined;
  switch (details?.['reason']) {
    case 'change_not_pending':
      return 'Someone has already decided this change.';
    case 'deadline_not_open':
      return 'This deadline is already closed.';
    case 'not_past_due':
      return 'A deadline can be confirmed missed only once its date has passed.';
    case 'manual_deadline':
      return 'Change a manual deadline’s date by editing it.';
    case 'deadline_outcome_requires_lawyer':
      return 'Only a lawyer can waive a deadline or confirm it missed.';
  }
  const fields = details?.['fields'];
  if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && fields && typeof fields === 'object') {
    const messages = Object.values(fields as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [],
    );
    if (messages.length) return `${messages.join('. ')}.`;
  }
  return errorCopy(error);
}

// ---------- rows ----------

/** A matter as the deadline lists name it. */
export interface DeadlineMatterRef {
  id: string;
  number: string;
  title: string;
  jurisdiction?: Jurisdiction | undefined;
  responsibleUid?: string | undefined;
  teamUids?: readonly string[] | undefined;
}

/** A deadline and the matter it's on. */
export interface DeadlineRowVm {
  /** `matterId/deadlineId`: unique across matters. */
  key: string;
  matterId: string;
  deadline: WithId<DeadlineItem>;
  matter?: DeadlineMatterRef | undefined;
}

/** A proposal and the matter it's on. */
export interface ChangeRowVm {
  key: string;
  matterId: string;
  change: WithId<DeadlineChangeItem>;
  matter?: DeadlineMatterRef | undefined;
}

/**
 * Whether two values read from Firestore hold the same data: primitives, dates, arrays and plain
 * objects, compared by value (a key set to undefined is the same as a missing one).
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameData(left[key], right[key])) return false;
  return true;
}

/** Closed deadlines (the matter tab lists them apart). */
export function isClosedDeadline(status: DeadlineStatus): boolean {
  return status === 'done' || status === 'waived' || status === 'missed' || status === 'superseded';
}

/** "Missed" may be confirmed once the daily check asked, or for a deadline past on creation. */
export function canConfirmMissed(deadline: Pick<DeadlineItem, 'missedCheck' | 'pastOnCreation' | 'status'>): boolean {
  return deadline.status === 'upcoming' && (!!deadline.missedCheck || !!deadline.pastOnCreation);
}

/** A manual deadline (no rule): edited and deleted directly. */
export function isManual(deadline: Pick<DeadlineItem, 'computed'>): boolean {
  return !deadline.computed;
}
