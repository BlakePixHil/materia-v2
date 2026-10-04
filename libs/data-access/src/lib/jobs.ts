import type { FirebaseApp } from 'firebase/app';

import type { JobProblem, JobStatus } from '@materia/domain';

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

/**
 * A Firestore listener on the job document (the full SDK, loaded lazily by the caller). The rules
 * let only the member who started a job read it.
 */
export async function createFirestoreJobSource(app: FirebaseApp, options: { emulators: boolean }): Promise<JobSource> {
  const { connectFirestoreEmulator, doc, getFirestore, onSnapshot } = await import('firebase/firestore');
  const firestore = getFirestore(app);
  if (options.emulators) {
    try {
      connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    } catch {
      // Another part of the app already connected this instance to the emulator.
    }
  }
  return {
    watch(orgId, jobId, next, error) {
      return onSnapshot(
        doc(firestore, 'orgs', orgId, 'jobs', jobId),
        (snapshot) => next(toJobView(snapshot.data())),
        error,
      );
    },
  };
}
