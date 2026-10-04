import type { z } from 'zod';

import type { JobOutputSchema, JobProblem, JobRequest, JobSchema, MatterDocumentSchema } from '@materia/domain';

export type JobRecord = z.output<typeof JobSchema>;
export type JobOutput = z.output<typeof JobOutputSchema>;
export type MatterDocumentRecord = z.input<typeof MatterDocumentSchema>;

export interface JobProgress {
  done: number;
  total: number;
  stage?: string | undefined;
}

export type ClaimResult =
  | { kind: 'claimed'; job: JobRecord }
  /** Already succeeded, failed for good, or running elsewhere: exit without doing anything. */
  | { kind: 'skip'; reason: 'succeeded' | 'failed' | 'running' };

/** The job document, `orgs/{orgId}/jobs/{jobId}`. */
export interface JobStore {
  claim(now: Date): Promise<ClaimResult>;
  progress(progress: JobProgress, now: Date): Promise<void>;
  succeed(output: JobOutput, warnings: JobProblem[], now: Date): Promise<void>;
  fail(error: JobProblem, warnings: JobProblem[], now: Date): Promise<void>;
  /** Writes the generated document record (idempotent: same id, same data). */
  createDocument(path: string, data: MatterDocumentRecord): Promise<void>;
}

/** Cloud Storage, or a local folder in `--local` mode. */
export interface JobFiles {
  download(storagePath: string, localPath: string, signal?: AbortSignal): Promise<void>;
  upload(localPath: string, storagePath: string, contentType: string): Promise<void>;
}

export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface HandlerContext<R extends JobRequest = JobRequest> {
  orgId: string;
  jobId: string;
  request: R;
  /** A private temporary folder, removed afterwards. */
  scratch: string;
  files: JobFiles;
  signal: AbortSignal;
  log: Log;
  progress(progress: JobProgress): Promise<void>;
  warn(problem: JobProblem): void;
}

/** Writes the result PDF into `scratch` and returns where it is. */
export type JobHandler<R extends JobRequest = JobRequest> = (
  ctx: HandlerContext<R>,
) => Promise<{ path: string; pages: number }>;
