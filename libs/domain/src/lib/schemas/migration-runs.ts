import * as z from 'zod';

import { ActorSchema, InstantSchema, NonEmptyString, withMeta } from './common';

const ORG = 'orgs/{orgId}';

/**
 * `migrations/{runId}`: migration run records, written by `materia-migrate load` and `rollback`
 * (MIG-06). While a rollback deletes a run's documents its status is `rolling_back`, which the
 * audit trigger reads to leave those deletes out of the audit log.
 */
export const MigrationRun = withMeta(
  () => ({
    runId: NonEmptyString,
    mode: z.enum(['rehearsal', 'cutover', 'delta']),
    status: z.enum(['running', 'succeeded', 'failed', 'rolling_back', 'rolled_back']),
    startedAt: InstantSchema,
    finishedAt: InstantSchema.optional(),
    counts: z.record(z.string(), z.number().int().min(0)),
    warnings: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })).default([]),
    /** The gcloud account that ran it. */
    operator: z.string().optional(),
    toolVersion: z.string().optional(),
    /** When no migrated record had a review code left open (MIG-08), and who closed the last one. */
    reviewedAt: InstantSchema.optional(),
    reviewedBy: ActorSchema.optional(),
  }),
  { path: `${ORG}/migrations`, migratable: false, updatable: [] },
);

export type MigrationRun = z.infer<typeof MigrationRun.schema>;
