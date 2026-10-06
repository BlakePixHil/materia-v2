import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_ORG_TIMEZONE,
  metricShardCount,
  splitMetricsKey,
  type MetricsSourceKind,
  type MetricValues,
} from '@materia/domain';

import type { Log } from '../core/log';
import type { Clock } from '../ports';

/** Paths, the org's metrics settings and the period documents of the INS-01 rollups (ADR-048). */

type Data = Record<string, unknown>;

export const SYSTEM = 'system';

export interface MetricsDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  /** Picks a counter shard (tests pin it). */
  random?: () => number;
}

/** A record whose figures roll up, and the matter whose ledger counts it. */
export interface MetricsSource {
  kind: MetricsSourceKind;
  matterId: string;
  sourceId: string;
}

const MATTER_RECORDS = { time: 'timeEntries', disbursement: 'disbursements', deadline: 'deadlines' } as const;

/** `metrics/{key}`: a period (`month-2026-10`) or a member's figures under one (`month-2026-10/byMember/{uid}`). */
export const metricsPath = (orgId: string, key: string) => `orgs/${orgId}/metrics/${key}`;
export const metricsShardPath = (orgId: string, period: string, shard: number) =>
  `orgs/${orgId}/metrics/${period}/shards/${shard}`;
export const ledgerPath = (orgId: string, source: MetricsSource) =>
  `orgs/${orgId}/matters/${source.matterId}/metrics/${source.kind}-${source.sourceId}`;

export function sourcePath(orgId: string, source: MetricsSource): string {
  switch (source.kind) {
    case 'matter':
      return `orgs/${orgId}/matters/${source.matterId}`;
    case 'invoice':
      return `orgs/${orgId}/invoices/${source.sourceId}`;
    case 'creditNote':
      return `orgs/${orgId}/creditNotes/${source.sourceId}`;
    default:
      return `orgs/${orgId}/matters/${source.matterId}/${MATTER_RECORDS[source.kind]}/${source.sourceId}`;
  }
}

/** What the rollups need from the org: its time zone and FY start (which decide the periods) and how many shards it writes. */
export interface MetricsConfig {
  timeZone: string;
  fyStartMonth: number;
  shards: number;
}

const CONFIG_TTL_MS = 10 * 60 * 1000;
const configs = new Map<string, { at: number; config: MetricsConfig }>();

/** The org's metrics settings, cached per instance for ten minutes (the active-member count is a count query). */
export async function metricsConfig(
  db: Firestore,
  orgId: string,
  nowMs: number,
  fresh = false,
): Promise<MetricsConfig> {
  const cached = configs.get(orgId);
  if (!fresh && cached && nowMs - cached.at < CONFIG_TTL_MS) return cached.config;
  const [org, active] = await Promise.all([
    db.doc(`orgs/${orgId}`).get(),
    db.collection(`orgs/${orgId}/members`).where('status', '==', 'active').count().get(),
  ]);
  const zone = org.get('timezone') as unknown;
  const month = org.get('fy.startMonth') as unknown;
  const config: MetricsConfig = {
    timeZone: typeof zone === 'string' && zone ? zone : DEFAULT_ORG_TIMEZONE,
    fyStartMonth: typeof month === 'number' && Number.isInteger(month) && month >= 1 && month <= 12 ? month : 7,
    shards: metricShardCount(active.data().count),
  };
  configs.set(orgId, { at: nowMs, config });
  return config;
}

/** The documents known to exist on this instance, so a sync creates each one at most once. */
const ensured = new Set<string>();
const ENSURED_MAX = 50_000;

export function resetMetricsCaches(): void {
  configs.clear();
  ensured.clear();
}

const alreadyExists = (error: unknown) =>
  (error as { code?: number | string }).code === 6 || (error as { code?: string }).code === 'already-exists';

/** A document the rollups increment, with what it holds besides `values`. */
export interface MetricsWrite {
  path: string;
  base: Data;
  values: MetricValues;
}

/**
 * Where period figures go: member figures to `byMember/{uid}`; org figures to the period
 * document, or one of its shards when the org shards (more than 20 active members).
 */
export function metricsWrites(
  orgId: string,
  docs: ReadonlyMap<string, MetricValues>,
  shards: number,
  random: () => number = Math.random,
): MetricsWrite[] {
  const shard = shards > 1 ? Math.min(shards - 1, Math.floor(random() * shards)) : null;
  // Never an empty `values`: written with `merge`, an empty map replaces the document's figures.
  return [...docs]
    .filter(([, values]) => Object.keys(values).length)
    .map(([key, values]) => {
      const { period, uid } = splitMetricsKey(key);
      if (uid) return { path: metricsPath(orgId, key), base: { period, uid }, values };
      if (shard !== null) return { path: metricsShardPath(orgId, period, shard), base: { period, shard }, values };
      return { path: metricsPath(orgId, period), base: { period }, values };
    });
}

/**
 * Creates the documents a write is about to increment, with their metadata and empty `values`,
 * when they don't exist yet. Outside the sync's transaction (so hot period documents are never
 * read in one); cached per instance, so each costs a read at most once.
 */
export async function ensureMetricsDocs(db: Firestore, writes: readonly MetricsWrite[], at: Date): Promise<void> {
  // A shard's period document too, so the period is listed (and Clerk reads it) before the nightly fold.
  const parents = writes
    .filter((write) => 'shard' in write.base)
    .map((write) => ({
      path: write.path.slice(0, write.path.lastIndexOf('/shards/')),
      base: { period: write.base['period'] },
    }));
  const missing = [...new Map([...writes, ...parents].map((write) => [write.path, write])).values()].filter(
    (write) => !ensured.has(write.path),
  );
  if (!missing.length) return;
  if (ensured.size > ENSURED_MAX) ensured.clear();
  const snaps = await db.getAll(...missing.map((write) => db.doc(write.path)));
  await Promise.all(
    missing.map(async (write, i) => {
      if (!snaps[i]?.exists) {
        try {
          await db.doc(write.path).create({
            ...write.base,
            values: {},
            createdAt: at,
            createdBy: SYSTEM,
            updatedAt: at,
            updatedBy: SYSTEM,
            schemaVersion: 1,
          });
        } catch (error) {
          if (!alreadyExists(error)) throw error;
        }
      }
      ensured.add(write.path);
    }),
  );
}

/** `values` as server increments (keys with dots are literal under `set` with `merge`). */
export function increments(values: MetricValues): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, FieldValue.increment(value)]));
}

/** The `values` of a metrics document, numbers only. */
export function valuesOf(data: Data | undefined): MetricValues {
  const out: MetricValues = {};
  for (const [key, value] of Object.entries((data?.['values'] as Data | undefined) ?? {}))
    if (typeof value === 'number') out[key] = value;
  return out;
}

/** Whether two records differ in any of these fields (compared as JSON). */
export function changedFields(before: Data | undefined, after: Data | undefined, fields: readonly string[]): boolean {
  if (!before || !after) return true;
  return fields.some((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}
