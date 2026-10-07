import * as z from 'zod';

import {
  DomainError,
  MIGRATION_CALLABLES,
  MigrationRun,
  type MigrationReviewInput,
  type MigrationReviewResult,
  type ResolveMigrationReviewInput,
  type ResolveMigrationReviewResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { repo, type Repository } from './repository';

/**
 * A legacy migration run (`orgs/{orgId}/migrations/{runId}`, MIG-06): its mode and status, what it
 * brought across, and (MIG-08) when its review was finished. Not strict: fields the tool adds
 * later are dropped on read.
 */
export const MigrationRunItemSchema = /* @__PURE__ */ z.object({ ...MigrationRun.schema.shape });
export type MigrationRunItem = z.infer<typeof MigrationRunItemSchema>;

/** The org's migration runs, read-only (owners and admins): the migration tool writes them. */
export function migrationRunsRepository(): Repository<MigrationRunItem> {
  const base = repo((orgId) => `orgs/${orgId}/migrations`, {
    schema: MigrationRunItemSchema,
    version: MigrationRun.version,
  });
  const refuse = () =>
    Promise.reject(
      new DomainError('FAILED_PRECONDITION', 'Migration runs are written by the migration tool', {
        reason: 'tool_only',
      }),
    );
  return { ...base, create: refuse, update: refuse, softDelete: refuse, hardDelete: refuse };
}

/** The run a practice's import is (the latest that isn't a delta), and the latest of all. */
export function latestMigrationRuns<T extends Pick<MigrationRunItem, 'mode' | 'startedAt'>>(
  runs: readonly T[],
): { latest: T | null; import: T | null } {
  const sorted = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  return { latest: sorted[0] ?? null, import: sorted.find((run) => run.mode !== 'delta') ?? null };
}

type Input<T> = Omit<T, 'requestId'>;

/** The `migration-*` callables (MIG-08), owners and admins. */
export interface MigrationCallables {
  /** `migration-review`: counts by code, and the records with a code (or any) open. */
  review(input?: MigrationReviewInput): Promise<MigrationReviewResult>;
  /** `migration-resolveReview` (idempotent): mark named records' codes, or every record's code, reviewed. */
  resolve(input: Input<ResolveMigrationReviewInput>): Promise<ResolveMigrationReviewResult>;
}

export function migrationCallables(client: Pick<CallableClient, 'call'>): MigrationCallables {
  return {
    review: (input = {}) => client.call<MigrationReviewInput, MigrationReviewResult>(MIGRATION_CALLABLES.review, input),
    resolve: (input) =>
      client.call<Input<ResolveMigrationReviewInput>, ResolveMigrationReviewResult>(
        MIGRATION_CALLABLES.resolve,
        input,
        {
          idempotent: true,
        },
      ),
  };
}
