import { inject } from '@angular/core';
import * as z from 'zod';

import {
  DOCUMENT_CALLABLES,
  DomainError,
  GET_EXPORT_URL_CALLABLE,
  MatterDocument,
  pendingUploadPath,
  SoftDeleteShape,
  uploadSettings,
  type BulkUpdateDocumentsInput,
  type BulkUpdateDocumentsResult,
  type GetDownloadUrlInput,
  type GetExportUrlResult,
  type GetDownloadUrlResult,
  type ResolveDuplicateInput,
  type ResolveDuplicateResult,
  type RestoreVersionInput,
  type RestoreVersionResult,
  type SaveAttachmentInput,
  type SaveAttachmentResult,
  type StartZipInput,
  type StartZipResult,
  type UploadRequest,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * A matter document as the Documents tab reads it (CORE-12): the `MatterDocument` fields, with
 * anything else the server keeps (`_requestId`) dropped rather than rejected, and the soft-delete
 * fields typed (a removed document still resolves, as "Removed document").
 */
export const DocumentItemSchema = /* @__PURE__ */ z.object({
  ...MatterDocument.schema.shape,
  deletedAt: SoftDeleteShape.deletedAt,
  deletedBy: SoftDeleteShape.deletedBy,
});
export type DocumentItem = z.infer<typeof DocumentItemSchema>;

/**
 * A matter's documents (`orgs/{orgId}/matters/{matterId}/documents`, CORE-12): live queries,
 * client-direct edits of the metadata the rules allow (`MatterDocument.update`: name, category,
 * tags, notes, accessRestricted, and privileged, which needs privileged.view; document.upload
 * roles) and soft deletes and restores (document.delete roles; a removed document still resolves,
 * as "Removed document"). There are no client creates: a document
 * starts as an upload to the pending area (`documentUpload`), and the server creates it.
 */
export function matterDocumentRepository(matterId: () => string | null): Repository<DocumentItem> {
  const base = repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/documents`, {
    schema: DocumentItemSchema,
    version: MatterDocument.version,
    update: MatterDocument.update,
  });
  return {
    ...base,
    create: () =>
      Promise.reject(
        new DomainError('FAILED_PRECONDITION', 'Documents are created by uploading a file', { reason: 'upload_only' }),
      ),
  };
}

/**
 * A matter's documents, newest first. Roles without privileged.view (paralegal, readonly) must
 * prove `privileged == false` for the rules to allow the list (indexed: privileged, createdAt).
 * Removed documents are hidden unless `includeDeleted`.
 */
export function matterDocumentsQuery(
  options: { privilegedVisible: boolean; includeDeleted?: boolean; pageSize?: number } = { privilegedVisible: true },
): QuerySpec<DocumentItem> {
  return {
    ...(options.privilegedVisible ? {} : { where: [['privileged', '==', false]] as const }),
    orderBy: [['createdAt', 'desc']],
    pageSize: options.pageSize ?? 100,
    ...(options.includeDeleted ? { includeDeleted: true } : {}),
  };
}

/** Where and how the web app uploads one file (Firebase Storage `uploadBytesResumable`). */
export interface DocumentUpload {
  /** Names the new document too (its id), unless the upload is a new version. */
  uploadId: string;
  /** `orgs/{orgId}/matters/{matterId}/pending/{uploadId}` in the files bucket. */
  path: string;
  /** Upload metadata: `contentType` and `customMetadata`, exactly as the Storage rules expect. */
  settings: { contentType: string; customMetadata: Record<string, string> };
}

/** A new random upload id (a UUID, which `UPLOAD_ID_PATTERN` accepts). */
const newUploadId = () => crypto.randomUUID();

/**
 * Plans an upload of one file to a matter (CORE-12, ADR-028): the pending path and the metadata.
 * Pass `documentId` to add a new version of that document. `sha256` is the file's hash (see
 * `fileSha256`); the server checks it. Throws INVALID_ARGUMENT for a file type off the allow-list.
 */
export function documentUpload(
  context: Pick<OrgContext, 'requireOrgId' | 'requireUid'>,
  matterId: string,
  file: Omit<UploadRequest, 'uid'>,
  uploadId: string = newUploadId(),
): DocumentUpload {
  const orgId = context.requireOrgId();
  let settings: DocumentUpload['settings'];
  try {
    settings = uploadSettings({ ...file, uid: context.requireUid() });
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'This file type is not accepted', { field: 'fileName' });
  }
  return { uploadId, path: pendingUploadPath(orgId, matterId, uploadId), settings };
}

/** `documentUpload` bound to the active org and member (call in an injection context). */
export function injectDocumentUpload(): (
  matterId: string,
  file: Omit<UploadRequest, 'uid'>,
  uploadId?: string,
) => DocumentUpload {
  const context = inject(OrgContext);
  return (matterId, file, uploadId) => documentUpload(context, matterId, file, uploadId);
}

/** A Blob's bytes (`FileReader` where `Blob.arrayBuffer` is missing, as in older engines). */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** The SHA-256 of a file's bytes as lower-case hex (Web Crypto), for the upload metadata. */
export async function fileSha256(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer =
    data instanceof Blob
      ? await blobBytes(data)
      : data instanceof Uint8Array
        ? (data.slice().buffer as ArrayBuffer)
        : data;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The `documents-*` callables (CORE-12). */
export interface DocumentCallables {
  /**
   * `documents-getDownloadUrl`: a signed URL valid for 5 minutes, served as an attachment, for the
   * current version or `version`, or one of its renditions. NOT_FOUND for privileged documents the
   * role can't see and removed documents; FAILED_PRECONDITION (`not_scanned`) before a clean scan.
   */
  getDownloadUrl(input: GetDownloadUrlInput): Promise<GetDownloadUrlResult>;
  /** `documents-restoreVersion`: copies `version` to a new current version (`restoredFrom`). */
  restoreVersion(input: Input<RestoreVersionInput>): Promise<RestoreVersionResult>;
  /** `documents-resolveDuplicate`: `keep` clears `duplicateOf`; `discard` removes the new copy. */
  resolveDuplicate(input: Input<ResolveDuplicateInput>): Promise<ResolveDuplicateResult>;
  /**
   * `documents-bulkUpdate`: a category, soft delete or restore for up to 500 documents (delete and
   * restore need document.delete). Skipped documents come back with a reason.
   */
  bulkUpdate(input: Input<BulkUpdateDocumentsInput>): Promise<BulkUpdateDocumentsResult>;
  /**
   * `documents-saveAttachment`: saves one attachment of an email document (the `index` from its
   * message rendition) to the matter. It goes through the upload pipeline; the new document's id
   * is the returned `docId`, and it appears once scanned.
   */
  saveAttachment(input: Input<SaveAttachmentInput>): Promise<SaveAttachmentResult>;
  /**
   * `documents-startZip`: starts a zip of up to 200 documents' current versions (CORE-12b).
   * Removed, unscanned and hidden privileged documents are left out (`skipped`); watch the
   * returned job, then fetch the zip with `exportUrl`.
   */
  startZip(input: Input<StartZipInput>): Promise<StartZipResult>;
  /** `jobs-getExportUrl`: a 5-minute link to a finished zip this member started. */
  exportUrl(jobId: string): Promise<GetExportUrlResult>;
}

export function documentCallables(client: Pick<CallableClient, 'call'>): DocumentCallables {
  return {
    getDownloadUrl: (input) =>
      client.call<GetDownloadUrlInput, GetDownloadUrlResult>(DOCUMENT_CALLABLES.getDownloadUrl, input),
    restoreVersion: (input) =>
      client.call<Input<RestoreVersionInput>, RestoreVersionResult>(DOCUMENT_CALLABLES.restoreVersion, input, {
        idempotent: true,
      }),
    resolveDuplicate: (input) =>
      client.call<Input<ResolveDuplicateInput>, ResolveDuplicateResult>(DOCUMENT_CALLABLES.resolveDuplicate, input, {
        idempotent: true,
      }),
    bulkUpdate: (input) =>
      client.call<Input<BulkUpdateDocumentsInput>, BulkUpdateDocumentsResult>(DOCUMENT_CALLABLES.bulkUpdate, input, {
        idempotent: true,
      }),
    saveAttachment: (input) =>
      client.call<Input<SaveAttachmentInput>, SaveAttachmentResult>(DOCUMENT_CALLABLES.saveAttachment, input, {
        idempotent: true,
      }),
    startZip: (input) =>
      client.call<Input<StartZipInput>, StartZipResult>(DOCUMENT_CALLABLES.startZip, input, { idempotent: true }),
    exportUrl: (jobId) => client.call<{ jobId: string }, GetExportUrlResult>(GET_EXPORT_URL_CALLABLE, { jobId }),
  };
}
