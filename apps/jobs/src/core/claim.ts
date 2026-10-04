import { JobSchema } from '@materia/domain';

import type { ClaimResult } from './types';

/** A running job whose heartbeat is newer than this is left alone by a duplicate dispatch. */
export const STALE_AFTER_MS = 2 * 60_000;

/** The claim decision, shared by the Firestore and local stores. */
export function decideClaim(data: unknown, now: Date): ClaimResult {
  const job = JobSchema.parse(data);
  if (job.status === 'succeeded') return { kind: 'skip', reason: 'succeeded' };
  if (job.status === 'failed' && !job.error?.retryable) return { kind: 'skip', reason: 'failed' };
  if (job.status === 'running' && job.heartbeatAt && now.getTime() - job.heartbeatAt.getTime() < STALE_AFTER_MS) {
    return { kind: 'skip', reason: 'running' };
  }
  return {
    kind: 'claimed',
    job: { ...job, status: 'running', attempts: job.attempts + 1, startedAt: now, heartbeatAt: now, error: undefined },
  };
}
