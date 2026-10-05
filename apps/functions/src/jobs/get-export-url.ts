import {
  attachmentDisposition,
  DomainError,
  DOWNLOAD_URL_TTL_SECONDS,
  GET_EXPORT_URL_CALLABLE,
  GetExportUrlInput,
  ROLES,
  type GetExportUrlResult,
} from '@materia/domain';

import { defineCallable, type CallableDefinition } from '../core/callable';
import { filesBucket } from '../documents/files';

/** A PDF's file name from the job's target name: letters, digits, spaces and dashes. */
export function exportFileName(name: unknown): string {
  const base = String(name ?? 'Export')
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'Export'}.pdf`;
}

/**
 * `jobs-getExportUrl` (FND-24, CORE-17; any member): a signed URL for an export job's PDF
 * (`orgs/{orgId}/exports/{jobId}.pdf`, 7-day TTL), valid for 5 minutes and served as an attachment.
 * Only the member who started the job may fetch it, and only once it succeeded: anyone else's job,
 * or one that isn't an export, is NOT_FOUND; one still running FAILED_PRECONDITION `not_ready`.
 */
export function getExportUrlDefinition(bucket: () => string = filesBucket) {
  return {
    name: GET_EXPORT_URL_CALLABLE,
    input: GetExportUrlInput,
    roles: ROLES,
    handler: async ({ input, orgId, uid, db, ports, clock, log }): Promise<GetExportUrlResult> => {
      const job = (await db.doc(`orgs/${orgId}/jobs/${input.jobId}`).get()).data();
      const target = job?.['target'] as { kind?: string; name?: string } | undefined;
      if (!job || job['createdBy'] !== uid || target?.kind !== 'export') {
        throw new DomainError('NOT_FOUND', 'Export not found', { jobId: input.jobId });
      }
      const output = job['output'] as { storagePath?: string } | undefined;
      if (job['status'] !== 'succeeded' || !output?.storagePath) {
        throw new DomainError('FAILED_PRECONDITION', 'The export isn’t ready yet', { reason: 'not_ready' });
      }
      const fileName = exportFileName(target.name);
      const expiresAt = new Date(clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000);
      const url = await ports.signedUrls.sign({
        bucket: bucket(),
        path: output.storagePath,
        expiresAt,
        disposition: attachmentDisposition(fileName),
        contentType: 'application/pdf',
      });
      log.info('export url', { jobId: input.jobId });
      return { url, expiresAt: expiresAt.toISOString(), fileName };
    },
  } satisfies CallableDefinition<typeof GetExportUrlInput, GetExportUrlResult>;
}

export const getExportUrl = defineCallable(getExportUrlDefinition());
