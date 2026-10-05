import type { DeadlineChangeItem, DeadlineItem, TodayMatter, WithId } from '@materia/data-access/repository';
import { compareDates, DomainError, type DateOnly, type MatterType, type TodayEscalationLike } from '@materia/domain';

import type { TaskEntry } from '../tasks/task-view';

/*
 * The Today screen (CORE-14): view models, the rule for which rows show, and the screen's words.
 * The merging and ordering are pure helpers in `@materia/domain` (`needsAttention`, `dueThisWeek`).
 */

/** A matter as Today names it. */
export interface TodayMatterRef {
  id: string;
  number: string;
  title: string;
  type?: MatterType | undefined;
}

/**
 * The matters Today's rows are on, each looked up once: a ref when it can be shown, `null` when it
 * can't (no access, deleted, gone). A matter not in the map hasn't answered yet.
 */
export type MatterLookup = ReadonlyMap<string, TodayMatterRef | null>;

/** What a matter lookup found, as a lookup entry. */
export function lookupEntry(
  id: string,
  outcome: { matter: TodayMatter | null } | { error: unknown },
): TodayMatterRef | null {
  if ('error' in outcome) {
    const code = outcome.error instanceof DomainError ? outcome.error.code : undefined;
    if (code === 'ACCESS_REVOKED' || code === 'PERMISSION_DENIED' || code === 'NOT_FOUND') return null;
    // Couldn't ask (offline with nothing cached): show the row, without the matter's name.
    return { id, number: '', title: '' };
  }
  const { matter } = outcome;
  if (!matter || matter.deletedAt) return null;
  return { id, number: matter.number, title: matter.title, type: matter.type };
}

/**
 * The rows Today may show: personal ones, and ones on a matter the person can read. Rows on a
 * matter that hasn't been looked up yet wait for it, so nothing restricted flashes up.
 */
export function visibleRows<T extends { matterId?: string | null | undefined }>(
  rows: readonly T[],
  matters: MatterLookup,
): T[] {
  return rows.filter((row) => !row.matterId || !!matters.get(row.matterId));
}

/** `M-2026-0142 · Estate of Margaret Whitfield`, or nothing when the matter's name is unknown. */
export function matterLabel(matter: TodayMatterRef | null | undefined): string {
  if (!matter?.number) return '';
  return `${matter.number} · ${matter.title}`;
}

// ---------- rows ----------

export interface TodayDeadlineVm {
  /** `todayItemKey('deadline', …)`. */
  key: string;
  /** `matterId/deadlineId`: `DeadlineActions`' busy key. */
  rowKey: string;
  matterId: string;
  deadline: WithId<DeadlineItem>;
  matter: TodayMatterRef;
}

export interface TodayChangeVm {
  key: string;
  rowKey: string;
  matterId: string;
  change: WithId<DeadlineChangeItem>;
  matter: TodayMatterRef;
  urgent: boolean;
}

export type AttentionVm =
  | { kind: 'change'; key: string; change: TodayChangeVm }
  | { kind: 'overdue'; key: string; deadline: TodayDeadlineVm }
  | { kind: 'escalation'; key: string; escalation: TodayEscalationLike; matter: TodayMatterRef | null };

export type DueVm =
  | { kind: 'deadline'; key: string; dueDate: DateOnly; deadline: TodayDeadlineVm }
  | { kind: 'task'; key: string; dueDate: DateOnly; entry: TaskEntry };

/** How a due row's timeline node looks: today's are next, later ones upcoming. */
export function dueState(dueDate: DateOnly, today: DateOnly): 'overdue' | 'next' | 'upcoming' {
  const order = compareDates(dueDate, today);
  return order < 0 ? 'overdue' : order === 0 ? 'next' : 'upcoming';
}

/** Where a row's title leads: the matter's tab, or My tasks for a personal task. */
export function taskLink(entry: TaskEntry): string[] {
  return entry.ref.matterId ? ['/matters', entry.ref.matterId, 'tasks'] : ['/tasks'];
}

// ---------- words ----------

export const TODAY_COPY = {
  attentionClear: {
    title: 'Nothing needs attention',
    description: 'No overdue deadlines and no changes waiting on you.',
  },
  weekClear: {
    title: 'Your week is clear',
    description: 'No deadlines or tasks of yours fall due between today and Sunday.',
  },
  tasksClear: {
    title: 'No open tasks with a date',
    description: 'Tasks assigned to you, and your personal tasks, show here by when they’re due.',
  },
  recentEmpty: {
    title: 'No matters opened yet',
    description: 'The matters you open show here, latest first.',
  },
  brief: {
    title: 'Your morning brief',
    description: 'Clerk will sum up what needs you today, with the sources it read. It isn’t ready yet.',
  },
  offline: 'You’re offline. This is your day as it was when you were last connected.',
  loading: 'Loading your day…',
} as const;

/** The device-time-zone hint under the date. */
export function timeZoneHintText(hint: { org: string; device: string }): string {
  return `Dates follow ${hint.org} time, the practice’s time zone. This device is on ${hint.device} time.`;
}
