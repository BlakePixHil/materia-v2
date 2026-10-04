import { createHash } from 'node:crypto';

import { getFunctions } from 'firebase-admin/functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import type { z } from 'zod';

import { REGION } from '../config';
import type { Ports } from '../ports';
import { adminApp, adminDb } from './admin';
import { createLog, type Log } from './log';
import { ports } from '../ports/container';

export interface QueueDefinition<TSchema extends z.ZodType> {
  /** The deployed function name (`group-name`), which is also the queue name. */
  name: string;
  input: TSchema;
  retry?: { maxAttempts?: number; minBackoffSeconds?: number; maxBackoffSeconds?: number };
  rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
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
    },
    async (request) => {
      const log = createLog({ fn: def.name, taskId: request.id, attempt: request.retryCount });
      const input = def.input.parse(request.data);
      await def.handler(input, { log, db: adminDb(), ports: ports(), attempt: request.retryCount });
      log.info('ok');
    },
  );
}

export interface EnqueueOptions {
  scheduleTime?: Date;
  /** Tasks with the same key are created once (Cloud Tasks deduplicates by task id). */
  dedupeKey?: string;
}

/** Cloud Tasks ids allow [A-Za-z0-9_-] only, so dedupe keys are hashed. */
export function taskId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 40);
}

/** Enqueues a task for a queue declared with `defineQueue`. */
export async function enqueue<T extends Record<string, unknown>>(
  queueName: string,
  payload: T,
  options: EnqueueOptions = {},
): Promise<void> {
  const queue = getFunctions(adminApp()).taskQueue<T>(`locations/${REGION}/functions/${queueName}`);
  await queue.enqueue(payload, {
    ...(options.scheduleTime ? { scheduleTime: options.scheduleTime } : {}),
    ...(options.dedupeKey ? { id: taskId(options.dedupeKey) } : {}),
  });
}
