import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import { awaitsMigrationEnrichment, DocIdSchema, PERMISSIONS, type DocumentIngest } from '@materia/domain';

import { deleteChunks, syncChunksPrivileged } from './chunks';
import { gatewayIngestClerk } from './clerk';
import {
  INGEST_QUEUE,
  ingestDocument,
  IngestTaskSchema,
  ingestTaskKey,
  markIngestFailed,
  type IngestDeps,
  type IngestTask,
} from './pipeline';
import { clerkGateway } from '../../clerk/service';
import { isDeleted } from '../../contacts/shared';
import { defineCallable, type CallableDefinition } from '../../core/callable';
import type { Log } from '../../core/log';
import { isMigrationWrite } from '../../core/migration';
import { defineQueue } from '../../core/tasks';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../../core/trigger';
import { matterPath } from '../../matters/shared';
import type { Ports, TaskQueuePort } from '../../ports';
import { systemClock } from '../../ports/container';
import { storageFiles, type FileStore } from '../files';

export { chunkSearch, FakeChunkSearch, type ChunkHit, type ChunkSearchInput, type ChunkSearchPort } from './search';
export { INGEST_QUEUE, ingestDocument, type IngestTask } from './pipeline';

type Data = Record<string, unknown>;

const ingestOf = (doc: Data | undefined) => (doc?.['ingest'] ?? { status: 'pending' }) as DocumentIngest;

/**
 * Whether a document's current version still needs ingesting: live, scanned clean, with a version,
 * and its ingest not started or finished for that version (`pending`, `failed`, or an older one).
 */
export function needsIngest(doc: Data | undefined): boolean {
  if (!doc || isDeleted(doc)) return false;
  if ((doc['scan'] as { status?: string } | undefined)?.status !== 'clean') return false;
  const version = Number(doc['version'] ?? 0);
  if (version < 1) return false;
  const ingest = ingestOf(doc);
  if (ingest.version !== undefined && ingest.version !== version) return true;
  return ingest.status === 'pending';
}

/**
 * `documents-onIngestChange` (AI-04): a Firestore trigger on documents that
 * - enqueues `documents-ingest` when a version becomes ready (`scan.status → clean`, a new
 *   version, a restore, or a re-ingest request), once per transition;
 * - copies a change of `privileged` to every chunk (the vector index pre-filters on it);
 * - deletes the chunks of a removed document, and marks it `pending` so restoring it re-ingests.
 */
export async function onIngestChangeHandler(change: TriggerChange, ctx: TriggerContext): Promise<void> {
  const before = change.before?.data();
  const after = change.after?.data();
  const ref = (change.after ?? change.before)?.ref as DocumentReference | undefined;
  if (!ref) return;
  const ids = { matterId: ctx.params['matterId'], docId: ctx.params['docId'] };

  if (!after || isDeleted(after)) {
    if (before && !isDeleted(before)) {
      const deleted = await deleteChunks(ctx.db, ref);
      if (after && ingestOf(after).status !== 'pending') await ref.update({ ingest: { status: 'pending' } });
      ctx.log.info('chunks deleted with the document', { ...ids, deleted });
    }
    return;
  }

  if (before && (before['privileged'] === true) !== (after['privileged'] === true)) {
    const updated = await syncChunksPrivileged(ctx.db, ref, after['privileged'] === true);
    ctx.log.info('chunk privilege updated', { ...ids, updated });
  }

  const version = Number(after['version'] ?? 0);
  const wasWaiting = needsIngest(before) && Number(before?.['version'] ?? 0) === version;
  // Migrated documents are read by the migration's enrichment once an owner approves its cost (MIG-09).
  if (needsIngest(after) && !wasWaiting && !isMigrationWrite(before, after)) {
    const task: IngestTask = {
      orgId: ctx.params['orgId'] as string,
      matterId: ctx.params['matterId'] as string,
      docId: ctx.params['docId'] as string,
      version,
    };
    await ctx.ports.tasks.enqueue(INGEST_QUEUE, task, { dedupeKey: ingestTaskKey(task, ctx.eventId) });
    ctx.log.info('ingest queued', { ...ids, version });
  }
}

export const onIngestChangeDefinition: TriggerDefinition = {
  name: 'documents-onIngestChange',
  document: 'orgs/{orgId}/matters/{matterId}/documents/{docId}',
  on: 'written',
  handler: onIngestChangeHandler,
};

export const onIngestChange = defineTrigger(onIngestChangeDefinition);

/** Production ingest dependencies: Firestore, the files bucket, Vertex embeddings and Clerk. */
export function ingestDeps(
  db: Firestore,
  ports: Ports,
  log: Log,
  task: IngestTask,
  files: FileStore = storageFiles(),
): IngestDeps {
  const gateway = clerkGateway({ db, ports, clock: systemClock });
  return {
    db,
    files,
    embedding: ports.embedding,
    tasks: ports.tasks,
    clock: systemClock,
    log,
    clerk: gatewayIngestClerk(gateway, (orgId) => ({
      orgId,
      uid: 'system',
      // Clerk calls need a role with clerk.use; ingestion runs for the org, as its admin would.
      role: 'admin',
      requestId: `ingest-${task.docId}-v${task.version}`,
      log,
      clock: systemClock,
    })),
  };
}

const MAX_ATTEMPTS = 5;

/**
 * `documents-ingest` (AI-04, Cloud Tasks): ingests one document version. Retried with backoff
 * (embedding or Clerk outages); a long PDF hands over to a continuation task at a checkpoint. The
 * last failed attempt marks the version `failed`, so the backfill can pick it up again.
 */
export const ingest = defineQueue({
  name: INGEST_QUEUE,
  input: IngestTaskSchema,
  retry: { maxAttempts: MAX_ATTEMPTS, minBackoffSeconds: 60, maxBackoffSeconds: 900 },
  // Few at once: OCR and embeddings are paid calls, and one user rarely uploads many at a time.
  rateLimits: { maxConcurrentDispatches: 3 },
  timeoutSeconds: 540,
  memory: '2GiB',
  handler: async (task, { log, db, ports, attempt }) => {
    try {
      const outcome = await ingestDocument(task, ingestDeps(db, ports, log, task));
      log.info('ingest', { outcome, docId: task.docId, version: task.version });
    } catch (error) {
      log.warn('ingest attempt failed', {
        docId: task.docId,
        version: task.version,
        attempt,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      if (attempt + 1 < MAX_ATTEMPTS) throw error;
      await markIngestFailed(db, task, error, systemClock.now());
    }
  },
});

/**
 * Enqueues ingestion for every live, clean document in the org (or one matter) whose current
 * version isn't ingested yet or failed: documents from before AI-04. Migrated documents Clerk
 * hasn't read are left to the migration's enrichment, which an owner approves first (MIG-09).
 * `runId` makes the tasks new (Cloud Tasks won't reuse a task id soon after it ran).
 */
export async function backfillIngest(
  db: Firestore,
  tasks: TaskQueuePort,
  input: { orgId: string; matterId?: string; runId: string },
): Promise<{ queued: number; skipped: number }> {
  const matterIds = input.matterId
    ? [input.matterId]
    : (await db.collection(`orgs/${input.orgId}/matters`).select().get()).docs.map((d) => d.id);
  let queued = 0;
  let skipped = 0;
  for (const matterId of matterIds) {
    const docs = await db.collection(`${matterPath(input.orgId, matterId)}/documents`).get();
    for (const snap of docs.docs) {
      const doc = snap.data();
      const ingest = ingestOf(doc);
      const version = Number(doc['version'] ?? 0);
      const ready = !isDeleted(doc) && (doc['scan'] as { status?: string })?.status === 'clean' && version > 0;
      const finished = ingest.version === version && ['done', 'skipped', 'running', 'queued'].includes(ingest.status);
      // A migrated document Clerk hasn't read waits for the enrichment's approval (MIG-09).
      if (!ready || finished || awaitsMigrationEnrichment(doc)) {
        skipped++;
        continue;
      }
      const task: IngestTask = { orgId: input.orgId, matterId, docId: snap.id, version };
      await tasks.enqueue(INGEST_QUEUE, task, { dedupeKey: ingestTaskKey(task, `backfill-${input.runId}`) });
      queued++;
    }
  }
  return { queued, skipped };
}

export const BackfillIngestInput = z.object({ requestId: z.uuid(), matterId: DocIdSchema.optional() });

/**
 * `documents-backfillIngest` (AI-04; `clerk.configure`, idempotent): queues ingestion of the org's
 * documents that predate Clerk ingestion or failed (migrated ones wait for their enrichment, MIG-09).
 */
export const backfillIngestDefinition = {
  name: 'documents-backfillIngest',
  input: BackfillIngestInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  timeoutSeconds: 300,
  handler: async ({ input, orgId, db, ports, log }) => {
    const result = await backfillIngest(db, ports.tasks, {
      orgId,
      ...(input.matterId ? { matterId: input.matterId } : {}),
      runId: input.requestId,
    });
    log.info('ingest backfill', result);
    return result;
  },
} satisfies CallableDefinition<typeof BackfillIngestInput, { queued: number; skipped: number }>;

export const backfillIngestCallable = defineCallable(backfillIngestDefinition);
