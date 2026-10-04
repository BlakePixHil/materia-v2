import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { defineQueue } from '../core/tasks';

/**
 * `system-recordEcho`: the example Cloud Tasks queue (FND-15). Writes
 * `systemTasks/echo-{requestId}` (server-only) so tests can see the task ran.
 */
export const recordEcho = defineQueue({
  name: 'system-recordEcho',
  input: z.object({ orgId: z.string().min(1), requestId: z.uuid() }),
  retry: { maxAttempts: 2 },
  handler: async ({ orgId, requestId }, { db, log }) => {
    await db.doc(`systemTasks/echo-${requestId}`).set({ orgId, requestId, handledAt: FieldValue.serverTimestamp() });
    log.info('recorded', { requestId });
  },
});
