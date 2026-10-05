import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  can,
  DomainError,
  Job,
  JobRequestSchema,
  MATTER_DOCUMENT_PATH,
  PERMISSIONS,
  type JobRequest,
  type Role,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import type { Log } from '../core/log';
import type { Clock, Ports } from '../ports';

export const StartPdfInput = z.object({
  requestId: z.uuid(),
  // Zip downloads start through documents-startZip, which names the files.
  job: JobRequestSchema.refine((job) => job.type !== 'documents.zip', { message: 'Not a PDF job' }),
});

export interface StartPdfResult {
  jobId: string;
  executionId: string;
}

/** Firestore `getAll` is batched to keep each read bounded. */
const READ_BATCH = 300;

/** The matter document versions a job reads, if it reads any. */
function inputPaths(request: JobRequest): readonly { storagePath: string }[] {
  return request.type === 'pdf.merge' || request.type === 'documents.zip' ? request.input.inputs : [];
}

/**
 * Checks every merge or zip input against the caller (FND-24, CORE-12b): it is a live, clean
 * document version in the caller's org that the caller may see. Returns whether any input is
 * privileged.
 */
async function checkInputs(db: Firestore, orgId: string, role: Role, request: JobRequest): Promise<boolean> {
  const parsed = inputPaths(request).map((input, inputIndex) => {
    const match = MATTER_DOCUMENT_PATH.exec(input.storagePath);
    if (!match || match[1] !== orgId) {
      throw new DomainError('PERMISSION_DENIED', 'Input is outside this organisation', { inputIndex });
    }
    return { inputIndex, path: `orgs/${orgId}/matters/${match[2]}/documents/${match[3]}`, version: Number(match[4]) };
  });

  let privileged = false;
  for (let start = 0; start < parsed.length; start += READ_BATCH) {
    const batch = parsed.slice(start, start + READ_BATCH);
    const snapshots = await db.getAll(...batch.map((input) => db.doc(input.path)));
    snapshots.forEach((snapshot, i) => {
      const { inputIndex, version } = batch[i] as (typeof batch)[number];
      const data = snapshot.data();
      if (!data || data['deletedAt'] || typeof data['version'] !== 'number' || version > data['version']) {
        throw new DomainError('NOT_FOUND', 'Input document not found', { inputIndex });
      }
      if (!can(role, 'matter.view', { privileged: data['privileged'] === true })) {
        throw new DomainError('NOT_FOUND', 'Input document not found', { inputIndex });
      }
      if ((data['scan'] as { status?: string } | undefined)?.status !== 'clean') {
        throw new DomainError('FAILED_PRECONDITION', 'Input has not passed the malware scan', { inputIndex });
      }
      privileged ||= data['privileged'] === true;
    });
  }
  return privileged;
}

export interface CreateJobContext {
  db: Firestore;
  ports: Ports;
  clock: Clock;
  log: Log;
  orgId: string;
  uid: string;
  role: Role;
  requestId: string;
}

/**
 * The job-dispatch pattern (ADR-014): validate, write `orgs/{orgId}/jobs/{jobId}` as `queued`, then
 * start a Cloud Run job execution with the ids. If the start fails the job is marked failed
 * (retryable) and the caller sees UNAVAILABLE. Feature callables (invoices, court books, exports)
 * reuse this after their own checks.
 */
export async function createJob(ctx: CreateJobContext, requested: JobRequest): Promise<StartPdfResult> {
  const { db, orgId, uid, role, clock, log } = ctx;
  const privilegedInputs = await checkInputs(db, orgId, role, requested);
  let request = requested;

  if (requested.type !== 'documents.zip' && requested.target.kind === 'matter') {
    const target = requested.target;
    const matter = await db.doc(`orgs/${orgId}/matters/${target.matterId}`).get();
    if (!matter.exists || matter.get('deletedAt')) throw new DomainError('NOT_FOUND', 'Matter not found');
    // A document made from privileged material is privileged itself.
    const privileged = target.privileged || privilegedInputs;
    if (privileged && !can(role, 'document.upload', { privileged: true })) {
      throw new DomainError('PERMISSION_DENIED', 'Privileged documents need a lawyer or above');
    }
    request = { ...requested, target: { ...target, privileged } };
  } else if (privilegedInputs && request.type !== 'documents.zip' && !can(role, 'export.includePrivileged')) {
    // Privileged material never leaves in an export without an owner or admin (invariant 7). A zip
    // of a selection (CORE-12b) is a download, not an export of the matter: it holds only what the
    // member could already download one document at a time (privileged ones need privileged.view,
    // checked above), so it doesn't need export.includePrivileged.
    throw new DomainError('PERMISSION_DENIED', 'Exporting privileged documents needs an owner or admin');
  }

  const ref = db.collection(`orgs/${orgId}/jobs`).doc();
  const now = clock.now();
  const job = Job.schema.parse({
    type: request.type,
    input: request.input,
    target: request.target,
    status: 'queued',
    progress: { done: 0, total: 0 },
    warnings: [],
    attempts: 0,
    createdAt: now,
    createdBy: uid,
    updatedAt: now,
    updatedBy: uid,
    schemaVersion: Job.version,
    _requestId: ctx.requestId,
  });
  await ref.create(job);

  try {
    const { executionId } = await ctx.ports.jobs.start('pdf', { orgId, jobId: ref.id });
    await ref.update({ executionId });
    log.info('job started', { jobId: ref.id, type: request.type, executionId });
    return { jobId: ref.id, executionId };
  } catch (error) {
    const at = clock.now();
    await ref.update({
      status: 'failed',
      error: { code: 'UNAVAILABLE', message: 'The job could not be started', retryable: true },
      finishedAt: at,
      updatedAt: at,
    });
    log.warn('job did not start', { jobId: ref.id });
    throw error instanceof DomainError ? error : new DomainError('UNAVAILABLE', 'The job could not be started');
  }
}

/**
 * `jobs-startPdf` (FND-24): starts a `pdf.render` or `pdf.merge` job and returns its id; the web app
 * watches `orgs/{orgId}/jobs/{jobId}` for progress. Templates are the job image's own
 * (`apps/jobs/templates`).
 */
export const startPdfDefinition = {
  name: 'jobs-startPdf',
  input: StartPdfInput,
  roles: PERMISSIONS['document.upload'],
  idempotent: true,
  handler: ({ input, ...ctx }) => createJob(ctx, input.job),
} satisfies CallableDefinition<typeof StartPdfInput, StartPdfResult>;

export const startPdf = defineCallable(startPdfDefinition);
