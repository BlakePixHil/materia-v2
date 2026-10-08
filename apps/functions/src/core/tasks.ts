import type { SecretParam } from 'firebase-functions/params';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import type { z } from 'zod';

import { REGION } from '../config';
import type { Ports } from '../ports';
import { adminDb } from './admin';
import { createLog, type Log } from './log';
import { purgedTaskOrg } from './purge-guard';
import { purgeLookup } from './trigger';
import { ports } from '../ports/container';

export { enqueue, taskId, type EnqueueOptions } from './enqueue';

export interface QueueDefinition<TSchema extends z.ZodType> {
  /** The deployed function name (`group-name`), which is also the queue name. */
  name: string;
  input: TSchema;
  retry?: { maxAttempts?: number; minBackoffSeconds?: number; maxBackoffSeconds?: number };
  rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
  /** Tasks one instance runs at once (default: the platform's 80 for 1 CPU). */
  concurrency?: number;
  /** Secrets the handler reads (`core/secrets.ts`). */
  secrets?: SecretParam[];
  /** For handlers that wait on slow work (default: the platform's 60 seconds and 256 MiB). */
  timeoutSeconds?: number;
  memory?: '256MiB' | '512MiB' | '1GiB' | '2GiB';
  handler: (
    input: z.output<TSchema>,
    ctx: { log: Log; db: ReturnType<typeof adminDb>; ports: Ports; attempt: number },
  ) => Promise<void>;
}

/**
 * A Cloud Tasks queue and its handler, declared together (retry config lives in code). A task for
 * a practice being deleted (its payload's `orgId` has a `deletedOrgs` tombstone, SEC-05) is
 * dropped, so a late reminder or delivery doesn't write into it; the deletion job's own queue
 * (`orgs-purge`) is the exception.
 */
export function defineQueue<TSchema extends z.ZodType>(def: QueueDefinition<TSchema>) {
  return onTaskDispatched(
    {
      region: REGION,
      retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 300, ...def.retry },
      rateLimits: { maxConcurrentDispatches: 10, ...def.rateLimits },
      ...(def.secrets ? { secrets: def.secrets } : {}),
      ...(def.timeoutSeconds ? { timeoutSeconds: def.timeoutSeconds } : {}),
      ...(def.memory ? { memory: def.memory } : {}),
      ...(def.concurrency ? { concurrency: def.concurrency } : {}),
    },
    async (request) => {
      const log = createLog({ fn: def.name, taskId: request.id, attempt: request.retryCount });
      const input = def.input.parse(request.data);
      const orgId = await purgedTaskOrg(def.name, input, purgeLookup());
      if (orgId) {
        log.info('skipped: the practice is being deleted', { orgId });
        return;
      }
      await def.handler(input, { log, db: adminDb(), ports: ports(), attempt: request.retryCount });
      log.info('ok');
    },
  );
}
