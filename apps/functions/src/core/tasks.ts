import type { SecretParam } from 'firebase-functions/params';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import type { z } from 'zod';

import { REGION } from '../config';
import type { Ports } from '../ports';
import { adminDb } from './admin';
import { createLog, type Log } from './log';
import { ports } from '../ports/container';

export { enqueue, taskId, type EnqueueOptions } from './enqueue';

export interface QueueDefinition<TSchema extends z.ZodType> {
  /** The deployed function name (`group-name`), which is also the queue name. */
  name: string;
  input: TSchema;
  retry?: { maxAttempts?: number; minBackoffSeconds?: number; maxBackoffSeconds?: number };
  rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
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

/** A Cloud Tasks queue and its handler, declared together (retry config lives in code). */
export function defineQueue<TSchema extends z.ZodType>(def: QueueDefinition<TSchema>) {
  return onTaskDispatched(
    {
      region: REGION,
      retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 300, ...def.retry },
      rateLimits: { maxConcurrentDispatches: 10, ...def.rateLimits },
      ...(def.secrets ? { secrets: def.secrets } : {}),
      ...(def.timeoutSeconds ? { timeoutSeconds: def.timeoutSeconds } : {}),
      ...(def.memory ? { memory: def.memory } : {}),
    },
    async (request) => {
      const log = createLog({ fn: def.name, taskId: request.id, attempt: request.retryCount });
      const input = def.input.parse(request.data);
      await def.handler(input, { log, db: adminDb(), ports: ports(), attempt: request.retryCount });
      log.info('ok');
    },
  );
}
