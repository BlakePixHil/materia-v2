import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { z } from 'zod';

import { PENDING_UPLOAD_PATH, PENDING_UPLOAD_TTL_MS } from '@materia/domain';

import { filesBucket, storageFiles, type FileStore } from './files';
import { expirePendingUploads, processUpload, type PipelineDeps, type RescanTask, type UploadResult } from './pipeline';
import { startRenditions } from './renditions';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, type Log } from '../core/log';
import { defineQueue, enqueue } from '../core/tasks';
import type { Clock, Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

export const RESCAN_QUEUE = 'documents-rescan';
const GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Production pipeline dependencies: Firestore, the files bucket, the scanner port and Cloud Tasks. */
export function pipelineDeps(
  log: Log,
  overrides: { db?: Firestore; files?: FileStore; ports?: Ports; clock?: Clock } = {},
): PipelineDeps {
  const p = overrides.ports ?? ports();
  const db = overrides.db ?? adminDb();
  const files = overrides.files ?? storageFiles();
  return {
    db,
    files,
    scanner: p.malwareScan,
    clock: overrides.clock ?? systemClock,
    log,
    scheduleRescan: (task, delaySeconds) =>
      enqueue(
        RESCAN_QUEUE,
        { ...task },
        {
          scheduleTime: new Date(Date.now() + delaySeconds * 1000),
          dedupeKey: `${task.path}#${task.generation}#${task.attempt}`,
        },
      ),
    afterVersion: (stored) =>
      startRenditions({ db, files, ports: p, log, clock: overrides.clock ?? systemClock }, stored),
  };
}

/** Runs once per event id (`eventGuards/{id}`), as the Firestore triggers do. */
async function firstDelivery(db: Firestore, eventId: string, now: Date): Promise<boolean> {
  try {
    await db.doc(`eventGuards/${eventId}`).create({
      fn: 'documents-onUpload',
      expiresAt: Timestamp.fromMillis(now.getTime() + GUARD_TTL_MS),
    });
    return true;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return false;
    throw error;
  }
}

/**
 * `documents-onUpload` (CORE-12): Storage `onObjectFinalized` on the files bucket. Ignores
 * everything but `orgs/{orgId}/matters/{matterId}/pending/{uploadId}` and runs the pipeline
 * (`processUpload`). No platform retries: a failure is logged as a dead letter and the sweep
 * expires the upload after 24 hours; scanner outages retry through `documents-rescan`.
 */
export const onUpload = onObjectFinalized(
  { bucket: filesBucket(), region: REGION, memory: '1GiB', timeoutSeconds: 300, retry: false },
  async (event) => {
    const object = event.data;
    if (!PENDING_UPLOAD_PATH.test(object.name)) return;
    const orgId = PENDING_UPLOAD_PATH.exec(object.name)?.[1] ?? null;
    const log = createLog({ fn: 'documents-onUpload', eventId: event.id, orgId });
    const db = adminDb();
    if (!(await firstDelivery(db, event.id, systemClock.now()))) {
      log.info('duplicate event skipped');
      return;
    }
    let result: UploadResult;
    try {
      result = await processUpload(
        {
          path: object.name,
          generation: String(object.generation),
          size: Number(object.size),
          metadata: (object.metadata ?? {}) as Record<string, string>,
        },
        pipelineDeps(log),
      );
    } catch (error) {
      log.error('dead-letter', { deadLetter: true, errorType: error instanceof Error ? error.name : typeof error });
      return;
    }
    log.info('ok', { outcome: result.outcome, docId: result.docId, version: result.version });
  },
);

export const RescanTaskSchema = z.object({
  path: z.string().regex(PENDING_UPLOAD_PATH),
  generation: z.string().min(1),
  attempt: z.number().int().min(1),
});

/**
 * Retries a delayed scan (`documents-rescan`, Cloud Tasks): reads the quarantined object again and
 * reruns the pipeline, which schedules the next attempt with a longer delay if the scanner is
 * still unavailable. Gone objects (stored, swept or replaced) end the chain.
 */
export async function retryScan(task: RescanTask, deps: PipelineDeps): Promise<UploadResult> {
  const object = await deps.files.stat(task.path);
  if (!object || object.generation !== task.generation) return { outcome: 'gone' };
  return processUpload(
    {
      path: task.path,
      generation: task.generation,
      size: object.size,
      metadata: object.metadata,
      attempt: task.attempt,
    },
    deps,
  );
}

export const rescan = defineQueue({
  name: RESCAN_QUEUE,
  input: RescanTaskSchema,
  retry: { maxAttempts: 3, minBackoffSeconds: 60, maxBackoffSeconds: 600 },
  handler: async (task, { log }) => {
    const result = await retryScan(task, pipelineDeps(log));
    log.info('rescanned', { outcome: result.outcome, docId: result.docId, attempt: task.attempt });
  },
});

/** `documents-sweepPending` (hourly): quarantined uploads older than 24 hours are deleted. */
export const sweepPending = onSchedule(
  { schedule: 'every 60 minutes', region: REGION, timeZone: 'Australia/Melbourne', retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'documents-sweepPending' });
    const expired = await expirePendingUploads(pipelineDeps(log), PENDING_UPLOAD_TTL_MS);
    log.info('ok', { expired });
  },
);
