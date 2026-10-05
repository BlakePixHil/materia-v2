import { z } from 'zod';

import { DocIdSchema, DomainError, PERMISSIONS } from '@materia/domain';

import { clerkGateway } from './service';
import { defineCallable, type CallableDefinition } from '../core/callable';

export const HelloInput = z.object({
  requestId: z.uuid(),
  /** Reuse one of the caller's own threads; a new one is created otherwise. */
  threadId: DocIdSchema.optional(),
});

export interface HelloResult {
  threadId: string;
  messageId: string;
  status: string;
  model: string;
  promptRef: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  greeting?: string;
}

/**
 * `clerk-hello` (AI-02): a connectivity check through the whole gateway (kill switches, the org's
 * key and model, limits, the `hello` prompt, streaming into a message, structured output,
 * metering). It is the live smoke test once an admin has saved the org's Anthropic key in
 * Settings → Clerk (AI-02a); it needs no Secret Manager secret. In the emulator it runs against the
 * fake model. Clerk must be on for the org (`clerk.enabled`).
 */
export const helloDefinition = {
  name: 'clerk-hello',
  input: HelloInput,
  roles: PERMISSIONS['clerk.use'],
  idempotent: true,
  timeoutSeconds: 60,
  handler: async ({ input, uid, orgId, role, requestId, log, clock, db, ports }): Promise<HelloResult> => {
    const threads = db.collection(`orgs/${orgId}/clerkThreads`);
    const at = clock.now();
    const meta = {
      createdAt: at,
      createdBy: uid,
      updatedAt: at,
      updatedBy: uid,
      schemaVersion: 1,
      _requestId: requestId,
    };
    let thread = input.threadId ? threads.doc(input.threadId) : threads.doc();
    if (input.threadId) {
      const existing = await thread.get();
      if (!existing.exists || existing.get('ownerUid') !== uid)
        throw new DomainError('NOT_FOUND', 'Clerk thread not found');
    } else {
      thread = threads.doc();
      await thread.create({ title: 'Clerk connectivity check', ownerUid: uid, matterId: null, shared: false, ...meta });
    }
    const messages = thread.collection('messages');
    await messages.doc().create({
      role: 'user',
      content: [{ type: 'text', text: 'Connectivity check' }],
      citations: [],
      status: 'done',
      stopRequested: false,
      toolCalls: [],
      ...meta,
    });
    const reply = messages.doc();
    const result = await clerkGateway({ db, ports, clock }).run({
      ctx: { orgId, uid, role, requestId, log, clock },
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the Materia team', promptRef: 'hello@1.0.0' },
      stream: { threadId: thread.id, messageId: reply.id },
    });
    const parsed = result.parsed as { greeting?: string } | undefined;
    return {
      threadId: thread.id,
      messageId: reply.id,
      status: result.status,
      model: result.model,
      promptRef: result.promptRef,
      fallbackUsed: result.fallbackUsed,
      usage: result.usage,
      ...(parsed?.greeting ? { greeting: parsed.greeting } : {}),
    };
  },
} satisfies CallableDefinition<typeof HelloInput, HelloResult>;

export const hello = defineCallable(helloDefinition);
