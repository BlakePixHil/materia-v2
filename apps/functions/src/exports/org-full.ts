import {
  DomainError,
  exportStillRunning,
  Job,
  ORG_EXPORT_CALLABLE,
  ORG_EXPORT_PART_BYTES,
  ORG_EXPORT_QUEUE,
  OrgExportInput,
  SENSITIVE_REAUTH_MINUTES,
  today,
  validTimeZone,
  type OrgExportJobInput,
  type OrgExportResult,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';

const toDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

/**
 * `exports-orgFull` (SEC-05, ADR-058; owners, signed in within the last few minutes): starts the
 * practice's full export, an `org.export` job written by the `exports-runOrgFull` queue as one or
 * more zips (`orgs/{orgId}/exports/{jobId}.zip`, then `.part-2.zip`…) that `jobs-getExportUrl`
 * signs and `jobs-sweepExports` deletes after 7 days. The owner confirms that the export holds
 * privileged material (`acknowledgePrivileged`). One full export runs at a time
 * (FAILED_PRECONDITION `export_running`); exporting is allowed while the practice waits to be
 * deleted. Audited as `export.created` (`kind: org`).
 */
export function orgExportDefinition(options: { partBytes?: number } = {}) {
  return {
    name: ORG_EXPORT_CALLABLE,
    input: OrgExportInput,
    roles: ['owner'],
    idempotent: true,
    recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
    handler: async (ctx): Promise<OrgExportResult> => {
      const { input, orgId, uid, db, clock, ports, log } = ctx;
      const now = clock.now();
      const running = await db.collection(`orgs/${orgId}/jobs`).where('type', '==', 'org.export').get();
      if (
        running.docs.some((job) =>
          exportStillRunning(
            {
              status: job.get('status'),
              heartbeatAt: toDate(job.get('heartbeatAt')),
              updatedAt: toDate(job.get('updatedAt')),
            },
            now,
          ),
        )
      ) {
        throw new DomainError('FAILED_PRECONDITION', 'A full export is already being written', {
          reason: 'export_running',
        });
      }
      const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
      const day = today(validTimeZone(org['timezone'] as string | undefined), now);
      const request: OrgExportJobInput = {
        allVersions: input.allVersions,
        partBytes: options.partBytes ?? ORG_EXPORT_PART_BYTES,
      };
      const ref = db.collection(`orgs/${orgId}/jobs`).doc();
      await ref.create(
        Job.schema.parse({
          type: 'org.export',
          input: request,
          target: { kind: 'export', name: `${String(org['name'] ?? 'Practice')} export ${day}`.slice(0, 250) },
          status: 'queued',
          progress: { done: 0, total: 0, stage: 'queued' },
          warnings: [],
          attempts: 0,
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: Job.version,
          _requestId: ctx.requestId,
        }),
      );
      await audit(ctx, {
        action: 'export.created',
        entity: { path: ref.path },
        summary: 'Full export of the practice started',
        data: { kind: 'org', allVersions: input.allVersions, privilegedAcknowledged: true },
      });
      await ports.tasks.enqueue(ORG_EXPORT_QUEUE, { orgId, jobId: ref.id }, { dedupeKey: `org-export-${ref.id}-1` });
      log.info('org export queued', { jobId: ref.id, allVersions: input.allVersions });
      return { jobId: ref.id, status: 'queued' };
    },
  } satisfies CallableDefinition<typeof OrgExportInput, OrgExportResult>;
}

export const orgFull = defineCallable(orgExportDefinition());
