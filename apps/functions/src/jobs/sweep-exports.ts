import type { Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { EXPORT_FILE_PATH, EXPORT_TTL_DAYS } from '@materia/domain';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, type Log } from '../core/log';
import { storageFiles, type FileStore } from '../documents/files';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

export interface ExportSweepDeps {
  db: Firestore;
  files: FileStore;
  clock: Clock;
  log: Log;
}

export interface ExportSweepResult {
  /** Export files deleted. */
  files: number;
  /** Their export jobs deleted. */
  jobs: number;
  /** Files that couldn't be deleted this time (the next run tries again). */
  failed: number;
}

/**
 * Deletes export files (`orgs/{orgId}/exports/{jobId}.{pdf|zip}`: document zips, safe custody
 * receipts and stocktakes, any `export` job's output; CORE-12b, CORE-17) created more than `ttlMs`
 * ago (EXPORT_TTL_DAYS). Each goes by its generation, so the bytes are gone for good rather than
 * kept as a noncurrent version of the versioned bucket. The export job that made it
 * (`orgs/{orgId}/jobs/{jobId}`, whose `output.storagePath` names it) is deleted first, so
 * `jobs-getExportUrl` answers NOT_FOUND rather than signing a link to nothing, and a run that stops
 * between the two leaves only a file, which the next run deletes. One file's failure is logged
 * (ids only) and doesn't stop the rest.
 */
export async function expireExports(
  deps: ExportSweepDeps,
  ttlMs: number = EXPORT_TTL_DAYS * 86_400_000,
): Promise<ExportSweepResult> {
  const { db, files, clock, log } = deps;
  const cutoff = clock.now().getTime() - ttlMs;
  const result: ExportSweepResult = { files: 0, jobs: 0, failed: 0 };
  for (const object of await files.list('orgs/', 'orgs/*/exports/*')) {
    const match = EXPORT_FILE_PATH.exec(object.path);
    if (!match || !object.timeCreated || object.timeCreated.getTime() > cutoff) continue;
    const [, orgId, jobId] = match as unknown as [string, string, string];
    try {
      const job = db.doc(`orgs/${orgId}/jobs/${jobId}`);
      const snap = await job.get();
      if ((snap.get('output') as { storagePath?: unknown } | undefined)?.storagePath === object.path) {
        await job.delete();
        result.jobs++;
      }
      await files.remove(object.path, object.generation);
      result.files++;
      log.info('export expired', { orgId, jobId });
    } catch (error) {
      result.failed++;
      log.error('export not expired', { orgId, jobId, errorType: error instanceof Error ? error.name : typeof error });
    }
  }
  return result;
}

/** `jobs-sweepExports` (CORE-12b): daily at 03:45 Melbourne time, export files older than 7 days. */
export const sweepExports = onSchedule(
  { schedule: '45 3 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 1 },
  async () => {
    const log = createLog({ fn: 'jobs-sweepExports' });
    log.info('ok', { ...(await expireExports({ db: adminDb(), files: storageFiles(), clock: systemClock, log })) });
  },
);
