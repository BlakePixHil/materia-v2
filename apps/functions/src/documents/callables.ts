import { createHash } from 'node:crypto';

import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import {
  attachmentDisposition,
  BulkUpdateDocumentsInput,
  can,
  chunkWrites,
  DOCUMENT_CALLABLES,
  documentVersionPath,
  DomainError,
  downloadFileName,
  DOCUMENT_MAX_BYTES,
  DOWNLOAD_URL_TTL_SECONDS,
  findVersion,
  isEmailFile,
  pendingUploadPath,
  GetDownloadUrlInput,
  PERMISSIONS,
  ResolveDuplicateInput,
  RestoreVersionInput,
  SaveAttachmentInput,
  uploadContentType,
  UploadMetadataSchema,
  type BulkUpdateDocumentsResult,
  type DocumentVersion,
  type GetDownloadUrlResult,
  type RenditionKind,
  type ResolveDuplicateResult,
  type RestoreVersionResult,
  type SaveAttachmentResult,
} from '@materia/domain';

import { parseMessage, type MessageAttachment } from './email';
import { filesBucket, storageFiles, type FileStore } from './files';
import { commitVersion, reserveVersion } from './pipeline';
import { documentPath, isClean, loadDocument, versionsOf } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { matterPath, writableMatter } from '../matters/shared';

type Data = Record<string, unknown>;

const RENDITION_TYPES: Record<RenditionKind, string> = {
  previewPdf: 'application/pdf',
  previewImage: 'image/jpeg',
  message: 'application/json',
};

/**
 * `documents-getDownloadUrl` (CORE-12; `matter.view`): a signed URL for one version (the current
 * one by default) or one of its renditions, valid for 5 minutes and served as an attachment.
 * Privileged documents and matters are NOT_FOUND for roles without `privileged.view` (readonly
 * never sees them); removed documents are NOT_FOUND; a document that isn't scanned clean is
 * FAILED_PRECONDITION (`not_scanned`); a rendition that doesn't exist (yet) is NOT_FOUND
 * (`rendition_unavailable`). Nothing public, no download tokens.
 */
export function getDownloadUrlDefinition(bucket: () => string = filesBucket) {
  return {
    name: DOCUMENT_CALLABLES.getDownloadUrl,
    input: GetDownloadUrlInput,
    roles: PERMISSIONS['matter.view'],
    handler: async ({ input, orgId, role, db, ports, clock, log }): Promise<GetDownloadUrlResult> => {
      const { doc } = await loadDocument(db, orgId, role, input.matterId, input.docId);
      if (!isClean(doc)) {
        throw new DomainError('FAILED_PRECONDITION', 'The document hasn’t passed the malware scan', {
          reason: 'not_scanned',
        });
      }
      const version = findVersion({ version: doc['version'], versions: versionsOf(doc) }, input.version);
      if (!version) throw new DomainError('NOT_FOUND', 'Version not found', { version: input.version ?? null });
      const rendition = input.rendition === 'original' ? undefined : input.rendition;
      const path = rendition ? version.renditions?.[rendition] : version.storagePath;
      if (!path) {
        throw new DomainError('NOT_FOUND', 'That rendition isn’t available', { reason: 'rendition_unavailable' });
      }
      const fileName = downloadFileName(String(doc['name'] ?? 'document'), version.fileName, rendition);
      const expiresAt = new Date(clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000);
      const url = await ports.signedUrls.sign({
        bucket: bucket(),
        path,
        expiresAt,
        disposition: attachmentDisposition(fileName),
        contentType: rendition ? RENDITION_TYPES[rendition] : version.mime,
      });
      log.info('download url', {
        matterId: input.matterId,
        docId: input.docId,
        version: version.version,
        rendition: input.rendition,
      });
      return { url, expiresAt: expiresAt.toISOString(), fileName, version: version.version };
    },
  } satisfies CallableDefinition<typeof GetDownloadUrlInput, GetDownloadUrlResult>;
}

/**
 * `documents-restoreVersion` (CORE-12; `document.upload`, idempotent): copies an earlier version
 * to a new version number (`restoredFrom`) and makes it current. History is never rewritten, so
 * citations of any version keep working. The current version is FAILED_PRECONDITION
 * (`already_current`); a full history `version_limit`.
 */
export function restoreVersionDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOCUMENT_CALLABLES.restoreVersion,
    input: RestoreVersionInput,
    roles: PERMISSIONS['document.upload'],
    idempotent: true,
    handler: async ({ input, orgId, uid, role, db, clock, log, requestId }): Promise<RestoreVersionResult> => {
      const { doc } = await loadDocument(db, orgId, role, input.matterId, input.docId, true);
      if (!isClean(doc)) {
        throw new DomainError('FAILED_PRECONDITION', 'The document hasn’t passed the malware scan', {
          reason: 'not_scanned',
        });
      }
      const source = findVersion({ versions: versionsOf(doc) }, input.version);
      if (!source) throw new DomainError('NOT_FOUND', 'Version not found', { version: input.version });
      if (source.version === doc['version']) {
        throw new DomainError('FAILED_PRECONDITION', 'That version is already current', { reason: 'already_current' });
      }
      const ref = db.doc(documentPath(orgId, input.matterId, input.docId));
      const restoreId = `restore-${requestId}`;
      const reserved = await reserveVersion(db, ref, restoreId);
      if (reserved === 'version_limit') {
        throw new DomainError('FAILED_PRECONDITION', 'This document has the maximum number of versions', {
          reason: 'version_limit',
        });
      }
      if (reserved === 'already_done') {
        const done = versionsOf((await ref.get()).data()).find((v) => v.uploadId === restoreId);
        return { version: done?.version ?? Number(doc['version']), restoredFrom: source.version };
      }
      const store = files();
      const data = await store.read(source.storagePath);
      if (!data) throw new DomainError('UNAVAILABLE', 'The stored version couldn’t be read');
      const storagePath = documentVersionPath(orgId, input.matterId, input.docId, reserved);
      await store.write(storagePath, data, {
        contentType: source.mime,
        disposition: attachmentDisposition(source.fileName),
        metadata: { restoredFrom: String(source.version) },
      });
      const now = clock.now();
      const version: DocumentVersion = {
        ...source,
        version: reserved,
        storagePath,
        uploadedAt: now,
        uploadedBy: uid,
        uploadId: restoreId,
        restoredFrom: source.version,
      };
      await commitVersion(db, ref, { orgId, matterId: input.matterId, docId: input.docId, version, now, requestId });
      log.info('version restored', {
        matterId: input.matterId,
        docId: input.docId,
        version: reserved,
        from: source.version,
      });
      return { version: reserved, restoredFrom: source.version };
    },
  } satisfies CallableDefinition<typeof RestoreVersionInput, RestoreVersionResult>;
}

/**
 * `documents-resolveDuplicate` (CORE-12; `document.upload`, idempotent): the answer to "This file
 * is already in the matter": `keep` clears `duplicateOf`, `discard` soft deletes the new copy
 * (allowed for every uploader, since it only undoes their own duplicate). A document that isn't
 * marked is FAILED_PRECONDITION (`not_duplicate`).
 */
export const resolveDuplicateDefinition = {
  name: DOCUMENT_CALLABLES.resolveDuplicate,
  input: ResolveDuplicateInput,
  roles: PERMISSIONS['document.upload'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, log, requestId }): Promise<ResolveDuplicateResult> => {
    const { doc } = await loadDocument(db, orgId, role, input.matterId, input.docId, true);
    if (typeof doc['duplicateOf'] !== 'string') {
      throw new DomainError('FAILED_PRECONDITION', 'This document isn’t marked as a duplicate', {
        reason: 'not_duplicate',
      });
    }
    const now = clock.now();
    await db.doc(documentPath(orgId, input.matterId, input.docId)).update({
      duplicateOf: FieldValue.delete(),
      ...(input.action === 'discard' ? { deletedAt: now, deletedBy: uid } : {}),
      updatedAt: now,
      updatedBy: uid,
      _requestId: requestId,
    });
    log.info('duplicate resolved', { matterId: input.matterId, docId: input.docId, action: input.action });
    return { docId: input.docId, action: input.action };
  },
} satisfies CallableDefinition<typeof ResolveDuplicateInput, ResolveDuplicateResult>;

/** Writes per batch. */
export const DOCUMENT_BULK_BATCH = 250;

/**
 * `documents-bulkUpdate` (CORE-12; idempotent): moves up to 500 of a matter's documents to a
 * category (`document.upload`), or soft deletes or restores them (`document.delete`;
 * PERMISSION_DENIED otherwise). Documents that are missing or privileged beyond the caller
 * (`not_found`), already deleted or not deleted, or unchanged are skipped and listed. Soft-deleted
 * documents stay resolvable ("Removed document"). Batches carry the request id for the audit log.
 */
export const bulkUpdateDefinition = {
  name: DOCUMENT_CALLABLES.bulkUpdate,
  input: BulkUpdateDocumentsInput,
  roles: PERMISSIONS['document.upload'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, log, requestId }): Promise<BulkUpdateDocumentsResult> => {
    const { change } = input;
    if (change.op !== 'category' && !can(role, 'document.delete')) {
      throw new DomainError('PERMISSION_DENIED', 'Your role can’t remove documents', { action: 'document.delete' });
    }
    writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const refs = input.docIds.map((id) => db.doc(documentPath(orgId, input.matterId, id)));
    const snaps = (await Promise.all(chunkWrites(refs, 300).map((chunk) => db.getAll(...chunk)))).flat();
    const now = clock.now();
    const skipped: BulkUpdateDocumentsResult['skipped'] = [];
    const writes: { ref: DocumentReference; patch: Data }[] = [];
    snaps.forEach((snap, i) => {
      const docId = input.docIds[i] as string;
      const data = snap.data();
      if (!snap.exists || !data || (data['privileged'] === true && !can(role, 'privileged.view'))) {
        skipped.push({ docId, reason: 'not_found' });
        return;
      }
      const deleted = isDeleted(data);
      let patch: Data;
      if (change.op === 'category') {
        if (deleted) return void skipped.push({ docId, reason: 'deleted' });
        if (data['category'] === change.category) return void skipped.push({ docId, reason: 'unchanged' });
        patch = { category: change.category };
      } else if (change.op === 'delete') {
        if (deleted) return void skipped.push({ docId, reason: 'deleted' });
        patch = { deletedAt: now, deletedBy: uid };
      } else {
        if (!deleted) return void skipped.push({ docId, reason: 'not_deleted' });
        patch = { deletedAt: null, deletedBy: null };
      }
      writes.push({ ref: snap.ref, patch: { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId } });
    });
    for (const batchWrites of chunkWrites(writes, DOCUMENT_BULK_BATCH)) {
      const batch = db.batch();
      for (const write of batchWrites) batch.update(write.ref, write.patch);
      await batch.commit();
    }
    log.info('bulk update', {
      matterId: input.matterId,
      op: change.op,
      requested: input.docIds.length,
      updated: writes.length,
      skipped: skipped.length,
    });
    return { updated: writes.length, skipped };
  },
} satisfies CallableDefinition<typeof BulkUpdateDocumentsInput, BulkUpdateDocumentsResult>;

/**
 * `documents-saveAttachment` (CORE-12; `document.upload`, idempotent): saves one attachment of an
 * email document to the matter. The bytes go to the pending area as an upload by the caller, so
 * the upload pipeline checks, scans, dedupes and stores them like any upload, and the new document
 * appears when it has (its id is the returned `uploadId`). The attachment is privileged when the
 * email is, and filed as correspondence unless `category` says otherwise.
 */
export function saveAttachmentDefinition(files: () => FileStore = () => storageFiles()) {
  return {
    name: DOCUMENT_CALLABLES.saveAttachment,
    input: SaveAttachmentInput,
    roles: PERMISSIONS['document.upload'],
    idempotent: true,
    handler: async ({ input, orgId, uid, role, db, log, requestId }): Promise<SaveAttachmentResult> => {
      const { doc } = await loadDocument(db, orgId, role, input.matterId, input.docId, true);
      if (!isClean(doc)) {
        throw new DomainError('FAILED_PRECONDITION', 'The document hasn’t passed the malware scan', {
          reason: 'not_scanned',
        });
      }
      const version = findVersion({ version: doc['version'], versions: versionsOf(doc) }, input.version);
      if (!version) throw new DomainError('NOT_FOUND', 'Version not found', { version: input.version ?? null });
      if (!isEmailFile(version.fileName)) {
        throw new DomainError('FAILED_PRECONDITION', 'This document isn’t an email', { reason: 'not_email' });
      }
      const store = files();
      const data = await store.read(version.storagePath);
      if (!data) throw new DomainError('UNAVAILABLE', 'The stored version couldn’t be read');
      let attachment: MessageAttachment | null;
      try {
        attachment = (await parseMessage(version.fileName, data)).attachment(input.attachmentIndex);
      } catch {
        throw new DomainError('FAILED_PRECONDITION', 'The email couldn’t be read', { reason: 'unreadable' });
      }
      if (!attachment) {
        throw new DomainError('NOT_FOUND', 'Attachment not found', { reason: 'attachment_not_found' });
      }
      const contentType = uploadContentType(attachment.fileName);
      if (!contentType) {
        throw new DomainError('FAILED_PRECONDITION', 'This file type is not accepted', { reason: 'type_not_allowed' });
      }
      if (attachment.data.length === 0 || attachment.data.length > DOCUMENT_MAX_BYTES) {
        throw new DomainError('FAILED_PRECONDITION', 'The attachment is empty or too large', { reason: 'too_large' });
      }
      // The same request always writes the same upload, so a retry can't add a second copy.
      const uploadId = `att-${createHash('sha256').update(`${orgId}/${requestId}`).digest('hex').slice(0, 40)}`;
      const metadata = UploadMetadataSchema.parse({
        uploaderUid: uid,
        fileName: attachment.fileName,
        sha256: createHash('sha256').update(attachment.data).digest('hex'),
        category: input.category ?? 'correspondence',
        ...(doc['privileged'] === true ? { privileged: 'true' } : {}),
      });
      await store.write(pendingUploadPath(orgId, input.matterId, uploadId), attachment.data, {
        contentType,
        metadata: metadata as Record<string, string>,
      });
      log.info('attachment saved', {
        matterId: input.matterId,
        docId: input.docId,
        version: version.version,
        uploadId,
        sizeBytes: attachment.data.length,
      });
      return { uploadId, docId: uploadId, fileName: attachment.fileName };
    },
  } satisfies CallableDefinition<typeof SaveAttachmentInput, SaveAttachmentResult>;
}

export const getDownloadUrl = defineCallable(getDownloadUrlDefinition());
export const restoreVersion = defineCallable(restoreVersionDefinition());
export const resolveDuplicate = defineCallable(resolveDuplicateDefinition);
export const bulkUpdate = defineCallable(bulkUpdateDefinition);
export const saveAttachment = defineCallable(saveAttachmentDefinition());
