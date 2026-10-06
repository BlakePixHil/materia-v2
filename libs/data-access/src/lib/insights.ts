import * as z from 'zod';

import {
  addDays,
  dateOnlyAt,
  Matter,
  MemberMetricsVisibilitySchema,
  Org,
  SoftDeleteShape,
  type DateOnly,
  type MatterType,
} from '@materia/domain';

import type { DeadlineItem } from './deadlines';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * A metrics document (INS-01, ADR-048) as the Insights screen reads it (INS-02): a period's figures
 * (`metrics/month-2026-10`, `metrics/fy-2026`), one member's (`…/byMember/{uid}`) or one counter
 * shard's (`…/shards/{n}`), as flat counters under `values`. Functions write them all. Members read
 * the period documents by id (a list can't prove the id), their own figures, and everyone's when
 * the org's `settings.insights.memberVisibility` allows.
 */
export const PeriodMetricsSchema = /* @__PURE__ */ z.object({
  period: z.string().optional(),
  values: z.record(z.string(), z.number()).default({}),
});
export type PeriodMetrics = z.infer<typeof PeriodMetricsSchema>;

/** `orgs/{orgId}/metrics`, read by id (`month-2026-10`, `fy-2026`). */
export function metricsRepository(): Repository<PeriodMetrics> {
  return repo((orgId) => `orgs/${orgId}/metrics`, { schema: PeriodMetricsSchema, version: 1 });
}

/** A period's members' figures (`metrics/{period}/byMember`, by uid) or counter shards (`…/shards`, `0`–`9`). */
export function periodMetricsRepository(period: string, kind: 'byMember' | 'shards'): Repository<PeriodMetrics> {
  return repo((orgId) => `orgs/${orgId}/metrics/${period}/${kind}`, { schema: PeriodMetricsSchema, version: 1 });
}

const org = Org.schema.shape;

/**
 * What the Insights screen reads from `orgs/{orgId}`: the FY start, the daily time target
 * (utilisation), the time zone and who sees every member's figures. Every member reads it.
 */
export const InsightsOrgSchema = /* @__PURE__ */ z.object({
  timezone: z.string().optional(),
  fy: org.fy.optional(),
  billing: z.object({ dailyTargetMinutes: z.number().int().min(0).optional() }).optional(),
  settings: z
    .object({ insights: z.object({ memberVisibility: MemberMetricsVisibilitySchema.optional() }).optional() })
    .optional(),
});
export type InsightsOrg = z.infer<typeof InsightsOrgSchema>;

export function insightsOrgRepository(): Repository<InsightsOrg> {
  return repo(() => 'orgs', { schema: InsightsOrgSchema, version: Org.version });
}

const matter = Matter.schema.shape;

/** A matter as the Insights drill-down lists it: what it is, and when it was opened. */
export const OpenedMatterSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  responsibleUid: matter.responsibleUid,
  privileged: matter.privileged,
  createdAt: matter.createdAt,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type OpenedMatter = z.infer<typeof OpenedMatterSchema>;

export function openedMattersRepository(): Repository<OpenedMatter> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: OpenedMatterSchema, version: Matter.version });
}

/** The most rows a drill-down reads. */
export const INSIGHTS_DRILL_LIMIT = 200;

/**
 * Matters of a type created around `start`..`end` (indexed: deletedAt, [privileged,] type,
 * createdAt). The window is a day wider each side than the org's days, since the query can't
 * know the time zone; `openedInPeriod` keeps those opened on the period's days, as INS-01 counts.
 */
export function openedMattersQuery(
  type: MatterType,
  start: DateOnly,
  end: DateOnly,
  options: { privilegedVisible: boolean },
): QuerySpec<OpenedMatter> {
  return {
    where: [
      ['deletedAt', '==', null],
      ...(options.privilegedVisible ? [] : ([['privileged', '==', false]] as const)),
      ['type', '==', type],
      ['createdAt', '>=', new Date(`${addDays(start, -1)}T00:00:00Z`)],
      ['createdAt', '<', new Date(`${addDays(end, 2)}T00:00:00Z`)],
    ],
    orderBy: [['createdAt', 'asc']],
    pageSize: INSIGHTS_DRILL_LIMIT,
  };
}

/** Whether a matter counts as opened in the period (INS-01: created on its days, and not still a lead). */
export function openedInPeriod(row: OpenedMatter, start: DateOnly, end: DateOnly, timeZone: string): boolean {
  if (row.deletedAt || row.status === 'lead') return false;
  const day = dateOnlyAt(row.createdAt, timeZone);
  return day >= start && day <= end;
}

/** Deadlines in a status due `start`..`end`, earliest first (indexed: orgId, [privileged,] status, dueDate). */
export function deadlinesDueQuery(
  status: 'done' | 'missed' | 'waived',
  start: DateOnly,
  end: DateOnly,
): QuerySpec<DeadlineItem> {
  return {
    where: [
      ['status', '==', status],
      ['dueDate', '>=', start],
      ['dueDate', '<=', end],
    ],
    orderBy: [['dueDate', 'asc']],
    pageSize: INSIGHTS_DRILL_LIMIT,
  };
}
