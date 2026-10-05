import { createHash } from 'node:crypto';

import { getFunctions } from 'firebase-admin/functions';

import { REGION } from '../config';
import type { EnqueueOptions, TaskQueuePort } from '../ports';
import { adminApp } from './admin';

export type { EnqueueOptions } from '../ports';

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

/** The real `TaskQueuePort` (Cloud Tasks, or the emulator's). */
export const cloudTasks: TaskQueuePort = { enqueue };
