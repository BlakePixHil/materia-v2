import { MigrationEnrichment } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * Clerk reading what a legacy migration run loaded (MIG-09, D-21): `orgs/{orgId}/migrationEnrichments/{runId}`,
 * its estimate, approval and progress. Owners and admins read it (`org.settings`); only Functions
 * write it, and an owner or admin approves or declines through `migration-decideEnrichment`.
 */
export function migrationEnrichmentsRepository(): Repository<MigrationEnrichment> {
  return repo((orgId) => `orgs/${orgId}/migrationEnrichments`, {
    schema: MigrationEnrichment.schema,
    version: MigrationEnrichment.version,
  });
}

/** The most recent runs' enrichments, newest first (a practice migrates once, then a delta or two). */
export const RECENT_ENRICHMENTS_QUERY: QuerySpec<MigrationEnrichment> = {
  orderBy: [['createdAt', 'desc']],
  pageSize: 3,
};
