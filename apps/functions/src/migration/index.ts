import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  canApproveEnrichment,
  DocIdSchema,
  DomainError,
  ENRICHMENT_ALLOWANCE_MAX_CENTS,
  ENRICHMENT_ALLOWANCE_MIN_CENTS,
  formatUsdCents,
  MigrationEnrichment,
  PERMISSIONS,
} from '@materia/domain';

import { enqueueStep, runEnrichmentStep } from './enrich';
import { ENRICH_QUEUE, enrichmentPath, EnrichTaskSchema, readEnrichment, type EnrichTask } from './shared';
import { audit } from '../audit/audit';
import { clerkGateway } from '../clerk/service';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { defineQueue } from '../core/tasks';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { storageFiles } from '../documents/files';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

export { ENRICH_QUEUE, enrichmentPath } from './shared';
export { runEnrichmentStep } from './enrich';

// The legacy migration's review queue (MIG-08). Deployed as migration-review and
// migration-resolveReview; the triggers on matters, contacts, documents and members clear codes
// put right elsewhere (clear.ts).
export { resolveReview, review } from './review';

type Data = Record<string, unknown>;

const SYSTEM = 'system';
const FINISHED = new Set(['done', 'cancelled']);

/** A fresh enrichment for a run (MIG-09, D-21): counting comes first. `seq` follows an earlier, cancelled one. */
function freshEnrichment(runId: string, seq: number, at: Date): Data {
  return {
    runId,
    status: 'estimating',
    phase: 'estimate',
    seq,
    documents: [],
    matters: [],
    cursor: 0,
    attempts: 0,
    spentMicros: 0,
    progress: { read: 0, skipped: 0, failed: 0, mattersRead: 0, events: 0 },
    createdAt: at,
    createdBy: SYSTEM,
    updatedAt: at,
    updatedBy: SYSTEM,
    schemaVersion: MigrationEnrichment.version,
  };
}

/** Starts a run's enrichment, unless it has one (a re-load of the same run keeps it); after a rollback, anew. */
export async function startEnrichment(
  db: Firestore,
  ports: Parameters<typeof enqueueStep>[0]['ports'],
  clock: Clock,
  orgId: string,
  runId: string,
): Promise<boolean> {
  const ref = db.doc(enrichmentPath(orgId, runId));
  const task = await db.runTransaction(async (tx): Promise<EnrichTask | null> => {
    const current = await tx.get(ref);
    if (current.exists && current.get('status') !== 'cancelled') return null;
    const seq = current.exists ? Number(current.get('seq') ?? 0) + 1 : 0;
    tx.set(ref, freshEnrichment(runId, seq, clock.now()));
    return { orgId, runId, seq };
  });
  if (task) await enqueueStep({ ports }, task);
  return !!task;
}

/** Stops a run's enrichment for good (its run is being rolled back): a running step stops at its next save. */
export async function cancelEnrichment(db: Firestore, clock: Clock, orgId: string, runId: string): Promise<boolean> {
  const ref = db.doc(enrichmentPath(orgId, runId));
  return db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists || FINISHED.has(current.get('status'))) return false;
    tx.update(ref, {
      status: 'cancelled',
      seq: Number(current.get('seq') ?? 0) + 1,
      updatedAt: clock.now(),
      updatedBy: SYSTEM,
    });
    return true;
  });
}

/**
 * `migration-onRunWrite` (MIG-09): follows the run's record (`orgs/{orgId}/migrations/{runId}`,
 * written by `materia-migrate`). It turning `succeeded` starts the enrichment (rehearsals, cutover
 * and deltas alike); a rollback cancels it; the record deleted takes the enrichment with it.
 */
export async function onRunWriteHandler(change: TriggerChange, ctx: TriggerContext): Promise<void> {
  const { orgId = '', runId = '' } = ctx.params;
  const before = change.before?.data();
  const after = change.after?.data();
  if (!after) {
    await ctx.db.doc(enrichmentPath(orgId, runId)).delete();
    return;
  }
  const status = after['status'];
  if (status === 'succeeded' && before?.['status'] !== 'succeeded') {
    const started = await startEnrichment(ctx.db, ctx.ports, ctx.clock, orgId, runId);
    ctx.log.info('migration enrichment', { runId, started });
  } else if (status === 'rolling_back' || status === 'rolled_back') {
    const cancelled = await cancelEnrichment(ctx.db, ctx.clock, orgId, runId);
    if (cancelled) ctx.log.info('migration enrichment cancelled', { runId });
  }
}

export const onRunWriteDefinition: TriggerDefinition = {
  name: 'migration-onRunWrite',
  document: 'orgs/{orgId}/migrations/{runId}',
  on: 'written',
  handler: onRunWriteHandler,
};

export const onRunWrite = defineTrigger(onRunWriteDefinition);

/**
 * `migration-enrich` (Cloud Tasks): one step of an enrichment (`enrich.ts`). One at a time across
 * the project: the migration is read at low priority. A step that throws is retried by Cloud Tasks,
 * and a superseded one does nothing.
 */
export const enrich = defineQueue({
  name: ENRICH_QUEUE,
  input: EnrichTaskSchema,
  retry: { maxAttempts: 5, minBackoffSeconds: 60, maxBackoffSeconds: 900 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  timeoutSeconds: 540,
  memory: '2GiB',
  handler: async (task, { log, db, ports }) => {
    const outcome = await runEnrichmentStep(task, { db, ports, clock: systemClock, log, files: storageFiles() });
    log.info('migration enrichment step', { runId: task.runId, seq: task.seq, outcome });
  },
});

export const DecideEnrichmentInput = z.discriminatedUnion('decision', [
  z.object({
    requestId: z.uuid(),
    runId: DocIdSchema,
    decision: z.literal('approve'),
    allowanceCents: z.number().int().min(ENRICHMENT_ALLOWANCE_MIN_CENTS).max(ENRICHMENT_ALLOWANCE_MAX_CENTS),
  }),
  z.object({ requestId: z.uuid(), runId: DocIdSchema, decision: z.literal('decline') }),
]);
export type DecideEnrichmentInput = z.infer<typeof DecideEnrichmentInput>;

export interface DecideEnrichmentResult {
  status: 'running' | 'declined';
}

/**
 * `migration-decideEnrichment` (MIG-09; `clerk.configure`, idempotent): an owner or admin approves
 * the estimate with an allowance (US cents, more than it has spent), which starts the reading or
 * resumes it where it stopped, or declines it for now. Approving needs Clerk on for the org, the
 * data-use disclosure acknowledged and suggestions on (the key dates are suggestions). Audited.
 */
export const decideEnrichmentDefinition = {
  name: 'migration-decideEnrichment',
  input: DecideEnrichmentInput,
  roles: PERMISSIONS['clerk.configure'],
  idempotent: true,
  handler: async (ctx) => {
    const { input, orgId, uid, role, db, ports, clock, log } = ctx;
    if (input.decision === 'approve') {
      await clerkGateway({ db, ports, clock }).assertOn({ orgId, role }, 'eventsExtraction');
    }
    const ref = db.doc(enrichmentPath(orgId, input.runId));
    const next = await db.runTransaction(async (tx) => {
      const record = readEnrichment((await tx.get(ref)).data());
      if (!record) throw new DomainError('NOT_FOUND', 'No reading of that migration run', { runId: input.runId });
      const now = clock.now();
      const seq = record.seq + 1;
      if (input.decision === 'decline') {
        if (!['awaiting_approval', 'paused'].includes(record.status))
          throw new DomainError('FAILED_PRECONDITION', 'It isn’t waiting for a decision', { status: record.status });
        tx.update(ref, { status: 'declined', seq, updatedAt: now, updatedBy: uid });
        return null;
      }
      if (!canApproveEnrichment(record))
        throw new DomainError('FAILED_PRECONDITION', 'It isn’t waiting for approval', { status: record.status });
      if (input.allowanceCents * 10_000 <= record.spentMicros)
        throw new DomainError('INVALID_ARGUMENT', 'Set an allowance above what it has already spent', {
          allowanceCents: [`More than ${formatUsdCents(Math.ceil(record.spentMicros / 10_000))}`],
        });
      tx.update(ref, {
        status: 'running',
        pausedFor: FieldValue.delete(),
        allowanceCents: input.allowanceCents,
        approvedBy: uid,
        approvedAt: now,
        seq,
        updatedAt: now,
        updatedBy: uid,
      });
      return { orgId, runId: input.runId, seq } satisfies EnrichTask;
    });
    if (next) await enqueueStep({ ports }, next);
    await audit(ctx, {
      action: input.decision === 'approve' ? 'migration.enrichment_approved' : 'migration.enrichment_declined',
      entity: { path: ref.path },
      summary:
        input.decision === 'approve'
          ? `Clerk reading of migration run ${input.runId} approved, allowance ${formatUsdCents(input.allowanceCents)}`
          : `Clerk reading of migration run ${input.runId} declined`,
      ...(input.decision === 'approve' ? { data: { allowanceCents: input.allowanceCents } } : {}),
    });
    log.info('migration enrichment decided', { runId: input.runId, decision: input.decision });
    return { status: next ? 'running' : 'declined' };
  },
} satisfies CallableDefinition<typeof DecideEnrichmentInput, DecideEnrichmentResult>;

export const decideEnrichment = defineCallable(decideEnrichmentDefinition);
