import { applicationDefault } from 'firebase-admin/app';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { REGION } from '../config';
import { createLog, errorReportFields, functionsSink, type Log } from '../core/log';

/**
 * The nightly Firestore export (SEC-03): a consistent copy of the whole database, as of a whole
 * minute, in the backups bucket in australia-southeast2 (`<project>-backups`, Terraform). It is the
 * copy that survives losing australia-southeast1, where PITR and the managed backups live. On the
 * 1st of the month (Melbourne) it goes under `monthly/` (kept 400 days), otherwise `daily/` (kept 35);
 * the folder is named after the snapshot time, `daily/2026-10-05T15-00-00Z`, which is what the
 * restore drill and the runbook read the snapshot time from (docs/runbooks/restore.md).
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
}

/** The backups bucket Terraform creates for a project. */
export const backupsBucket = (projectId: string) => `${projectId}-backups`;

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
    outputUriPrefix: `gs://${backupsBucket(projectId)}/${kind}/${exportFolder(snapshotTime)}`,
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
    body: JSON.stringify({ outputUriPrefix: plan.outputUriPrefix, snapshotTime: plan.snapshotTime }),
  });
  log.info('export started', { kind: plan.kind, snapshotTime: plan.snapshotTime, operation: op.name });
  while (!op.done) {
    if (deps.now() - started > WAIT_MS)
      throw new Error(`Export ${op.name} still running after ${WAIT_MS / 60_000} minutes`);
    await deps.sleep(POLL_MS);
    op = await call(deps, `${FIRESTORE}/${op.name}`);
  }
  if (op.error) throw new Error(`Export ${op.name} failed: ${op.error.code ?? ''} ${op.error.message ?? ''}`.trim());
  return { documents: Number(op.metadata?.progressDocuments?.completedWork ?? 0) };
}

/** `backups-exportFirestore` (SEC-03): nightly at 02:00 Melbourne; logs "ok" (the scheduled-job alert watches for it). */
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
    const plan = exportPlan(projectId, new Date());
    try {
      const { documents } = await exportFirestore(deps, projectId, plan, log);
      log.info('ok', { kind: plan.kind, snapshotTime: plan.snapshotTime, documents });
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
