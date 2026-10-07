import * as z from 'zod';

import { DateOnlySchema, DocIdSchema, withMeta } from './common';

/**
 * The documents behind the INS-01 metrics rollups (ADR-048), next to the period documents
 * themselves (`Metrics`, `orgs/{orgId}/metrics/{period}`). Functions write all of them.
 */

const ORG = 'orgs/{orgId}';
const MATTER = 'orgs/{orgId}/matters/{matterId}';

/** Flat counters: `time.minutes`, `matters.opened.type.probate`, `cycle.probate.instructionsToGrant.d212`. */
export const MetricValuesSchema = z.record(z.string(), z.number());

/**
 * `metrics/{period}/byMember/{uid}`: one member's figures for a `day-`, `month-` or `fy-` period
 * (time recorded, billable and billed). Each member reads their own; who reads everyone's follows
 * the org's `settings.insights.memberVisibility` (lawyers and above by default).
 */
export const MemberMetrics = withMeta(
  () => ({
    period: z.string().regex(/^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4})$/),
    uid: DocIdSchema,
    values: MetricValuesSchema,
  }),
  { path: `${ORG}/metrics/{period}/byMember`, migratable: false, updatable: [] },
);
export type MemberMetrics = z.infer<typeof MemberMetrics.schema>;

/** How many counter shards a large org's period documents use, and when they start (INS-01). */
export const METRIC_SHARDS = 10;
/** Orgs with more active members than this write their counters to shards. */
export const METRIC_SHARD_MEMBER_THRESHOLD = 20;

/**
 * `metrics/{period}/shards/{0-9}`: part of a large org's counters for the period. The period's
 * figures are its own `values` plus every shard's, summed on read (`sumMetricShards`); the nightly
 * recompute folds the shards back into the period document.
 */
export const MetricsShard = withMeta(
  () => ({
    period: z.string().regex(/^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4})$/),
    shard: z
      .number()
      .int()
      .min(0)
      .max(METRIC_SHARDS - 1),
    values: MetricValuesSchema,
  }),
  { path: `${ORG}/metrics/{period}/shards`, migratable: false, updatable: [] },
);
export type MetricsShard = z.infer<typeof MetricsShard.schema>;

/** The records whose figures roll up, each counted once in its matter's ledger. */
export const MetricsSourceKindSchema = z.enum(['matter', 'time', 'disbursement', 'deadline', 'invoice', 'creditNote']);
export type MetricsSourceKind = z.infer<typeof MetricsSourceKindSchema>;

/** One stay in a matter stage, for the stage durations (`stage.{type}.{stage}.d{days}`). */
export const StageVisitSchema = z.object({
  stageId: z.string().min(1),
  enteredOn: DateOnlySchema,
  leftOn: DateOnlySchema.optional(),
});
export type StageVisit = z.infer<typeof StageVisitSchema>;

/**
 * `matters/{matterId}/metrics/{kind}-{id}` (server-only): what one record has added to the org's
 * metrics, by day and member (`counted`: `2026-10-06` or `2026-10-06|{uid}` → values). The sync
 * applies the difference between what the record should add now and what was counted, so a
 * repeated, late or out-of-order event changes nothing, and the record's matter keeps it (a
 * destroyed matter's ledger goes with it). The matter's own ledger also keeps its stage history.
 */
export const MetricsLedger = withMeta(
  () => ({
    orgId: DocIdSchema,
    matterId: DocIdSchema,
    kind: MetricsSourceKindSchema,
    sourceId: DocIdSchema,
    counted: z.record(z.string(), MetricValuesSchema),
    stages: z.array(StageVisitSchema).optional(),
  }),
  { path: `${MATTER}/metrics`, migratable: false, updatable: [] },
);
export type MetricsLedger = z.infer<typeof MetricsLedger.schema>;
