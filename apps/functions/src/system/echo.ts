import { z } from 'zod';

import { DomainError, PERMISSIONS } from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { enqueue } from '../core/tasks';

export const EchoInput = z.object({
  requestId: z.uuid(),
  message: z.string().min(1).max(200),
  /** Test hooks: throw a DomainError, or crash with an unexpected error. */
  fail: z.enum(['domain', 'crash']).optional(),
  /** Also enqueue a `system-recordEcho` task. */
  deferred: z.boolean().optional(),
});

export interface EchoResult {
  message: string;
  uid: string;
  orgId: string;
  role: string;
  requestId: string;
  at: string;
}

/**
 * `system-echo`: the example callable (FND-15). It shows the whole wrapper: claims, roles, an
 * active-member check, zod input, idempotent replay, DomainError mapping and Cloud Tasks.
 */
export const echoDefinition = {
  name: 'system-echo',
  input: EchoInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async ({ input, uid, orgId, role, requestId, clock, log, db }): Promise<EchoResult> => {
    // The server-side check for a server-enforced flag (FND-23).
    await requireFlag({ orgId, db, clock }, 'system.echo');
    if (input.fail === 'domain')
      throw new DomainError('FAILED_PRECONDITION', 'Echo was asked to fail', { reason: 'requested' });
    // An unexpected error whose message contains personal data: the client must see none of it.
    if (input.fail === 'crash') throw new Error('Unexpected failure for Margaret Whitfield');
    if (input.deferred) await enqueue('system-recordEcho', { orgId, requestId }, { dedupeKey: requestId });
    log.info('echo', { message: input.message, length: input.message.length });
    return { message: input.message, uid, orgId, role, requestId, at: clock.now().toISOString() };
  },
} satisfies CallableDefinition<typeof EchoInput, EchoResult>;

export const echo = defineCallable(echoDefinition);
