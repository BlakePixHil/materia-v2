import type { DocumentItem } from '@materia/data-access/repository';
import {
  DOCUMENT_MAX_BYTES,
  documentDisplayName,
  findVersion,
  REMOVED_DOCUMENT_LABEL,
  SCANNING_DELAYED_MESSAGE,
  uploadExtension,
  type DocumentUploadReason,
  type DocumentVersion,
  type UploadExtension,
} from '@materia/domain';
import type { MtBadgeTone, MtIconName } from '@materia/ui';

/**
 * The Documents tab's and viewer's view logic (CORE-12): labels, the file type of a document, its
 * pipeline status in plain words, filters and sorting. Pure, so it is tested without the DOM.
 */

export type DocumentRow = DocumentItem & { id: string };
export type DocumentCategory = DocumentItem['category'];

export const DOCUMENT_CATEGORY_LABELS: Readonly<Record<DocumentCategory, string>> = {
  will: 'Will',
  codicil: 'Codicil',
  death_certificate: 'Death certificate',
  grant: 'Grant',
  affidavit: 'Affidavit',
  correspondence: 'Correspondence',
  court_document: 'Court document',
  order: 'Order',
  financial: 'Financial',
  id: 'Identity document',
  other: 'Other',
};
export const DOCUMENT_CATEGORIES = Object.keys(DOCUMENT_CATEGORY_LABELS) as DocumentCategory[];

/** What kind of file a document is, for the Type filter, its icon and how it previews. */
export type FileType = 'pdf' | 'word' | 'spreadsheet' | 'presentation' | 'email' | 'image' | 'text' | 'archive';

export const FILE_TYPE_LABELS: Readonly<Record<FileType, string>> = {
  pdf: 'PDF',
  word: 'Word',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  email: 'Email',
  image: 'Image',
  text: 'Text',
  archive: 'Zip',
};
export const FILE_TYPES = Object.keys(FILE_TYPE_LABELS) as FileType[];

const TYPE_OF_EXTENSION: Readonly<Record<UploadExtension, FileType>> = {
  pdf: 'pdf',
  docx: 'word',
  doc: 'word',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  csv: 'spreadsheet',
  pptx: 'presentation',
  msg: 'email',
  eml: 'email',
  txt: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  heic: 'image',
  webp: 'image',
  zip: 'archive',
};

const ICON_OF_TYPE: Readonly<Record<FileType, MtIconName>> = {
  pdf: 'document',
  word: 'document',
  spreadsheet: 'billing',
  presentation: 'board',
  email: 'mail',
  image: 'eye',
  text: 'draft',
  archive: 'archive',
};

/** The file name a document was stored (or is being uploaded) with. */
export function documentFileName(doc: Pick<DocumentRow, 'name' | 'version' | 'versions' | 'upload'>): string {
  return findVersion(doc)?.fileName ?? doc.upload?.fileName ?? doc.name;
}

export function fileTypeOf(fileName: string): FileType | null {
  const ext = uploadExtension(fileName);
  return ext ? TYPE_OF_EXTENSION[ext] : null;
}

export function documentFileType(doc: Pick<DocumentRow, 'name' | 'version' | 'versions' | 'upload'>): FileType {
  return fileTypeOf(documentFileName(doc)) ?? 'text';
}

export function fileTypeIcon(type: FileType): MtIconName {
  return ICON_OF_TYPE[type];
}

/** `1.2 MB`, `640 KB`, `12 bytes` (decimal units, as file managers show them). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ---------- pipeline status ----------

/** Why the server refused an upload, in plain words. */
export const REJECTED_REASON_COPY: Readonly<Record<DocumentUploadReason, string>> = {
  type_not_allowed: 'This type of file can’t be added to a matter.',
  type_mismatch: 'The file’s contents don’t match its name. Check it opens, then save it with the right extension.',
  hash_mismatch: 'The file changed or was damaged while uploading. Try again.',
  too_large: 'The file is over 50 MB.',
  not_allowed: 'Your role can’t add documents to this matter.',
  target_unavailable: 'The document this was a new version of has been removed.',
  version_limit: 'This document already has 100 versions.',
};

export type DocumentStatusKind =
  'ready' | 'scanning' | 'delayed' | 'infected' | 'rejected' | 'expired' | 'duplicate' | 'removed';

export interface DocumentStatus {
  kind: DocumentStatusKind;
  /** Short label for a badge. */
  label: string;
  tone: MtBadgeTone;
  /** A sentence explaining it, when there's more to say. */
  detail?: string;
}

/**
 * Where a document is in the upload pipeline (ADR-028), from the server's fields: a removed
 * document, an upload being scanned (a new version keeps the current one readable meanwhile),
 * refused or quarantined, a possible duplicate, or ready.
 */
export function documentStatus(
  doc: Pick<DocumentRow, 'deletedAt' | 'upload' | 'scan' | 'version' | 'duplicateOf'>,
): DocumentStatus {
  if (doc.deletedAt) return { kind: 'removed', label: 'Removed', tone: 'neutral' };
  const upload = doc.upload;
  if (upload?.status === 'scanning') {
    return {
      kind: 'scanning',
      label: 'Scanning…',
      tone: 'info',
      detail: 'Checking the file for malware. It opens once the check is done.',
    };
  }
  if (upload?.status === 'delayed') {
    return {
      kind: 'delayed',
      label: SCANNING_DELAYED_MESSAGE,
      tone: 'warning',
      detail: 'The malware check is taking longer than usual. The file stays locked away until it passes.',
    };
  }
  if (upload?.status === 'infected' || doc.scan.status === 'infected') {
    return {
      kind: 'infected',
      label: 'Quarantined',
      tone: 'danger',
      detail: 'The malware check found a threat, so the file was deleted. Nothing was stored.',
    };
  }
  if (upload?.status === 'rejected') {
    return {
      kind: 'rejected',
      label: 'Rejected',
      tone: 'danger',
      detail: upload.reason ? REJECTED_REASON_COPY[upload.reason] : 'The file couldn’t be accepted.',
    };
  }
  if (upload?.status === 'expired') {
    return {
      kind: 'expired',
      label: 'Not checked',
      tone: 'danger',
      detail: 'The malware check didn’t finish within a day, so the file was deleted. Upload it again.',
    };
  }
  if (doc.version === 0) return { kind: 'scanning', label: 'Scanning…', tone: 'info' };
  if (doc.duplicateOf) return { kind: 'duplicate', label: 'Duplicate', tone: 'warning' };
  return { kind: 'ready', label: 'Ready', tone: 'success' };
}

/** Whether a document has a stored, scanned version to open or download. */
export function isReadable(doc: Pick<DocumentRow, 'deletedAt' | 'version' | 'scan'>): boolean {
  return !doc.deletedAt && doc.version > 0 && doc.scan.status === 'clean';
}

/**
 * A row's accessible name: a removed document reads as "Removed document" everywhere (citations
 * resolve to it), so in the "Show removed" list its former name is added, to tell them apart.
 */
export function rowName(doc: Pick<DocumentRow, 'name' | 'deletedAt'>): string {
  return doc.deletedAt ? `${REMOVED_DOCUMENT_LABEL} (${doc.name})` : documentDisplayName(doc);
}

/** "Duplicate of Will (fictional sample).pdf", or of a removed document. */
export function duplicateText(original: Pick<DocumentRow, 'name' | 'deletedAt'> | undefined): string {
  return `Duplicate of ${original ? documentDisplayName(original) : REMOVED_DOCUMENT_LABEL}`;
}

// ---------- what can be added ----------

/** At most this many files are added at once. */
export const UPLOAD_BATCH_MAX = 20;

/** Why a file can't be uploaded, before anything is sent; null when it can. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!uploadExtension(file.name))
    return 'This type of file can’t be added. Use PDF, Word, Excel, an email, an image or text.';
  if (file.size > DOCUMENT_MAX_BYTES) return 'This file is over 50 MB.';
  if (file.size === 0) return 'This file is empty.';
  return null;
}

/** The file picker's `accept`: every allow-listed extension. */
export const UPLOAD_ACCEPT = '.pdf,.docx,.doc,.xlsx,.xls,.pptx,.msg,.eml,.txt,.csv,.png,.jpg,.jpeg,.heic,.webp,.zip';

// ---------- previews ----------

/**
 * How a version previews: a PDF in the viewer; an image inline; an email's message rendition; plain
 * text; an Office file or HEIC photo through its rendition (not built yet, so "download instead");
 * nothing for a zip.
 */
export type PreviewKind = 'pdf' | 'image' | 'message' | 'text' | 'office' | 'heic' | 'none';

export function previewKind(fileName: string): PreviewKind {
  const ext = uploadExtension(fileName);
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
      return 'image';
    case 'heic':
      return 'heic';
    case 'eml':
    case 'msg':
      return 'message';
    case 'txt':
    case 'csv':
      return 'text';
    case 'docx':
    case 'doc':
    case 'xlsx':
    case 'xls':
    case 'pptx':
      return 'office';
    default:
      return 'none';
  }
}

/** "v3 · 1.2 MB · 14 pages" for a version. */
export function versionSummary(version: Pick<DocumentVersion, 'version' | 'sizeBytes' | 'pageCount'>): string {
  const pages = version.pageCount ? ` · ${version.pageCount === 1 ? '1 page' : `${version.pageCount} pages`}` : '';
  return `v${version.version} · ${formatBytes(version.sizeBytes)}${pages}`;
}

// ---------- filters and sorting ----------

export interface DocumentFilters {
  categories: readonly DocumentCategory[];
  types: readonly FileType[];
  /** `yes`: privileged only; `no`: not privileged; `any`. */
  privileged: 'any' | 'yes' | 'no';
  /** Include removed documents (document.delete roles). */
  removed: boolean;
}

export const NO_FILTERS: DocumentFilters = { categories: [], types: [], privileged: 'any', removed: false };

export function hasFilters(filters: DocumentFilters): boolean {
  return !!filters.categories.length || !!filters.types.length || filters.privileged !== 'any' || filters.removed;
}

export function matchesFilters(doc: DocumentRow, filters: DocumentFilters): boolean {
  if (doc.deletedAt && !filters.removed) return false;
  if (filters.categories.length && !filters.categories.includes(doc.category)) return false;
  if (filters.types.length && !filters.types.includes(documentFileType(doc))) return false;
  if (filters.privileged === 'yes' && !doc.privileged) return false;
  if (filters.privileged === 'no' && doc.privileged) return false;
  return true;
}

export type DocumentSortKey = 'name' | 'category' | 'type' | 'size' | 'added';
export interface DocumentSort {
  key: DocumentSortKey;
  direction: 'asc' | 'desc';
}
export const DEFAULT_SORT: DocumentSort = { key: 'added', direction: 'desc' };

export const SORT_LABELS: Readonly<Record<DocumentSortKey, string>> = {
  name: 'Name',
  category: 'Category',
  type: 'Type',
  size: 'Size',
  added: 'Date added',
};

const time = (value: unknown) => (value instanceof Date ? value.getTime() : 0);

function sortValue(doc: DocumentRow, key: DocumentSortKey): string | number {
  switch (key) {
    case 'name':
      return documentDisplayName(doc).toLocaleLowerCase();
    case 'category':
      return DOCUMENT_CATEGORY_LABELS[doc.category].toLocaleLowerCase();
    case 'type':
      return FILE_TYPE_LABELS[documentFileType(doc)].toLocaleLowerCase();
    case 'size':
      return doc.sizeBytes ?? doc.upload?.sizeBytes ?? 0;
    case 'added':
      return time(doc.createdAt);
  }
}

/** Sorted by the key (ties by name, then id, so the order is stable). */
export function sortDocuments(rows: readonly DocumentRow[], sort: DocumentSort): DocumentRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x < y) return -sign;
    if (x > y) return sign;
    const byName = documentDisplayName(a).localeCompare(documentDisplayName(b));
    return byName || a.id.localeCompare(b.id);
  });
}

/** How many of each count for a summary ("3 documents"). */
export function documentCount(count: number): string {
  return count === 1 ? '1 document' : `${count} documents`;
}

/** Tags typed as "estate, original" → trimmed, unique, non-empty. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
