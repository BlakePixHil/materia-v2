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

/** How often a running job is re-read; jobs report progress at most once a second. */
export const JOB_POLL_MS = 2_000;

const isFinished = (job: JobView | null) => job?.status === 'succeeded' || job?.status === 'failed';
const isDenied = (error: unknown) => (error as { code?: string } | null)?.code === 'permission-denied';

/**
 * Polls the job document until it succeeds or fails. Read failures are retried on the next poll,
 * except `permission-denied`, which stops the watch and is reported.
 */
export function pollingJobSource(
  read: (orgId: string, jobId: string) => Promise<Record<string, unknown> | undefined>,
  pollMs = JOB_POLL_MS,
): JobSource {
  return {
    watch(orgId, jobId, next, error) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last: string | undefined;
      const poll = async () => {
        try {
          const job = toJobView(await read(orgId, jobId));
          if (stopped) return;
          const key = JSON.stringify(job);
          if (key !== last) {
            last = key;
            next(job);
          }
          if (isFinished(job)) return;
        } catch (e) {
          if (stopped) return;
          if (isDenied(e)) {
            error(e);
            return;
          }
        }
        timer = setTimeout(() => void poll(), pollMs);
      };
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}

/**
 * The Firestore implementation, on the Lite SDK (loaded lazily by the caller). The full SDK's
 * listeners would put its lazy chunk over the 150 kB budget (see `firebaseTenancyPort`), so the
 * document is polled every two seconds while the job runs. The rules let only the member who
 * started a job read it.
 */
export async function createFirestoreJobSource(app: FirebaseApp, options: { emulators: boolean }): Promise<JobSource> {
  const { connectFirestoreEmulator, doc, getDoc, getFirestore } = await import('firebase/firestore/lite');
  const firestore = getFirestore(app);
  if (options.emulators) {
    try {
      connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    } catch {
      // Another part of the app already connected this instance to the emulator.
    }
  }
  return pollingJobSource(async (orgId, jobId) => (await getDoc(doc(firestore, 'orgs', orgId, 'jobs', jobId))).data());
}
