import type { JobProblem, JobStatus } from '@materia/domain';

import type { FirestoreSource } from './firestore/firestore-client';
import type { ListenerRegistry } from './listener-registry';

/** What the UI needs from `orgs/{orgId}/jobs/{jobId}` (FND-24). */
export interface JobView {
  status: JobStatus;
  progress: { done: number; total: number; stage?: string };
  error?: JobProblem;
  warnings: JobProblem[];
  output?: { storagePath: string; pages: number; documentId?: string };
}

/** Watches one job document; returns the unsubscribe function. `null` means it does not exist (yet). */
export interface JobSource {
  watch(orgId: string, jobId: string, next: (job: JobView | null) => void, error: (error: unknown) => void): () => void;
}

/** Only the fields the UI reads, with safe defaults for a document mid-write. */
export function toJobView(data: Record<string, unknown> | undefined): JobView | null {
  if (!data) return null;
  const progress = (data['progress'] ?? {}) as Partial<JobView['progress']>;
  return {
    status: (data['status'] as JobStatus | undefined) ?? 'queued',
    progress: {
      done: progress.done ?? 0,
      total: progress.total ?? 0,
      ...(progress.stage ? { stage: progress.stage } : {}),
    },
    ...(data['error'] ? { error: data['error'] as JobProblem } : {}),
    warnings: (data['warnings'] as JobProblem[] | undefined) ?? [],
    ...(data['output'] ? { output: data['output'] as JobView['output'] & object } : {}),
  };
}

const isFinished = (job: JobView | null) => job?.status === 'succeeded' || job?.status === 'failed';

/**
 * The Firestore implementation (FND-19): a snapshot listener on the job document, tracked by the
 * `ListenerRegistry`, that stops itself once the job succeeds or fails. A refused read
 * (`permission-denied`) is reported; the rules let only the member who started a job read it.
 */
export function firestoreJobSource(source: FirestoreSource, registry: ListenerRegistry): JobSource {
  return {
    watch(orgId, jobId, next, error) {
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      let last: string | undefined;
      const release = registry.add(
        () => {
          stopped = true;
          unsubscribe?.();
        },
        { label: `orgs/${orgId}/jobs/${jobId}` },
      );
      source.get().then(({ sdk, db }) => {
        if (stopped) return;
        unsubscribe = sdk.onSnapshot(
          sdk.doc(db, 'orgs', orgId, 'jobs', jobId),
          (snap) => {
            if (stopped) return;
            const job = toJobView(snap.data());
            const key = JSON.stringify(job);
            if (key !== last) {
              last = key;
              next(job);
            }
            if (isFinished(job)) release();
          },
          (e) => {
            release();
            error(e);
          },
        );
      }, error);
      return release;
    },
  };
}
