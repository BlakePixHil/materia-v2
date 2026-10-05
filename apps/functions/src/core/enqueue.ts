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

/** Cloud Tasks already has a task with this id: the dedupe key did its job. */
export const isDuplicateTask = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'functions/task-already-exists';

/**
 * Enqueues a task for a queue declared with `defineQueue`. With a `dedupeKey`, enqueueing the same
 * task again is a no-op.
 */
export async function enqueue<T extends Record<string, unknown>>(
  queueName: string,
  payload: T,
  options: EnqueueOptions = {},
): Promise<void> {
  const queue = getFunctions(adminApp()).taskQueue<T>(`locations/${REGION}/functions/${queueName}`);
  try {
    await queue.enqueue(payload, {
      ...(options.scheduleTime ? { scheduleTime: options.scheduleTime } : {}),
      ...(options.dedupeKey ? { id: taskId(options.dedupeKey) } : {}),
    });
  } catch (error) {
    if (options.dedupeKey && isDuplicateTask(error)) return;
    throw error;
  }
}

/** The real `TaskQueuePort` (Cloud Tasks, or the emulator's). */
export const cloudTasks: TaskQueuePort = { enqueue };
