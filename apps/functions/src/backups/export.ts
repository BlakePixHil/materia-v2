import { applicationDefault } from 'firebase-admin/app';
import type { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  exportedCollectionIds,
  FIRESTORE_COLLECTION_IDS,
  walkCollectionIds,
  type WalkCollection,
} from '@materia/domain';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, errorReportFields, functionsSink, type Log } from '../core/log';

/**
 * The nightly Firestore export (SEC-03): a consistent copy of the whole database, as of a whole
 * minute, written to the exports bucket in the database's region (`<project>-exports`, Terraform;
 * Firestore exports nowhere else), which Storage Transfer copies an hour later into the backups
 * bucket in australia-southeast2 (`<project>-backups`). That copy survives losing
 * australia-southeast1, where PITR and the managed backups live. On the
 * 1st of the month (Melbourne) it goes under `monthly/` (kept 400 days), otherwise `daily/` (kept 35);
 * the folder is named after the snapshot time, `daily/2026-10-05T15-00-00Z`, which is what the
 * restore drill and the runbook read the snapshot time from (docs/runbooks/restore.md).
 *
 * It exports every collection but Clerk's search chunks (SEC-07h, `EXPORT_SKIPPED_COLLECTIONS`),
 * which are most of the bytes and are rebuilt from the documents after a restore. Firestore can't
 * leave a collection out, only list the ones to take, so the job lists every collection firestore.rules
 * knows plus any the restore drill's walk finds; if the walk fails it exports everything.
 */

const FIRESTORE = 'https://firestore.googleapis.com/v1';
/** Stop waiting well inside the function's 30-minute timeout. */
const WAIT_MS = 25 * 60 * 1000;
const POLL_MS = 15_000;

export interface ExportPlan {
  kind: 'daily' | 'monthly';
  /** RFC 3339, whole minute. */
  snapshotTime: string;
  outputUriPrefix: string;
  /** The collection groups to export (SEC-07h); every one when absent. */
  collectionIds?: string[];
}

/**
 * How often the daily export runs (SEC-07h): every night (1). At scale it may run every few days
 * instead, since PITR (7 days) and the daily managed backups cover the database's own region and
 * the export only adds the off-region and long-term copies; docs/ops/cost-model.md says when. The
 * monthly export on the 1st always runs.
 */
export const EXPORT_EVERY_DAYS = 1;

/** The Melbourne calendar day of a time, as a day number (days since 1970-01-01). */
function melbourneDay(at: Date): number {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number);
  return Date.UTC(year as number, (month as number) - 1, day as number) / 86_400_000;
}

/** Whether the plan's night exports: the monthly export always, a daily one every `everyDays` days. */
export function exportDue(plan: Pick<ExportPlan, 'kind' | 'snapshotTime'>, everyDays = EXPORT_EVERY_DAYS): boolean {
  if (plan.kind === 'monthly' || everyDays <= 1) return true;
  return melbourneDay(new Date(plan.snapshotTime)) % everyDays === 0;
}

function walkable(collection: CollectionReference): WalkCollection {
  return {
    id: collection.id,
    path: collection.path,
    async sample(limit) {
      const snap = await collection.select().limit(limit).get();
      return snap.docs.map((doc) => ({
        listCollections: async () => (await doc.ref.listCollections()).map(walkable),
      }));
    },
  };
}

/**
 * The collection ids to export (SEC-07h): every known one and every one the walk finds, less the
 * skipped ones. Undefined (export everything) when the walk fails, so a night is never lost to it.
 */
export async function collectionsToExport(
  walk: () => Promise<string[]>,
  log: Log,
): Promise<{ collectionIds?: string[]; skipped: string[] }> {
  try {
    const found = await walk();
    const unknown = [...new Set(found)].filter((id) => !FIRESTORE_COLLECTION_IDS.includes(id)).sort();
    // Exported all the same; the list in @materia/domain should name it.
    // The ids go in the message too, so backup-status (which shows messages) names them.
    if (unknown.length) {
      log.warn(`collections missing from FIRESTORE_COLLECTION_IDS: ${unknown.join(', ')}`, { collections: unknown });
    }
    const collectionIds = exportedCollectionIds(found);
    const skipped = [...new Set(found)].filter((id) => !collectionIds.includes(id)).sort();
    return { collectionIds, skipped };
  } catch (error) {
    log.warn('collection walk failed, exporting everything', {
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
    return { skipped: [] };
  }
}

/** Every collection id in the database, by the drill's bounded walk. */
export async function walkDatabase(db: Firestore): Promise<string[]> {
  return walkCollectionIds((await db.listCollections()).map(walkable));
}

/** The bucket in the database's region that Terraform creates for a project's exports. */
export const exportsBucket = (projectId: string) => `${projectId}-exports`;

/** `2026-10-05T15:00:00Z` → `2026-10-05T15-00-00Z` (no colons in object names). */
export const exportFolder = (snapshotTime: string) => snapshotTime.replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');

/**
 * What to export for a run at `now`: the database as of the last whole minute at least a minute ago
 * (an export's snapshot time must be in the past and on a minute), under monthly/ on the 1st in
 * Melbourne.
 */
export function exportPlan(projectId: string, now: Date): ExportPlan {
  const snapshot = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 60_000);
  const snapshotTime = snapshot.toISOString().replace('.000Z', 'Z');
  const day = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric' }).format(snapshot);
  const kind = day === '1' ? 'monthly' : 'daily';
  return {
    kind,
    snapshotTime,
    outputUriPrefix: `gs://${exportsBucket(projectId)}/${kind}/${exportFolder(snapshotTime)}`,
  };
}

export interface ExportDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  metadata?: { progressDocuments?: { completedWork?: string } };
}

async function call(deps: ExportDeps, url: string, init: RequestInit = {}): Promise<Operation> {
  const res = await deps.fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await deps.token()}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Firestore admin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Operation;
}

/** Starts the export and waits for it; throws if it fails or outlasts the wait. */
export async function exportFirestore(
  deps: ExportDeps,
  projectId: string,
  plan: ExportPlan,
  log: Log,
): Promise<{ documents: number }> {
  const started = deps.now();
  let op = await call(deps, `${FIRESTORE}/projects/${projectId}/databases/(default):exportDocuments`, {
    method: 'POST',
    body: JSON.stringify({
      outputUriPrefix: plan.outputUriPrefix,
      snapshotTime: plan.snapshotTime,
      ...(plan.collectionIds ? { collectionIds: plan.collectionIds } : {}),
    }),
  });
  log.info('export started', {
    kind: plan.kind,
    snapshotTime: plan.snapshotTime,
    operation: op.name,
    collections: plan.collectionIds?.length ?? 'all',
  });
  while (!op.done) {
    if (deps.now() - started > WAIT_MS)
      throw new Error(`Export ${op.name} still running after ${WAIT_MS / 60_000} minutes`);
    await deps.sleep(POLL_MS);
    op = await call(deps, `${FIRESTORE}/${op.name}`);
  }
  if (op.error) throw new Error(`Export ${op.name} failed: ${op.error.code ?? ''} ${op.error.message ?? ''}`.trim());
  return { documents: Number(op.metadata?.progressDocuments?.completedWork ?? 0) };
}

/**
 * `backups-exportFirestore` (SEC-03): nightly at 02:00 Melbourne; logs "ok" (the scheduled-job alert
 * watches for it), also on a night `EXPORT_EVERY_DAYS` skips (SEC-07h).
 */
export const exportFirestoreJob = onSchedule(
  {
    schedule: '0 2 * * *',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 1,
    timeoutSeconds: 1800,
    memory: '256MiB',
  },
  async () => {
    const log = createLog({ fn: 'backups-exportFirestore' }, functionsSink);
    const projectId = process.env['GCLOUD_PROJECT'];
    if (!projectId) throw new Error('GCLOUD_PROJECT is not set');
    const credential = applicationDefault();
    const deps: ExportDeps = {
      fetch,
      token: async () => (await credential.getAccessToken()).access_token,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    };
    const planned = exportPlan(projectId, new Date());
    if (!exportDue(planned)) {
      log.info('ok', { kind: planned.kind, snapshotTime: planned.snapshotTime, skipped: 'cadence' });
      return;
    }
    const { collectionIds, skipped } = await collectionsToExport(() => walkDatabase(adminDb()), log);
    const plan: ExportPlan = { ...planned, ...(collectionIds ? { collectionIds } : {}) };
    try {
      const { documents } = await exportFirestore(deps, projectId, plan, log);
      log.info('ok', {
        kind: plan.kind,
        snapshotTime: plan.snapshotTime,
        documents,
        collections: collectionIds?.length ?? 'all',
        leftOut: skipped,
      });
    } catch (error) {
      // The reason is the admin API's own error text (status and message), never document data.
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      log.error('export failed', {
        kind: plan.kind,
        snapshotTime: plan.snapshotTime,
        reason,
        ...errorReportFields(error),
      });
      throw error;
    }
  },
);
