import { createHash } from 'node:crypto';

import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

import {
  attachmentDisposition,
  can,
  detectFileKind,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_VERSIONS_MAX,
  DocumentHash,
  documentVersionPath,
  kindMatchesExtension,
  MatterDocument,
  Notification,
  PENDING_UPLOAD_PATH,
  ROLES,
  SCAN_MAX_ATTEMPTS,
  scanRetryDelaySeconds,
  UPLOAD_METADATA_KEYS,
  UPLOAD_TYPES,
  uploadExtension,
  UploadMetadataSchema,
  type DocumentUpload,
  type DocumentUploadReason,
  type DocumentVersion,
  type FileKind,
  type Role,
  type UploadMetadata,
} from '@materia/domain';

import type { FileStore } from './files';
import { versionsOf } from './shared';
import { isDeleted } from '../contacts/shared';
import type { Log } from '../core/log';
import { matterPath } from '../matters/shared';
import { ScannerUnavailableError, type Clock, type MalwareScanPort } from '../ports';

type Data = Record<string, unknown>;

/** How long one scan may take before the upload is treated as delayed and retried. */
export const SCAN_TIMEOUT_MS = 60_000;

/** A finalized object, as the Storage trigger (or a retry) sees it. */
export interface UploadEvent {
  path: string;
  generation: string;
  size: number;
  metadata: Record<string, string>;
  /** Scan attempts already made for this upload (0 for the first event). */
  attempt?: number;
}

/** A queued retry of a delayed scan (`documents-rescan`). */
export interface RescanTask {
  path: string;
  generation: string;
  attempt: number;
}

/** What happens after a version is stored: renditions and parsing (best effort, never fails the upload). */
export type AfterVersion = (stored: {
  orgId: string;
  matterId: string;
  docId: string;
  version: DocumentVersion;
  kind: FileKind;
  data: Buffer;
  uploaderUid: string;
}) => Promise<void>;

export interface PipelineDeps {
  db: Firestore;
  files: FileStore;
  scanner: MalwareScanPort;
  clock: Clock;
  log: Log;
  scheduleRescan: (task: RescanTask, delaySeconds: number) => Promise<void>;
  afterVersion?: AfterVersion;
  scanTimeoutMs?: number;
}

export type UploadOutcome =
  'ignored' | 'not_allowed' | 'rejected' | 'infected' | 'delayed' | 'stored' | 'duplicate' | 'already_done' | 'gone';

export interface UploadResult {
  outcome: UploadOutcome;
  docId?: string;
  version?: number;
  reason?: DocumentUploadReason;
}

const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Page count and encryption of a PDF; a damaged PDF gives neither (it is still stored). */
export async function analysePdf(data: Uint8Array): Promise<{ pageCount?: number; encrypted: boolean }> {
  try {
    // Loaded on first use, like the email parsers: it would otherwise slow every function's cold start.
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
    if (pdf.isEncrypted) return { encrypted: true };
    return { pageCount: pdf.getPageCount(), encrypted: false };
  } catch {
    return { encrypted: false };
  }
}

/** Resolves with the scanner's verdict, or throws `ScannerUnavailableError` (down, failing or too slow). */
export async function scanWithTimeout(
  scanner: MalwareScanPort,
  request: Parameters<MalwareScanPort['scan']>[0],
  timeoutMs: number,
): Promise<Awaited<ReturnType<MalwareScanPort['scan']>>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ScannerUnavailableError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([scanner.scan(request, controller.signal), timeout]);
  } catch (error) {
    throw error instanceof ScannerUnavailableError ? error : new ScannerUnavailableError('unavailable');
  } finally {
    clearTimeout(timer);
  }
}

interface Access {
  role: Role;
  matter: Data;
  target?: Data;
}

/**
 * Whether the uploader may add this file (the rules checked the same, but a member can be
 * suspended or a document deleted between the upload and the trigger): an active member with
 * `document.upload` on a live matter they can see, privileged material only with
 * `privileged.view`, and a new version only of a live, scanned document they can see.
 */
async function checkAccess(
  db: Firestore,
  orgId: string,
  matterId: string,
  meta: UploadMetadata,
): Promise<Access | { refused: 'not_allowed' | 'target_unavailable' }> {
  const [member, matter, target] = await db.getAll(
    db.doc(`orgs/${orgId}/members/${meta.uploaderUid}`),
    db.doc(matterPath(orgId, matterId)),
    db.doc(`${matterPath(orgId, matterId)}/documents/${meta.documentId ?? '-'}`),
  );
  const role = member?.get('role') as Role | undefined;
  if (!member?.exists || member.get('status') !== 'active' || !role || !ROLES.includes(role)) {
    return { refused: 'not_allowed' };
  }
  const matterData = matter?.data();
  if (!matterData || isDeleted(matterData)) return { refused: 'not_allowed' };
  const privilegedMatter = matterData['privileged'] === true;
  if (!can(role, 'document.upload', { privileged: privilegedMatter || meta.privileged === 'true' })) {
    return { refused: 'not_allowed' };
  }
  if (!meta.documentId) return { role, matter: matterData };
  const doc = target?.data();
  if (
    !doc ||
    isDeleted(doc) ||
    (doc['scan'] as { status?: string } | undefined)?.status !== 'clean' ||
    !can(role, 'document.upload', { privileged: doc['privileged'] === true })
  ) {
    return { refused: 'target_unavailable' };
  }
  return { role, matter: matterData, target: doc };
}

const uploadOf = (doc: Data | undefined) => doc?.['upload'] as DocumentUpload | undefined;

/**
 * `documents-onUpload` (CORE-12, ADR-028): takes one quarantined upload
 * (`orgs/{orgId}/matters/{matterId}/pending/{uploadId}`) through the pipeline:
 *
 * 1. Checks the uploader's access and records the upload on the document (a new document, id =
 *    upload id, with `scan.status: 'pending'`; or the target document's `upload`).
 * 2. Checks the size, the client's SHA-256 and the type by magic bytes (`rejected` otherwise).
 * 3. Scans it: infected files are deleted, recorded and notified; a scanner timeout or outage
 *    leaves the file quarantined ("Scanning delayed") and schedules a retry with backoff.
 * 4. Stores a clean file at `documents/{docId}/v{n}` (never overwritten), adds the version in a
 *    transaction (with page count and encryption for PDFs) and, for a new document, checks the
 *    matter's hash index in the same transaction, so a second copy of the same file, even one
 *    uploaded at the same moment, is marked `duplicateOf` the first.
 *
 * Every step is idempotent by upload id, so retries and redelivered events add a version once.
 * Logs carry ids, sizes and outcomes only.
 */
export async function processUpload(event: UploadEvent, deps: PipelineDeps): Promise<UploadResult> {
  const { db, files, log, clock } = deps;
  const match = PENDING_UPLOAD_PATH.exec(event.path);
  if (!match) return { outcome: 'ignored' };
  const [, orgId, matterId, uploadId] = match as unknown as [string, string, string, string];
  // Only the contract's keys: Firebase Storage adds its own (a download token) after the rules ran.
  const metadata = event.metadata ?? {};
  const parsed = UploadMetadataSchema.safeParse(
    Object.fromEntries(UPLOAD_METADATA_KEYS.filter((key) => key in metadata).map((key) => [key, metadata[key]])),
  );
  if (!parsed.success) {
    // The rules require this metadata; without it nobody can be told, so the file just goes.
    await files.remove(event.path, event.generation);
    log.warn('upload dropped', { matterId, uploadId, reason: 'metadata' });
    return { outcome: 'not_allowed' };
  }
  const meta = parsed.data;
  const docId = meta.documentId ?? uploadId;
  const docRef = db.doc(`${matterPath(orgId, matterId)}/documents/${docId}`);
  const ids = { matterId, uploadId, docId };

  const access = await checkAccess(db, orgId, matterId, meta);
  if ('refused' in access) {
    await files.remove(event.path, event.generation);
    log.warn('upload refused', { ...ids, reason: access.refused });
    return { outcome: 'not_allowed', docId, reason: access.refused };
  }

  const begun = await beginUpload(db, docRef, { orgId, matterId, uploadId, meta, event, access, now: clock.now() });
  if (begun === 'already_done') {
    await files.remove(event.path, event.generation);
    return { outcome: 'already_done', docId };
  }
  if (begun === 'id_taken') {
    // A new document's id is its upload id: an upload may not name an existing document that
    // way (new versions say `documentId`, which the rules and checkAccess check).
    await files.remove(event.path, event.generation);
    log.warn('upload refused', { ...ids, reason: 'id_taken' });
    return { outcome: 'not_allowed', docId, reason: 'not_allowed' };
  }

  const data = await files.read(event.path, event.generation);
  if (!data) {
    log.info('upload gone', ids);
    return { outcome: 'gone', docId };
  }

  const reject = async (reason: DocumentUploadReason): Promise<UploadResult> => {
    await files.remove(event.path, event.generation);
    await markUpload(db, docRef, uploadId, { status: 'rejected', reason }, clock.now());
    log.warn('upload rejected', { ...ids, reason, sizeBytes: data.length });
    return { outcome: 'rejected', docId, reason };
  };

  if (data.length > DOCUMENT_MAX_BYTES) return reject('too_large');
  const sha256 = sha256Hex(data);
  if (sha256 !== meta.sha256) return reject('hash_mismatch');
  const ext = uploadExtension(meta.fileName);
  if (!ext) return reject('type_not_allowed');
  const kind = detectFileKind(data);
  if (!kindMatchesExtension(kind, ext)) return reject('type_mismatch');

  let verdict: Awaited<ReturnType<MalwareScanPort['scan']>>;
  try {
    verdict = await scanWithTimeout(
      deps.scanner,
      { bucket: files.bucket, path: event.path, data },
      deps.scanTimeoutMs ?? SCAN_TIMEOUT_MS,
    );
  } catch (error) {
    const attempts = (event.attempt ?? 0) + 1;
    await markUpload(db, docRef, uploadId, { status: 'delayed', attempts }, clock.now());
    const retry = attempts < SCAN_MAX_ATTEMPTS;
    if (retry) {
      await deps.scheduleRescan(
        { path: event.path, generation: event.generation, attempt: attempts },
        scanRetryDelaySeconds(attempts),
      );
    }
    log.warn('scan delayed', {
      ...ids,
      attempts,
      retry,
      reason: error instanceof ScannerUnavailableError ? error.reason : 'unavailable',
    });
    return { outcome: 'delayed', docId };
  }

  if (verdict.verdict === 'infected') {
    await files.remove(event.path, event.generation);
    await markUpload(db, docRef, uploadId, { status: 'infected' }, clock.now(), { infected: true });
    await notifyInfected(
      db,
      { orgId, matterId, docId, uploadId, uploaderUid: meta.uploaderUid, matter: access.matter },
      clock.now(),
    );
    log.warn('upload infected', { ...ids, signature: verdict.signature ?? 'unknown', sizeBytes: data.length });
    return { outcome: 'infected', docId };
  }

  const pdf = kind === 'pdf' ? await analysePdf(data) : undefined;
  const reserved = await reserveVersion(db, docRef, uploadId);
  if (reserved === 'already_done') {
    await files.remove(event.path, event.generation);
    return { outcome: 'already_done', docId };
  }
  if (reserved === 'version_limit') return reject('version_limit');

  const mime = UPLOAD_TYPES[ext].mime;
  const storagePath = documentVersionPath(orgId, matterId, docId, reserved);
  await files.write(storagePath, data, {
    contentType: mime,
    disposition: attachmentDisposition(meta.fileName),
    metadata: { uploadId },
  });
  const now = clock.now();
  const version: DocumentVersion = {
    version: reserved,
    storagePath,
    fileName: meta.fileName,
    mime,
    sizeBytes: data.length,
    sha256,
    uploadedAt: now,
    uploadedBy: meta.uploaderUid,
    uploadId,
    ...(pdf?.pageCount !== undefined ? { pageCount: pdf.pageCount } : {}),
    ...(pdf?.encrypted ? { encrypted: true } : {}),
  };
  const committed = await commitVersion(db, docRef, { orgId, matterId, docId, version, now });
  await files.remove(event.path, event.generation);
  log.info('version stored', {
    ...ids,
    version: reserved,
    sizeBytes: data.length,
    kind,
    duplicate: !!committed.duplicateOf,
    encrypted: !!pdf?.encrypted,
  });
  if (deps.afterVersion && committed.added) {
    await deps
      .afterVersion({ orgId, matterId, docId, version, kind, data, uploaderUid: meta.uploaderUid })
      .catch((error: unknown) =>
        log.warn('rendition not started', { ...ids, errorType: error instanceof Error ? error.name : typeof error }),
      );
  }
  return { outcome: committed.duplicateOf ? 'duplicate' : 'stored', docId, version: reserved };
}

/**
 * Records the upload on its document in a transaction: creates a new document in the pipeline
 * state, or sets the target document's `upload`. `already_done` when this upload is already a
 * version (a redelivered event or a retry after the move); `id_taken` when a new-document upload's
 * id names a document that isn't its own.
 */
async function beginUpload(
  db: Firestore,
  ref: DocumentReference,
  input: {
    orgId: string;
    matterId: string;
    uploadId: string;
    meta: UploadMetadata;
    event: UploadEvent;
    access: Access;
    now: Date;
  },
): Promise<'begun' | 'already_done' | 'id_taken'> {
  const { meta, uploadId, now, event } = input;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data();
    if (versionsOf(doc).some((v) => v.uploadId === uploadId)) return 'already_done';
    const previous = uploadOf(doc);
    if (doc && !meta.documentId && previous?.uploadId !== uploadId) return 'id_taken';
    const upload: DocumentUpload = {
      uploadId,
      fileName: meta.fileName,
      sizeBytes: event.size,
      uploadedBy: meta.uploaderUid,
      at: previous?.uploadId === uploadId ? previous.at : now,
      status: 'scanning',
      attempts: event.attempt ?? 0,
      ...(previous?.uploadId === uploadId && previous.version ? { version: previous.version } : {}),
    };
    if (doc) {
      tx.update(ref, { upload, updatedAt: now, updatedBy: 'system' });
      return 'begun';
    }
    const created = MatterDocument.schema.parse({
      orgId: input.orgId,
      matterId: input.matterId,
      name: meta.fileName,
      category: meta.category ?? 'other',
      // A document uploaded to a privileged matter is privileged too.
      privileged: meta.privileged === 'true' || input.access.matter['privileged'] === true,
      tags: [],
      version: 0,
      versionSeq: 0,
      versions: [],
      scan: { status: 'pending' },
      upload,
      ingest: { status: 'pending' },
      source: 'upload',
      encrypted: false,
      accessRestricted: false,
      deletedAt: null,
      createdAt: now,
      createdBy: meta.uploaderUid,
      updatedAt: now,
      updatedBy: meta.uploaderUid,
      schemaVersion: MatterDocument.version,
    });
    tx.create(ref, created);
    return 'begun';
  });
}

/**
 * Updates `upload` when it is still this upload (a later upload to the same document wins).
 * `infected` on a document that has no version yet also marks the document itself infected, and
 * `rejected` or `expired` marks it `error`.
 */
async function markUpload(
  db: Firestore,
  ref: DocumentReference,
  uploadId: string,
  patch: Partial<Pick<DocumentUpload, 'status' | 'reason' | 'attempts'>>,
  now: Date,
  options: { infected?: boolean } = {},
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data();
    const upload = uploadOf(doc);
    if (!doc || upload?.uploadId !== uploadId) return;
    const next: Data = { upload: { ...upload, ...patch }, updatedAt: now, updatedBy: 'system' };
    const firstVersion = Number(doc['version'] ?? 0) === 0;
    if (firstVersion && options.infected) next['scan'] = { status: 'infected', at: now };
    else if (firstVersion && (patch.status === 'rejected' || patch.status === 'expired')) {
      next['scan'] = { status: 'error', at: now };
    }
    tx.update(ref, next);
  });
}

/** Reserves the next version number (kept on `upload.version`, so a retry reuses it). */
export async function reserveVersion(
  db: Firestore,
  ref: DocumentReference,
  uploadId: string,
): Promise<number | 'already_done' | 'version_limit'> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() ?? {};
    const versions = versionsOf(doc);
    if (versions.some((v) => v.uploadId === uploadId)) return 'already_done';
    const upload = uploadOf(doc);
    if (upload?.uploadId === uploadId && upload.version) return upload.version;
    if (versions.length >= DOCUMENT_VERSIONS_MAX) return 'version_limit';
    const n =
      Math.max(Number(doc['versionSeq'] ?? 0), Number(doc['version'] ?? 0), ...versions.map((v) => v.version)) + 1;
    tx.update(ref, {
      versionSeq: n,
      ...(upload?.uploadId === uploadId ? { 'upload.version': n } : {}),
    });
    return n;
  });
}

/**
 * Adds a stored version: appends it to `versions`, makes it current when it is the newest, marks
 * the document clean and clears `upload`. For a document's first version, the matter's hash
 * index decides whether it duplicates a live document (read and written in this transaction).
 */
export async function commitVersion(
  db: Firestore,
  ref: DocumentReference,
  input: { orgId: string; matterId: string; docId: string; version: DocumentVersion; now: Date; requestId?: string },
): Promise<{ added: boolean; duplicateOf?: string }> {
  const { version, now } = input;
  const hashRef = db.doc(`${matterPath(input.orgId, input.matterId)}/documentHashes/${version.sha256}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() ?? {};
    const versions = versionsOf(doc);
    if (versions.some((v) => v.uploadId === version.uploadId && v.uploadId)) return { added: false };
    const firstVersion = versions.length === 0;
    const hash = await tx.get(hashRef);
    const indexedId = hash.get('documentId') as string | undefined;
    let duplicateOf: string | undefined;
    if (indexedId && indexedId !== input.docId) {
      const original = await tx.get(db.doc(`${matterPath(input.orgId, input.matterId)}/documents/${indexedId}`));
      const live = original.exists && !isDeleted(original.data()) && original.get('sha256') === version.sha256;
      if (live && firstVersion) duplicateOf = indexedId;
      if (!live) tx.set(hashRef, hashEntry(input.docId, now));
    } else if (!indexedId) {
      tx.set(hashRef, hashEntry(input.docId, now));
    }

    const current = Number(doc['version'] ?? 0);
    const becomesCurrent = version.version > current;
    const upload = uploadOf(doc);
    tx.update(ref, {
      versions: [...versions, version].sort((a, b) => a.version - b.version),
      scan: { status: 'clean', at: now },
      ...(becomesCurrent
        ? {
            version: version.version,
            storagePath: version.storagePath,
            mime: version.mime,
            sizeBytes: version.sizeBytes,
            sha256: version.sha256,
            pageCount: version.pageCount ?? FieldValue.delete(),
            encrypted: version.encrypted ?? false,
            renditions: version.renditions ?? FieldValue.delete(),
            ingest: { status: 'pending' },
          }
        : {}),
      ...(upload?.uploadId === version.uploadId ? { upload: FieldValue.delete() } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
      updatedAt: now,
      updatedBy: version.uploadedBy,
      ...(input.requestId ? { _requestId: input.requestId } : {}),
    });
    return { added: true, ...(duplicateOf ? { duplicateOf } : {}) };
  });
}

const hashEntry = (documentId: string, now: Date) =>
  DocumentHash.schema.parse({
    documentId,
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: DocumentHash.version,
  });

/**
 * An infected upload: a high-priority in-app notification to the uploader and to every active
 * owner and admin (one each, idempotent by upload id). No file name: names can carry personal data.
 */
async function notifyInfected(
  db: Firestore,
  input: { orgId: string; matterId: string; docId: string; uploadId: string; uploaderUid: string; matter: Data },
  now: Date,
): Promise<string[]> {
  const admins = await db
    .collection(`orgs/${input.orgId}/members`)
    .where('status', '==', 'active')
    .where('role', 'in', ['owner', 'admin'])
    .get();
  const recipients = [...new Set([input.uploaderUid, ...admins.docs.map((doc) => doc.id)])];
  const number =
    typeof input.matter['number'] === 'string' && input.matter['number'] ? input.matter['number'] : 'a matter';
  for (const recipientUid of recipients) {
    const notification = Notification.schema.parse({
      kind: 'document_infected',
      matterId: input.matterId,
      documentId: input.docId,
      recipientUid,
      title: 'Infected file removed',
      body: `A file uploaded to ${number} failed the malware scan and was deleted.`,
      link: `/matters/${input.matterId}/documents`,
      channel: ['inapp'],
      priority: 'high',
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      updatedBy: 'system',
      schemaVersion: Notification.version,
    });
    await db.doc(`orgs/${input.orgId}/notifications/infected-${input.uploadId}-${recipientUid}`).set(notification);
  }
  return recipients;
}

/**
 * `documents-sweepPending` (hourly): uploads still quarantined after 24 hours (the scanner never
 * cleared them, or the trigger never ran) are deleted, and their document says `expired`.
 */
export async function expirePendingUploads(
  deps: Pick<PipelineDeps, 'db' | 'files' | 'clock' | 'log'>,
  ttlMs: number,
): Promise<number> {
  const { db, files, clock, log } = deps;
  const cutoff = clock.now().getTime() - ttlMs;
  const objects = await files.list('orgs/', 'orgs/*/matters/*/pending/*');
  let expired = 0;
  for (const object of objects) {
    const match = PENDING_UPLOAD_PATH.exec(object.path);
    if (!match || !object.timeCreated || object.timeCreated.getTime() > cutoff) continue;
    const [, orgId, matterId, uploadId] = match as unknown as [string, string, string, string];
    const docId = object.metadata['documentId'] ?? uploadId;
    const ref = db.doc(`${matterPath(orgId, matterId)}/documents/${docId}`);
    await markUpload(db, ref, uploadId, { status: 'expired' }, clock.now());
    await files.remove(object.path, object.generation);
    expired++;
    log.info('upload expired', { matterId, uploadId, docId });
  }
  return expired;
}
