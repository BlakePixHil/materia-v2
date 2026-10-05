import { inject } from '@angular/core';
import { z } from 'zod';

import {
  Matter,
  Member,
  OPEN_TASK_STATUSES,
  Org,
  RECENT_MATTERS_SHOWN,
  RecentMatter,
  recentMatterExpireAt,
  recentMatterId,
  SoftDeleteShape,
  TODAY_SECTION_LIMIT,
  type DateOnly,
  type TodayWindow,
} from '@materia/domain';

import type { DeadlineChangeItem, DeadlineItem } from './deadlines';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { TaskItem } from './tasks';

/*
 * The Today screen's reads (CORE-14). Every list is the signed-in person's own: deadlines and
 * proposals assigned to them, tasks assigned to them, matters they are responsible for, and the
 * matters they opened lately. Group queries are scoped to the active org by `groupRepo`; each
 * section reads at most `TODAY_SECTION_LIMIT` rows (the resource reads one more to know there is
 * more). The indexes are in firebase/firestore.indexes.json.
 */

// ---------- deadlines and proposals ----------

/** My overdue deadlines, oldest first (indexed: orgId, assigneeUid, status, dueDate). */
export const myOverdueDeadlinesQuery = (uid: string, today: DateOnly): QuerySpec<DeadlineItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', '==', 'upcoming'],
    ['dueDate', '<', today],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: TODAY_SECTION_LIMIT,
});

/** My deadlines from today to Sunday (indexed: orgId, assigneeUid, status, dueDate). */
export const myDeadlinesThisWeekQuery = (uid: string, window: TodayWindow): QuerySpec<DeadlineItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', '==', 'upcoming'],
    ['dueDate', '>=', window.today],
    ['dueDate', '<=', window.weekEnd],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: TODAY_SECTION_LIMIT,
});

/**
 * Critical deadlines escalated to me (CORE-11), soonest first; the screen drops the acknowledged
 * ones (indexed: orgId, escalatedTo contains, status, dueDate).
 */
export const myEscalationsQuery = (uid: string): QuerySpec<DeadlineItem> => ({
  where: [
    ['escalatedTo', 'array-contains', uid],
    ['status', '==', 'upcoming'],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: TODAY_SECTION_LIMIT,
});

/** Pending proposals waiting on me, newest first (indexed: orgId, assigneeUid, status, createdAt). */
export const myTodayChangesQuery = (uid: string): QuerySpec<DeadlineChangeItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', '==', 'pending'],
  ],
  orderBy: [['createdAt', 'desc']],
  pageSize: TODAY_SECTION_LIMIT,
});

// ---------- tasks ----------

/** My open tasks due from today to Sunday (indexed: orgId, assigneeUid, status, dueDate). */
export const myTasksThisWeekQuery = (uid: string, window: TodayWindow): QuerySpec<TaskItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', 'in', [...OPEN_TASK_STATUSES]],
    ['dueDate', '>=', window.today],
    ['dueDate', '<=', window.weekEnd],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: TODAY_SECTION_LIMIT,
});

/**
 * My open tasks with a due date, soonest (most overdue) first: the short My tasks list (indexed:
 * orgId, assigneeUid, status, dueDate). Tasks without a date are on `/tasks`.
 */
export const myNextTasksQuery = (uid: string, count: number): QuerySpec<TaskItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', 'in', [...OPEN_TASK_STATUSES]],
  ],
  orderBy: [['dueDate', 'asc']],
  pageSize: count,
});

/** All my open tasks, for `count()` (equality filters; indexed: orgId, assigneeUid, status). */
export const myOpenTaskCountQuery = (uid: string): QuerySpec<TaskItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['status', 'in', [...OPEN_TASK_STATUSES]],
  ],
});

// ---------- matters ----------

const matter = Matter.schema.shape;

/**
 * A matter as Today names it: number, title and type, and whether it is still live (plus the
 * fields its counts filter on).
 */
export const TodayMatterSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  privileged: matter.privileged,
  responsibleUid: matter.responsibleUid,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type TodayMatter = z.infer<typeof TodayMatterSchema>;

/** The active org's matters, read one at a time (each row's matter, each recent matter). */
export function todayMatterRepository(): Repository<TodayMatter> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: TodayMatterSchema, version: Matter.version });
}

/**
 * Live matters, for `count()`: everyone's (`responsibleUid` unset) or the ones I am responsible
 * for, optionally of one status. Without privileged.view the rules only allow a query that proves
 * `privileged == false`. Equality filters only, served by the Matters list indexes.
 */
export function matterCountQuery(options: {
  privilegedVisible: boolean;
  responsibleUid?: string;
  status?: TodayMatter['status'];
}): QuerySpec<TodayMatter> {
  return {
    where: [
      ['deletedAt', '==', null],
      ...(options.privilegedVisible ? [] : [['privileged', '==', false] as const]),
      ...(options.status ? [['status', '==', options.status] as const] : []),
      ...(options.responsibleUid ? [['responsibleUid', '==', options.responsibleUid] as const] : []),
    ],
  };
}

// ---------- members and the org ----------

const member = Member.schema.shape;

/** Active members, for `count()` ("Invite your team" is done once there is someone else). */
export const MemberStatusSchema = /* @__PURE__ */ z.object({ status: member.status });
export function memberCountRepository(): Repository<z.infer<typeof MemberStatusSchema>> {
  return repo((orgId) => `orgs/${orgId}/members`, { schema: MemberStatusSchema, version: Member.version });
}
export const ACTIVE_MEMBERS_QUERY: QuerySpec<z.infer<typeof MemberStatusSchema>> = {
  where: [['status', '==', 'active']],
};

const org = Org.schema.shape;

/** The org's time zone (`orgs/{orgId}.timezone`): Today's day boundary. */
export const OrgTimeZoneSchema = /* @__PURE__ */ z.object({ timezone: org.timezone });
export function orgTimeZoneRepository(): Repository<z.infer<typeof OrgTimeZoneSchema>> {
  return repo(() => 'orgs', { schema: OrgTimeZoneSchema, version: Org.version });
}

// ---------- recent matters ----------

export type RecentMatterItem = z.infer<typeof RecentMatter.schema>;

/**
 * The signed-in person's recently opened matters (`users/{uid}/recent/{orgId}_{matterId}`,
 * CORE-14). Private to them; the matter screen records each open with `recordRecentMatter`. Call
 * it in an injection context.
 */
export function recentMattersRepository(): Repository<RecentMatterItem> {
  const context = inject(OrgContext);
  return repo(() => `users/${context.requireUid()}/recent`, RecentMatter);
}

/** The latest matters I opened in an org (indexed: orgId, updatedAt desc). */
export const recentMattersQuery = (orgId: string): QuerySpec<RecentMatterItem> => ({
  where: [['orgId', '==', orgId]],
  orderBy: [['updatedAt', 'desc']],
  pageSize: RECENT_MATTERS_SHOWN,
});

/**
 * Records that I opened a matter: the whole entry is written again, so `updatedAt` moves to now
 * and `expireAt` 90 days on. Not awaited by callers: offline, it's saved when back online.
 */
export function recordRecentMatter(
  recents: Pick<Repository<RecentMatterItem>, 'create'>,
  orgId: string,
  matterId: string,
  now: Date,
): Promise<string> {
  return recents.create(
    { orgId, matterId, expireAt: recentMatterExpireAt(now) },
    { id: recentMatterId(orgId, matterId) },
  );
}
