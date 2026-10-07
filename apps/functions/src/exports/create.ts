import {
  attachmentDisposition,
  canExport,
  CREATE_EXPORT_CALLABLE,
  CreateExportInput,
  DOWNLOAD_URL_TTL_SECONDS,
  DomainError,
  EXPORT_INLINE_MAX_ROWS,
  EXPORT_KIND_LABELS,
  EXPORT_ROLES,
  exportIncludesPrivileged,
  exportName,
  Job,
  ROLES,
  SENSITIVE_REAUTH_MINUTES,
  today as todayIn,
  validTimeZone,
  type CreateExportResult,
  type ExportJobInput,
} from '@materia/domain';

import { exportQuery, stillAllowed, writeExport, type ExportScope } from './build';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { filesBucket, storageFiles, type FileStore } from '../documents/files';
import { exportFileName } from '../jobs/get-export-url';

export const RUN_EXPORT_QUEUE = 'exports-run';

/** Which filters an export used, for the audit log: names only (a search box may hold a client's name). */
const filterNames = (filters: Record<string, unknown>) =>
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== false && !(Array.isArray(value) && !value.length))
    .map(([key]) => key)
    .sort();

/**
 * `exports-create` (INS-03, ADR-055): a CSV of one of the core lists (matters, contacts, time
 * entries, invoices, deadlines) with the filters the screen shows, as an export job
 * (`jobs/{jobId}`, type `csv.export`) whose file is `orgs/{orgId}/exports/{jobId}.csv` (7 days).
 *
 * - Who: the list's viewers except read-only members (`EXPORT_ROLES`); time entries for lawyers
 *   and above, invoices for `billing.view`. A sensitive action (SEC-04): a recent sign-in.
 * - Rows on privileged matters only with "Include privileged matters", for lawyers and above.
 * - Up to EXPORT_INLINE_MAX_ROWS candidate records it is written now and the answer carries a
 *   5-minute download link; more go to the `exports-run` queue, which streams the file, re-checks
 *   the member's access at the end and sends `export_ready`.
 * - Audited as `export.created` (the list, the filter names, whether privileged rows were asked
 *   for), never the rows.
 */
export function createExportDefinition(
  files: () => FileStore = () => storageFiles(),
  bucket: () => string = filesBucket,
) {
  return {
    name: CREATE_EXPORT_CALLABLE,
    input: CreateExportInput,
    roles: ROLES.filter((role) => Object.values(EXPORT_ROLES).some((roles) => roles.includes(role))),
    idempotent: true,
    recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
    timeoutSeconds: 120,
    memory: '512MiB',
    handler: async (ctx): Promise<CreateExportResult> => {
      const { input, orgId, uid, role, db, clock, log, ports } = ctx;
      if (!canExport(role, input.kind)) {
        throw new DomainError(
          'PERMISSION_DENIED',
          `Your role can’t export ${EXPORT_KIND_LABELS[input.kind].toLowerCase()}`,
        );
      }
      const request: ExportJobInput = {
        kind: input.kind,
        filters: input.filters as Record<string, unknown>,
        includePrivileged: exportIncludesPrivileged(role, input.includePrivileged),
      };
      const org = await db.doc(`orgs/${orgId}`).get();
      const now = clock.now();
      const timeZone = validTimeZone(org.get('timezone') as string | undefined);
      const scope: ExportScope = { db, orgId, uid, role, request, timeZone, now, today: todayIn(timeZone, now) };
      const candidates = (await exportQuery(scope).count().get()).data().count;
      const background = candidates > EXPORT_INLINE_MAX_ROWS;

      const ref = db.collection(`orgs/${orgId}/jobs`).doc();
      const name = exportName(input.kind, scope.today);
      await ref.create(
        Job.schema.parse({
          type: 'csv.export',
          input: request,
          target: { kind: 'export', name },
          status: background ? 'queued' : 'running',
          progress: { done: 0, total: candidates, stage: 'exporting' },
          warnings: [],
          attempts: background ? 0 : 1,
          ...(background ? {} : { startedAt: now }),
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
        summary: `${EXPORT_KIND_LABELS[input.kind]} exported to CSV`,
        data: {
          kind: input.kind,
          filters: filterNames(request.filters),
          includePrivileged: request.includePrivileged,
          background,
        },
      });

      if (background) {
        await ports.tasks.enqueue(RUN_EXPORT_QUEUE, { orgId, jobId: ref.id }, { dedupeKey: `export-${ref.id}` });
        log.info('export queued', { jobId: ref.id, kind: input.kind, candidates });
        return { jobId: ref.id, status: 'queued' };
      }

      const fileName = exportFileName(name, 'csv');
      const file = await writeExport(files(), scope, ref.id, { disposition: attachmentDisposition(fileName) });
      if (!(await stillAllowed(db, orgId, uid, request))) {
        await files().remove(file.storagePath);
        await ref.update({
          status: 'failed',
          error: { code: 'PERMISSION_DENIED', message: 'Access changed during the export', retryable: false },
          finishedAt: clock.now(),
          updatedAt: clock.now(),
        });
        throw new DomainError('PERMISSION_DENIED', 'Your access changed while the export ran');
      }
      const finishedAt = clock.now();
      await ref.update({
        status: 'succeeded',
        progress: { done: file.rows, total: file.rows, stage: 'exporting' },
        output: {
          storagePath: file.storagePath,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          pages: 0,
          rows: file.rows,
        },
        finishedAt,
        updatedAt: finishedAt,
      });
      const expiresAt = new Date(finishedAt.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000);
      const url = await ports.signedUrls.sign({
        bucket: bucket(),
        path: file.storagePath,
        expiresAt,
        disposition: attachmentDisposition(fileName),
        contentType: 'text/csv; charset=utf-8',
      });
      log.info('export written', { jobId: ref.id, kind: input.kind, rows: file.rows });
      return { jobId: ref.id, status: 'succeeded', rows: file.rows, url, expiresAt: expiresAt.toISOString(), fileName };
    },
  } satisfies CallableDefinition<typeof CreateExportInput, CreateExportResult>;
}

export const create = defineCallable(createExportDefinition());
