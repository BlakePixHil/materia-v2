import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JobRequestSchema,
  MATTER_DOCUMENT_PATH,
  MatterDocument,
  type JobProblem,
  type JobRequest,
  type JobType,
} from '@materia/domain';

import { JobError, toProblem } from './errors';
import type { JobFiles, JobHandler, JobOutput, JobProgress, JobStore, Log } from './types';

export interface RunnerDeps {
  orgId: string;
  jobId: string;
  store: JobStore;
  files: JobFiles;
  handlers: Record<JobType, JobHandler>;
  log: Log;
  clock?: () => Date;
  /** Stop and mark the job failed (retryable) before Cloud Run kills the task. */
  timeoutMs: number;
  /** Progress is written at most this often, except on stage changes and at the end. */
  progressIntervalMs?: number;
  heartbeatMs?: number;
}

export type RunOutcome = 'succeeded' | 'failed' | 'skipped';

/** Where the output goes: a new matter document version, or an export file. */
export function outputLocation(orgId: string, jobId: string, request: JobRequest) {
  if (request.target.kind === 'matter') {
    const documentId = `job-${jobId}`;
    return {
      storagePath: `orgs/${orgId}/matters/${request.target.matterId}/documents/${documentId}/v1`,
      documentId,
      documentPath: `orgs/${orgId}/matters/${request.target.matterId}/documents/${documentId}`,
    };
  }
  return { storagePath: `orgs/${orgId}/exports/${jobId}.pdf` };
}

/** Inputs must belong to the job's org (defence in depth: the callable checks it too). */
function checkTenancy(orgId: string, request: JobRequest) {
  if (request.type !== 'pdf.merge') return;
  request.input.inputs.forEach((input, inputIndex) => {
    if (MATTER_DOCUMENT_PATH.exec(input.storagePath)?.[1] !== orgId) {
      throw new JobError('PERMISSION_DENIED', `Input ${inputIndex} belongs to another organisation`, { inputIndex });
    }
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Runs one job end to end: claim (idempotent by jobId), validate, run the handler with progress and
 * a deadline, upload, record the document, and finish. Never throws for job failures; they are
 * written to the job document.
 */
export async function executeJob(deps: RunnerDeps): Promise<RunOutcome> {
  const { orgId, jobId, store, files, log } = deps;
  const clock = deps.clock ?? (() => new Date());
  const claim = await store.claim(clock());
  if (claim.kind === 'skip') {
    log.info('skipped', { jobId, reason: claim.reason });
    return 'skipped';
  }
  const job = claim.job;
  const warnings: JobProblem[] = [];
  const controller = new AbortController();
  let current: JobProgress = job.progress;
  let lastWrite = 0;

  const writeProgress = async (next: JobProgress, force = false) => {
    const now = clock();
    const stageChanged = next.stage !== current.stage;
    current = next;
    if (
      force ||
      stageChanged ||
      next.done >= next.total ||
      now.getTime() - lastWrite >= (deps.progressIntervalMs ?? 1000)
    ) {
      lastWrite = now.getTime();
      await store.progress(next, now);
    }
  };
  const timeout = setTimeout(
    () => controller.abort(new JobError('JOB_TIMEOUT', 'The job ran out of time', { retryable: true })),
    deps.timeoutMs,
  );
  const heartbeat = setInterval(
    () => void writeProgress(current, true).catch(() => undefined),
    deps.heartbeatMs ?? 30_000,
  );
  heartbeat.unref();
  let scratch: string | undefined;

  try {
    const parsed = JobRequestSchema.safeParse({ type: job.type, input: job.input, target: job.target });
    if (!parsed.success) throw new JobError('INVALID_ARGUMENT', 'The job input is not valid');
    const request = parsed.data;
    checkTenancy(orgId, request);
    scratch = await mkdtemp(join(tmpdir(), 'job-'));
    log.info('started', { jobId, type: request.type, attempt: job.attempts });

    const result = await Promise.race([
      deps.handlers[request.type]({
        orgId,
        jobId,
        request,
        scratch,
        files,
        signal: controller.signal,
        log,
        progress: (next) => writeProgress(next),
        warn: (problem) => warnings.push(problem),
      }),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error)),
      ),
    ]);

    await writeProgress({ done: current.total, total: current.total, stage: 'saving' });
    const location = outputLocation(orgId, jobId, request);
    const output: JobOutput = {
      storagePath: location.storagePath,
      sizeBytes: (await stat(result.path)).size,
      sha256: await sha256(result.path),
      pages: result.pages,
      ...(location.documentId ? { documentId: location.documentId } : {}),
    };
    await files.upload(result.path, output.storagePath, 'application/pdf');

    if (request.target.kind === 'matter' && location.documentPath && location.documentId) {
      const now = clock();
      const record = MatterDocument.schema.parse({
        orgId,
        matterId: request.target.matterId,
        name: request.target.name,
        storagePath: output.storagePath,
        mime: 'application/pdf',
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
        version: 1,
        versionSeq: 1,
        // The history the Documents tab lists and documents-restoreVersion reads (CORE-12).
        versions: [
          {
            version: 1,
            storagePath: output.storagePath,
            fileName: /\.pdf$/i.test(request.target.name) ? request.target.name : `${request.target.name}.pdf`,
            mime: 'application/pdf',
            sizeBytes: output.sizeBytes,
            sha256: output.sha256,
            uploadedAt: now,
            uploadedBy: job.createdBy,
            pageCount: output.pages,
          },
        ],
        deletedAt: null,
        category: request.target.category,
        privileged: request.target.privileged,
        // Generated from our own templates or from documents that were already scanned (CORE-12).
        scan: { status: 'clean' },
        ingest: { status: 'pending' },
        source: 'generated',
        pageCount: output.pages,
        createdAt: now,
        createdBy: job.createdBy,
        updatedAt: now,
        updatedBy: job.createdBy,
        schemaVersion: MatterDocument.version,
      });
      await store.createDocument(location.documentPath, record);
    }

    await store.succeed(output, warnings, clock());
    log.info('succeeded', {
      jobId,
      pages: output.pages,
      sizeBytes: output.sizeBytes,
      warnings: warnings.length,
      seconds: Math.round(process.uptime()),
      // Peak memory of this process (qpdf runs as a child and streams).
      maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    });
    return 'succeeded';
  } catch (error) {
    const problem = toProblem(controller.signal.aborted ? controller.signal.reason : error);
    if (!(error instanceof JobError) && !controller.signal.aborted) {
      log.error('job crashed', { jobId, error: error instanceof Error ? error.name : 'unknown' });
    }
    await store.fail(problem, warnings, clock());
    log.warn('failed', { jobId, code: problem.code, retryable: problem.retryable });
    return 'failed';
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    if (!controller.signal.aborted) controller.abort(new Error('done'));
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
