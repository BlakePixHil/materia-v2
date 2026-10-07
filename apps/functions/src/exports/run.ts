import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  attachmentDisposition,
  DocIdSchema,
  EXPORT_KIND_LABELS,
  ExportKindSchema,
  today as todayIn,
  validTimeZone,
  type ExportJobInput,
  type Role,
} from '@materia/domain';

import { stillAllowed, writeExport, type ExportScope } from './build';
import { RUN_EXPORT_QUEUE } from './create';
import type { Log } from '../core/log';
import { defineQueue } from '../core/tasks';
import { storageFiles, type FileStore } from '../documents/files';
import { exportFileName } from '../jobs/get-export-url';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

export const RunExportTask = z.object({ orgId: DocIdSchema, jobId: DocIdSchema });

/** Attempts the queue makes before the job is marked failed. */
export const RUN_EXPORT_ATTEMPTS = 3;

export interface RunExportDeps {
  db: Firestore;
  files: FileStore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
  /** The queue's retry count for this attempt (0 first). */
  attempt: number;
  pageSize?: number;
}

export type RunExportOutcome = 'succeeded' | 'failed' | 'skipped' | 'discarded';

/**
 * Runs one queued CSV export (INS-03, ADR-055): streams the file, re-checks at the end that the
 * member who asked may still have it (a removal or role change while it ran discards it), then
 * marks the job succeeded and sends `export_ready` (in-app and email) with a link that downloads
 * it. A job already finished is skipped. A failure is retried by the queue; the last attempt marks
 * the job failed (retryable) so the screen stops waiting.
 */
export async function runExport(deps: RunExportDeps, task: z.infer<typeof RunExportTask>): Promise<RunExportOutcome> {
  const { db, clock, log } = deps;
  const { orgId, jobId } = task;
  const ref = db.doc(`orgs/${orgId}/jobs/${jobId}`);
  const job = (await ref.get()).data();
  if (!job || job['type'] !== 'csv.export' || job['status'] === 'succeeded' || job['status'] === 'failed') {
    log.info('export skipped', { jobId, status: job?.['status'] ?? null });
    return 'skipped';
  }
  const uid = String(job['createdBy']);
  const input = job['input'] as ExportJobInput;
  const request: ExportJobInput = {
    kind: ExportKindSchema.parse(input.kind),
    filters: input.filters ?? {},
    includePrivileged: input.includePrivileged === true,
  };
  const fail = async (code: string, message: string, retryable: boolean) => {
    const at = clock.now();
    await ref.update({ status: 'failed', error: { code, message, retryable }, finishedAt: at, updatedAt: at });
  };

  if (!(await stillAllowed(db, orgId, uid, request))) {
    await fail('PERMISSION_DENIED', 'Access changed before the export ran', false);
    log.warn('export refused: access changed', { jobId });
    return 'discarded';
  }
  const started = clock.now();
  await ref.update({
    status: 'running',
    attempts: Number(job['attempts'] ?? 0) + 1,
    startedAt: started,
    heartbeatAt: started,
    updatedAt: started,
  });

  const [member, org] = await db.getAll(db.doc(`orgs/${orgId}/members/${uid}`), db.doc(`orgs/${orgId}`));
  const timeZone = validTimeZone(org?.get('timezone') as string | undefined);
  const now = clock.now();
  const scope: ExportScope = {
    db,
    orgId,
    uid,
    role: member?.get('role') as Role,
    request,
    timeZone,
    now,
    today: todayIn(timeZone, now),
  };
  const total = Number((job['progress'] as { total?: number } | undefined)?.total ?? 0);
  const name = String((job['target'] as { name?: string } | undefined)?.name ?? EXPORT_KIND_LABELS[request.kind]);
  try {
    const file = await writeExport(deps.files, scope, jobId, {
      disposition: attachmentDisposition(exportFileName(name, 'csv')),
      ...(deps.pageSize ? { pageSize: deps.pageSize } : {}),
      onRows: async (rows) => {
        const at = clock.now();
        await ref.update({
          progress: { done: rows, total: Math.max(total, rows), stage: 'exporting' },
          heartbeatAt: at,
          updatedAt: at,
        });
      },
    });
    if (!(await stillAllowed(db, orgId, uid, request))) {
      await deps.files.remove(file.storagePath);
      await fail('PERMISSION_DENIED', 'Access changed during the export', false);
      log.warn('export discarded: access changed', { jobId });
      return 'discarded';
    }
    const at = clock.now();
    await ref.update({
      status: 'succeeded',
      progress: { done: file.rows, total: file.rows, stage: 'exporting' },
      output: {
        storagePath: file.storagePath,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        pages: 0,
        rows: file.rows,
      },
      finishedAt: at,
      updatedAt: at,
    });
    const label = EXPORT_KIND_LABELS[request.kind];
    const sent = await notify(
      { db, orgId, clock, log, ports: deps.ports },
      {
        kind: 'export_ready',
        exportId: jobId,
        recipients: [uid],
        title: `Your ${label.toLowerCase()} export is ready`,
        body: `${file.rows.toLocaleString('en-AU')} rows. The file is kept for 7 days.`,
        link: `/exports/${jobId}`,
        key: `export-${jobId}`,
      },
    );
    log.info('export written', { jobId, kind: request.kind, rows: file.rows, notified: sent.ids.length });
    return 'succeeded';
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    if (deps.attempt + 1 < RUN_EXPORT_ATTEMPTS) {
      log.warn('export attempt failed; retrying', { jobId, attempt: deps.attempt, errorType });
      throw error;
    }
    await fail('UNAVAILABLE', 'The export couldn’t be written', true);
    log.error('export failed', { jobId, attempt: deps.attempt, errorType });
    return 'failed';
  }
}

/** `exports-run` (INS-03): one large CSV export per task, up to 30 minutes. */
export const run = defineQueue({
  name: RUN_EXPORT_QUEUE,
  input: RunExportTask,
  retry: { maxAttempts: RUN_EXPORT_ATTEMPTS, minBackoffSeconds: 30 },
  rateLimits: { maxConcurrentDispatches: 5 },
  timeoutSeconds: 1800,
  memory: '1GiB',
  handler: async (task, ctx) => {
    await runExport(
      {
        db: ctx.db,
        files: storageFiles(),
        clock: ctx.ports.clock,
        log: ctx.log,
        ports: ctx.ports,
        attempt: ctx.attempt,
      },
      task,
    );
  },
});
