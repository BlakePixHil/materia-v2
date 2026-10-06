import { domain } from '../domain.ts';
import type { MatterRef } from './comments.ts';
import {
  fit,
  MIGRATION_ACTOR,
  migratedMeta,
  migId,
  type CopyPlan,
  type TransformContext,
  type TransformedRecord,
} from './context.ts';
import { createdAndUpdated, readInstant } from './dates.ts';
import type { InlineImage } from './html.ts';
import { cleanText } from './values.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { docId, str, type StorageObject } from '../legacy/snapshot.ts';

const { DOCUMENT_NAME_MAX } = domain;

/**
 * `cards/{card}/attachments/{id}` → matter documents (CORE-12) with `source: 'migration'` and
 * `category: 'other'` (Clerk classifies them after the load, MIG-09), plus the copy MIG-05 makes
 * of each file into `orgs/{O}/matters/{M}/documents/{D}/v1`. The document starts at version 0,
 * scan pending, like an upload in flight: MIG-05 adds version 1 with its sha256 once the copy is
 * verified and scanned. The legacy `downloadUrl` is never used (D-17).
 */

/** The legacy allow-list's types, for attachments stored without one (D-13). */
const TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
};

/** Types v2 uploads refuse (an SVG can carry script): they migrate as download-only files (D-13). */
const DOWNLOAD_ONLY = new Set(['svg', 'gif', 'bmp']);
/** The legacy upload limit; bigger files exist and still migrate. */
const LEGACY_MAX_BYTES = 25 * 1024 * 1024;

export function documentTarget(matter: MatterRef, documentId: string): string {
  return `orgs/${matter.orgId}/matters/${matter.matterId}/documents/${documentId}/v1`;
}

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return (match?.[1] ?? '').toLowerCase();
}

/** A new document record at version 0, waiting for its copy. */
function documentRecord(
  ctx: TransformContext,
  matter: MatterRef,
  input: { legacyPath: string; name: string; createdAt: Date; updatedAt: Date; by: string; copy: CopyPlan },
): TransformedRecord {
  const id = migId(input.legacyPath);
  const name = fitFileName(ctx, input.name, input.legacyPath);
  return {
    entity: 'documents',
    path: `orgs/${matter.orgId}/matters/${matter.matterId}/documents/${id}`,
    legacyPath: input.legacyPath,
    data: {
      orgId: matter.orgId,
      matterId: matter.matterId,
      name,
      category: 'other',
      privileged: false,
      tags: [],
      version: 0,
      versions: [],
      scan: { status: 'pending' },
      ingest: { status: 'pending' },
      source: 'migration',
      encrypted: false,
      accessRestricted: false,
      search: [],
      deletedAt: null,
      ...migratedMeta(ctx, {
        legacyPath: input.legacyPath,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        // MIG-05 makes these the version's upload time and uploader.
        by: input.by,
      }),
    },
    copy: { ...input.copy, fileName: name },
  };
}

/** A file name cut to what a document holds, keeping its extension. */
function fitFileName(ctx: TransformContext, name: string, legacyPath: string): string {
  if (name.length <= DOCUMENT_NAME_MAX) return name;
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  return `${fit(ctx, name.slice(0, name.length - extension.length), DOCUMENT_NAME_MAX - extension.length, legacyPath)}${extension}`;
}

export function mapAttachments(
  ctx: TransformContext,
  matter: MatterRef,
  attachments: readonly ExportRecord[],
  objects: ReadonlyMap<string, StorageObject>,
): TransformedRecord[] {
  return attachments.flatMap(({ path, data }) => (data ? [mapAttachment(ctx, matter, path, data, objects)] : []));
}

export function mapAttachment(
  ctx: TransformContext,
  matter: MatterRef,
  path: string,
  data: Record<string, unknown>,
  objects: ReadonlyMap<string, StorageObject>,
): TransformedRecord {
  const attachmentId = docId(path);
  const recordedName = str(data['storagePath'])?.trim() ?? '';
  // The object is `{attachmentId}{ext}` under the card; the doc's own path wins when it is there.
  const object =
    objects.get(recordedName) ??
    [...objects.values()].find((o) => {
      const base = `${matter.cardPath}/attachments/${attachmentId}`;
      return o.name === base || (o.name.startsWith(`${base}.`) && !o.name.slice(base.length + 1).includes('/'));
    });
  const fileName = cleanText(data['originalFileName']) || `${attachmentId}${str(data['fileExtension']) ?? ''}`;
  const extension =
    extensionOf(fileName) || extensionOf(str(data['fileExtension']) ?? '') || extensionOf(object?.name ?? '');

  let mime = cleanText(data['mimeType']) || object?.contentType?.trim() || '';
  if (!mime) {
    mime = TYPES[extension] ?? 'application/octet-stream';
    ctx.warnings.add('MIG_W_ATTACHMENT_TYPE_FROM_EXTENSION', path);
  }
  const recordedSize = typeof data['sizeBytes'] === 'number' ? data['sizeBytes'] : undefined;
  if (!object) ctx.warnings.add('MIG_W_ATTACHMENT_OBJECT_MISSING', path);
  else if (recordedSize !== undefined && recordedSize !== object.size) {
    ctx.warnings.add('MIG_W_ATTACHMENT_SIZE_MISMATCH', path);
  }
  const sizeBytes = object?.size ?? recordedSize ?? 0;
  if (sizeBytes > LEGACY_MAX_BYTES) ctx.warnings.add('MIG_W_ATTACHMENT_OVERSIZE', path);
  const downloadOnly = DOWNLOAD_ONLY.has(extension) || /^image\/(svg\+xml|gif|bmp)$/i.test(mime);
  if (downloadOnly) ctx.warnings.add('MIG_W_ATTACHMENT_DOWNLOAD_ONLY', path);

  const dates = createdAndUpdated(ctx, data, path);
  const createdAt = readInstant(data['uploadedAt']) ?? dates.createdAt;
  const id = migId(path);
  return documentRecord(ctx, matter, {
    legacyPath: path,
    name: fileName,
    createdAt,
    updatedAt: dates.updatedAt > createdAt ? dates.updatedAt : createdAt,
    // Someone else's upload is the migration's: they aren't a member.
    by: str(data['uploadedBy']) === ctx.uid ? ctx.uid : MIGRATION_ACTOR,
    copy: {
      ...(object ? { source: object.name } : {}),
      target: documentTarget(matter, id),
      fileName,
      mime,
      sizeBytes,
      ...(object?.md5Hash ? { md5Hash: object.md5Hash } : {}),
      ...(object?.crc32c ? { crc32c: object.crc32c } : {}),
      ...(object?.generation ? { generation: object.generation } : {}),
      ...(downloadOnly ? { downloadOnly: true } : {}),
    },
  });
}

/** An image a description embedded as base64, as a document of its own (the bytes travel in the copy). */
export function inlineImageDocument(
  ctx: TransformContext,
  matter: MatterRef,
  image: InlineImage,
  index: number,
): TransformedRecord {
  const legacyPath = `${matter.cardPath}#description-image/${index + 1}`;
  ctx.warnings.add('MIG_W_INLINE_IMAGE_EXTRACTED', matter.cardPath);
  const fileName = inlineImageName(index, image);
  return documentRecord(ctx, matter, {
    legacyPath,
    name: fileName,
    createdAt: matter.createdAt,
    updatedAt: matter.updatedAt,
    by: ctx.uid,
    copy: {
      content: { encoding: 'base64', data: image.base64, sha256: image.sha256 },
      target: documentTarget(matter, migId(legacyPath)),
      fileName,
      mime: image.mime,
      sizeBytes: image.sizeBytes,
      md5Hash: image.md5Hash,
      ...(DOWNLOAD_ONLY.has(image.extension) ? { downloadOnly: true } : {}),
    },
  });
}

export function inlineImageName(index: number, image: InlineImage): string {
  return `Description image ${index + 1}.${image.extension}`;
}
