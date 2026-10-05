import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import { DocumentCategorySchema } from './schemas/enums';
import { DOCUMENT_NAME_MAX, DOCUMENT_VERSIONS_MAX, type DocumentVersion } from './schemas/matter-records';

/**
 * Matter documents (CORE-12, ADR-028): the upload contract, type checks by magic bytes, version
 * helpers and the `documents-*` callables' inputs. Uploads go to a quarantine path in Storage,
 * `documents-onUpload` verifies, scans and moves them to `documents/{docId}/v{n}`, and clients
 * read files only through short-lived signed URLs (`documents-getDownloadUrl`).
 */

// ---------- limits ----------

/** The largest upload (the Storage rules enforce it too). */
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Unscanned uploads still in `pending/` after this long are deleted (`documents-sweepPending`). */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a download link works. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
/** Scanner attempts in a delayed upload's backoff chain; after that the hourly sweep retries it. */
export const SCAN_MAX_ATTEMPTS = 8;
/** Documents per `documents-bulkUpdate` call. */
export const DOCUMENT_BULK_MAX = 500;

/** What the UI shows for a soft-deleted document wherever it is cited (citations, court books). */
export const REMOVED_DOCUMENT_LABEL = 'Removed document';
/** What the UI shows while the scanner is timing out or down (`upload.status: 'delayed'`). */
export const SCANNING_DELAYED_MESSAGE = 'Scanning delayed';

// ---------- accepted types ----------

/**
 * What a file's first bytes say it is. Office Open XML (`docx`, `xlsx`, `pptx`) is a zip with a
 * known part; `cfb` is the OLE compound file of legacy Office documents and Outlook `.msg`; `text`
 * is anything without binary bytes (plain text, CSV, `.eml`).
 */
/**
 * What the bytes are. `damaged_zip` has a zip signature but no readable directory: a corrupt
 * archive or Office file, which is stored as uploaded (the matter keeps what the client sent).
 */
export type FileKind =
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'heic'
  | 'zip'
  | 'damaged_zip'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'cfb'
  | 'text'
  | 'unknown';

/**
 * The upload allow-list (CORE-12): extension → the content type the client must upload with (the
 * Storage rules compare them) and the kinds of content accepted for it. A `.zip` may hold Office
 * Open XML, which is a zip too; a zip whose directory can't be read is accepted for both (corrupt
 * files are stored, not refused).
 */
export const UPLOAD_TYPES = {
  pdf: { mime: 'application/pdf', kinds: ['pdf'] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kinds: ['docx', 'damaged_zip'],
  },
  doc: { mime: 'application/msword', kinds: ['cfb'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kinds: ['xlsx', 'damaged_zip'] },
  xls: { mime: 'application/vnd.ms-excel', kinds: ['cfb'] },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kinds: ['pptx', 'damaged_zip'],
  },
  msg: { mime: 'application/vnd.ms-outlook', kinds: ['cfb'] },
  eml: { mime: 'message/rfc822', kinds: ['text'] },
  txt: { mime: 'text/plain', kinds: ['text'] },
  csv: { mime: 'text/csv', kinds: ['text'] },
  png: { mime: 'image/png', kinds: ['png'] },
  jpg: { mime: 'image/jpeg', kinds: ['jpeg'] },
  jpeg: { mime: 'image/jpeg', kinds: ['jpeg'] },
  heic: { mime: 'image/heic', kinds: ['heic'] },
  webp: { mime: 'image/webp', kinds: ['webp'] },
  zip: { mime: 'application/zip', kinds: ['zip', 'damaged_zip', 'docx', 'xlsx', 'pptx'] },
} as const satisfies Record<string, { mime: string; kinds: readonly FileKind[] }>;

export type UploadExtension = keyof typeof UPLOAD_TYPES;
export const UPLOAD_EXTENSIONS = Object.keys(UPLOAD_TYPES) as UploadExtension[];

/** The allow-listed extension of a file name (lower case), or null. */
export function uploadExtension(fileName: string): UploadExtension | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return Object.hasOwn(UPLOAD_TYPES, ext) ? (ext as UploadExtension) : null;
}

/** The content type to upload a file with (the rules require exactly this), or null if not allowed. */
export function uploadContentType(fileName: string): string | null {
  const ext = uploadExtension(fileName);
  return ext ? UPLOAD_TYPES[ext].mime : null;
}

/** Whether content of this kind is acceptable for the extension. */
export function kindMatchesExtension(kind: FileKind, ext: UploadExtension): boolean {
  return (UPLOAD_TYPES[ext].kinds as readonly FileKind[]).includes(kind);
}

// ---------- magic bytes ----------

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * The file names in a zip's central directory, or null when it can't be read (a damaged or
 * ZIP64 archive). Enough to tell Office Open XML from other zips.
 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 bytes plus a comment of up to 64 KiB.
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) return null;
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Office Open XML by its parts, else a plain zip. */
function zipKind(bytes: Uint8Array): FileKind {
  const names = zipEntryNames(bytes);
  if (!names) return 'damaged_zip';
  if (!names.includes('[Content_Types].xml')) return 'zip';
  if (names.some((name) => name.startsWith('word/'))) return 'docx';
  if (names.some((name) => name.startsWith('xl/'))) return 'xlsx';
  if (names.some((name) => name.startsWith('ppt/'))) return 'pptx';
  return 'zip';
}

/**
 * Text: UTF-16 with a byte-order mark, or no NUL bytes and almost no other control characters in
 * the first 64 KiB (UTF-8, ASCII or a legacy 8-bit encoding such as a CSV saved by Excel).
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  const sample = bytes.subarray(0, 64 * 1024);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Tab, line feed, form feed, carriage return and escape are fine.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) control++;
  }
  return control <= sample.length / 100;
}

/** What a file is, from its bytes (never its name). Empty files are `unknown`. */
export function detectFileKind(bytes: Uint8Array): FileKind {
  if (bytes.length === 0) return 'unknown';
  // The PDF header may follow a little junk (the spec allows it within the first 1024 bytes).
  if (ascii(bytes, 0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 12))) return 'heic';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return zipKind(bytes);
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'cfb';
  return looksLikeText(bytes) ? 'text' : 'unknown';
}

// ---------- the upload contract ----------

/** Upload ids: 8–64 URL-safe characters (a UUID works). They also name a new document. */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** `orgs/{orgId}/matters/{matterId}/pending/{uploadId}`, the only path clients upload to. */
export const PENDING_UPLOAD_PATH = /^orgs\/([^/]+)\/matters\/([^/]+)\/pending\/([A-Za-z0-9_-]{8,64})$/;

export function pendingUploadPath(orgId: string, matterId: string, uploadId: string): string {
  return `orgs/${orgId}/matters/${matterId}/pending/${uploadId}`;
}

export function documentVersionPath(orgId: string, matterId: string, documentId: string, version: number): string {
  return `orgs/${orgId}/matters/${matterId}/documents/${documentId}/v${version}`;
}

export type RenditionKind = 'previewPdf' | 'previewImage' | 'message';
const RENDITION_FILES: Record<RenditionKind, string> = {
  previewPdf: 'preview.pdf',
  previewImage: 'preview.jpg',
  message: 'message.json',
};

/** Where a version's rendition lives (no client reads it directly; signed URLs only). */
export function renditionPath(
  orgId: string,
  matterId: string,
  documentId: string,
  version: number,
  rendition: RenditionKind,
): string {
  return `orgs/${orgId}/matters/${matterId}/documents/${documentId}/renditions/v${version}/${RENDITION_FILES[rendition]}`;
}

/**
 * The custom metadata keys an upload carries. `uploaderUid` must be the signed-in user; `fileName`
 * the original name (its extension on the allow-list); `sha256` the client's hash of the bytes
 * (lower-case hex), which the server checks. Optional: `documentId` makes the upload a new version
 * of that document; `category` (a `DocumentCategory`) and `privileged` (`'true'`, lawyers and
 * above) set a new document's metadata.
 */
export const UPLOAD_METADATA_KEYS = [
  'uploaderUid',
  'fileName',
  'sha256',
  'documentId',
  'category',
  'privileged',
] as const;

export const UploadMetadataSchema = z
  .object({
    uploaderUid: DocIdSchema,
    fileName: z.string().trim().min(1).max(DOCUMENT_NAME_MAX),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    documentId: DocIdSchema.optional(),
    category: DocumentCategorySchema.optional(),
    privileged: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type UploadMetadata = z.infer<typeof UploadMetadataSchema>;

export interface UploadRequest {
  uid: string;
  fileName: string;
  sha256: string;
  /** Upload a new version of this document. */
  documentId?: string;
  category?: z.infer<typeof DocumentCategorySchema>;
  privileged?: boolean;
}

/**
 * The Storage `customMetadata` and `contentType` for an upload (`uploadBytesResumable(ref(storage,
 * pendingUploadPath(...)), file, uploadSettings(...))`). Throws when the extension isn't allowed.
 */
export function uploadSettings(request: UploadRequest): {
  contentType: string;
  customMetadata: Record<string, string>;
} {
  const contentType = uploadContentType(request.fileName);
  if (!contentType) throw new Error('This file type is not accepted');
  const metadata = UploadMetadataSchema.parse({
    uploaderUid: request.uid,
    fileName: request.fileName,
    sha256: request.sha256.toLowerCase(),
    ...(request.documentId ? { documentId: request.documentId } : {}),
    ...(request.category ? { category: request.category } : {}),
    ...(request.privileged ? { privileged: 'true' } : {}),
  });
  return { contentType, customMetadata: metadata as Record<string, string> };
}

// ---------- versions and display ----------

export interface DocumentLike {
  name?: unknown;
  deletedAt?: unknown;
  version?: unknown;
  versions?: readonly DocumentVersion[] | undefined;
}

/** A soft-deleted document still resolves (citations, court books), as "Removed document". */
export function documentDisplayName(doc: DocumentLike): string {
  if (doc.deletedAt !== undefined && doc.deletedAt !== null) return REMOVED_DOCUMENT_LABEL;
  return typeof doc.name === 'string' && doc.name ? doc.name : REMOVED_DOCUMENT_LABEL;
}

/** A version of a document, the current one when `version` is omitted. */
export function findVersion(doc: DocumentLike, version?: number): DocumentVersion | undefined {
  const wanted = version ?? (typeof doc.version === 'number' ? doc.version : 0);
  return (doc.versions ?? []).find((entry) => entry.version === wanted);
}

/** The version history, newest first. */
export function versionHistory(doc: DocumentLike): DocumentVersion[] {
  return [...(doc.versions ?? [])].sort((a, b) => b.version - a.version);
}

/** Whether another version fits (`DOCUMENT_VERSIONS_MAX`). */
export function canAddVersion(doc: DocumentLike): boolean {
  return (doc.versions?.length ?? 0) < DOCUMENT_VERSIONS_MAX;
}

/** Seconds before scan attempt `attempt` (1-based) is retried: 1, 2, 4… minutes, at most an hour. */
export function scanRetryDelaySeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 3600);
}

/**
 * A `Content-Disposition: attachment` header value for a download: an ASCII fallback name plus the
 * UTF-8 name (RFC 6266), so names with accents or quotes survive.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The download name of a version or rendition: the document's name with the right extension. */
export function downloadFileName(name: string, fileName: string, rendition?: RenditionKind): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
  if (rendition === 'previewPdf') return `${base}.pdf`;
  if (rendition === 'previewImage') return `${base}.jpg`;
  if (rendition === 'message') return `${base}.json`;
  const ext = uploadExtension(fileName);
  return ext ? `${base}.${ext}` : name;
}

// ---------- callables ----------

const RequestId = z.uuid();

/** The `documents-*` callables, as deployed. */
export const DOCUMENT_CALLABLES = {
  getDownloadUrl: 'documents-getDownloadUrl',
  restoreVersion: 'documents-restoreVersion',
  resolveDuplicate: 'documents-resolveDuplicate',
  bulkUpdate: 'documents-bulkUpdate',
  saveAttachment: 'documents-saveAttachment',
} as const;

export const DownloadRenditionSchema = z.enum(['original', 'previewPdf', 'previewImage', 'message']);
export type DownloadRendition = z.infer<typeof DownloadRenditionSchema>;

/**
 * `documents-getDownloadUrl` (`matter.view`; privileged documents and matters need
 * `privileged.view`, else NOT_FOUND): a signed URL, valid for 5 minutes, that downloads the
 * version (current by default) or one of its renditions as an attachment.
 */
export const GetDownloadUrlInput = z.object({
  matterId: DocIdSchema,
  docId: DocIdSchema,
  version: z.number().int().min(1).optional(),
  rendition: DownloadRenditionSchema.default('original'),
});
export type GetDownloadUrlInput = z.input<typeof GetDownloadUrlInput>;
export interface GetDownloadUrlResult {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
  fileName: string;
  version: number;
}

/**
 * `documents-restoreVersion` (`document.upload`, idempotent): makes an earlier version current by
 * copying it as a new version (`restoredFrom`), so history only ever grows.
 */
export const RestoreVersionInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  docId: DocIdSchema,
  version: z.number().int().min(1),
});
export type RestoreVersionInput = z.infer<typeof RestoreVersionInput>;
export interface RestoreVersionResult {
  version: number;
  restoredFrom: number;
}

/**
 * `documents-resolveDuplicate` (`document.upload`, idempotent): for a document marked
 * `duplicateOf`, keep both (clears the mark) or discard the new one (soft delete).
 */
export const ResolveDuplicateInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  docId: DocIdSchema,
  action: z.enum(['keep', 'discard']),
});
export type ResolveDuplicateInput = z.infer<typeof ResolveDuplicateInput>;
export interface ResolveDuplicateResult {
  docId: string;
  action: 'keep' | 'discard';
}

export const BulkDocumentChangeSchema = z.discriminatedUnion('op', [
  /** Move to another category (`document.upload`). */
  z.object({ op: z.literal('category'), category: DocumentCategorySchema }),
  /** Soft delete (`document.delete`): the document stays resolvable as "Removed document". */
  z.object({ op: z.literal('delete') }),
  /** Undo a soft delete (`document.delete`). */
  z.object({ op: z.literal('restore') }),
]);
export type BulkDocumentChange = z.infer<typeof BulkDocumentChangeSchema>;

/** `documents-bulkUpdate` (idempotent): one change to up to 500 documents of a matter. */
export const BulkUpdateDocumentsInput = z
  .object({
    requestId: RequestId,
    matterId: DocIdSchema,
    docIds: z.array(DocIdSchema).min(1).max(DOCUMENT_BULK_MAX),
    change: BulkDocumentChangeSchema,
  })
  .refine((input) => new Set(input.docIds).size === input.docIds.length, {
    message: 'Each document may be listed once',
    path: ['docIds'],
  });
export type BulkUpdateDocumentsInput = z.infer<typeof BulkUpdateDocumentsInput>;

export type BulkDocumentSkipReason = 'not_found' | 'deleted' | 'not_deleted' | 'unchanged';
export interface BulkUpdateDocumentsResult {
  updated: number;
  skipped: { docId: string; reason: BulkDocumentSkipReason }[];
}

// ---------- email messages ----------

/** The most body text a message rendition keeps (the original is always downloadable). */
export const MESSAGE_TEXT_MAX = 200_000;
/** The most attachments a message rendition lists. */
export const MESSAGE_ATTACHMENTS_MAX = 200;

const MessageAddressSchema = z.object({ name: z.string().max(500), address: z.string().max(500) });
export type MessageAddress = z.infer<typeof MessageAddressSchema>;

/**
 * An email's JSON rendition (`renditions/v{n}/message.json`, CORE-12), parsed from a stored .eml
 * or .msg version: the headers people read, the plain-text body (never HTML) and the attachments.
 * `savable` attachments have an allow-listed type and can be saved to the matter
 * (`documents-saveAttachment`); `index` names one.
 */
export const MessageRenditionSchema = z.object({
  format: z.literal('message.v1'),
  subject: z.string(),
  from: MessageAddressSchema.nullable(),
  to: z.array(MessageAddressSchema),
  cc: z.array(MessageAddressSchema),
  /** ISO 8601, when the message has a date. */
  date: z.string().nullable(),
  text: z.string().max(MESSAGE_TEXT_MAX),
  textTruncated: z.boolean(),
  attachments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        fileName: z.string(),
        mime: z.string(),
        sizeBytes: z.number().int().min(0),
        savable: z.boolean(),
      }),
    )
    .max(MESSAGE_ATTACHMENTS_MAX),
  attachmentsTruncated: z.boolean(),
});
export type MessageRendition = z.infer<typeof MessageRenditionSchema>;

/** Whether a stored file is an email this pipeline parses (by its allow-listed extension). */
export function isEmailFile(fileName: string): boolean {
  const ext = uploadExtension(fileName);
  return ext === 'eml' || ext === 'msg';
}

/**
 * `documents-saveAttachment` (`document.upload`, idempotent): saves one attachment of an email
 * document's version (current by default) to the matter as a new document. The attachment goes
 * through the upload pipeline like any upload (type, scan, duplicates), uploaded as the caller;
 * it is privileged when the email is. FAILED_PRECONDITION (`not_email`, `not_scanned`,
 * `type_not_allowed`, `too_large`); NOT_FOUND (`attachment_not_found`).
 */
export const SaveAttachmentInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  docId: DocIdSchema,
  version: z.number().int().min(1).optional(),
  attachmentIndex: z
    .number()
    .int()
    .min(0)
    .max(MESSAGE_ATTACHMENTS_MAX - 1),
  category: DocumentCategorySchema.optional(),
});
export type SaveAttachmentInput = z.infer<typeof SaveAttachmentInput>;
export interface SaveAttachmentResult {
  /** The pending upload; it also names the new document once the pipeline has stored it. */
  uploadId: string;
  docId: string;
  fileName: string;
}
