import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import {
  DocIdSchema,
  isEmailFile,
  renditionPath,
  uploadExtension,
  type DocumentVersion,
  type RenditionKind,
} from '@materia/domain';

import { parseMessage } from './email';
import type { FileStore } from './files';
import type { AfterVersion } from './pipeline';
import { documentPath, versionsOf } from './shared';
import { isDeleted } from '../contacts/shared';
import type { Log } from '../core/log';
import { PreviewUnavailableError, type Clock, type Ports, type PreviewTarget } from '../ports';

export interface RenditionDeps {
  db: Firestore;
  files: FileStore;
  ports: Ports;
  log: Log;
  clock: Clock;
}

/**
 * Records a stored rendition on its version and, while that version is current, on the document
 * (in a transaction, so a newer version is never given an older one's rendition).
 */
export async function recordRendition(
  db: Firestore,
  ref: DocumentReference,
  version: number,
  kind: RenditionKind,
  path: string,
  now: Date,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data();
    if (!doc) return false;
    const versions = versionsOf(doc);
    if (!versions.some((v) => v.version === version)) return false;
    const next: DocumentVersion[] = versions.map((v) =>
      v.version === version ? { ...v, renditions: { ...v.renditions, [kind]: path } } : v,
    );
    const current = doc['version'] === version;
    tx.update(ref, {
      versions: next,
      ...(current ? { renditions: { ...(doc['renditions'] as object | undefined), [kind]: path } } : {}),
      updatedAt: now,
      updatedBy: 'system',
    });
    return true;
  });
}

/** The Cloud Tasks queue (and function) that builds Office and HEIC previews (CORE-12a). */
export const RENDER_QUEUE = 'documents-render';

const OFFICE = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx']);

/** The preview a file gets from the preview service: Office → PDF, HEIC → JPEG; null for others. */
export function previewFor(
  fileName: string,
): { rendition: 'previewPdf' | 'previewImage'; from: string; to: PreviewTarget; contentType: string } | null {
  const ext = uploadExtension(fileName);
  if (ext && OFFICE.has(ext)) return { rendition: 'previewPdf', from: ext, to: 'pdf', contentType: 'application/pdf' };
  if (ext === 'heic') return { rendition: 'previewImage', from: ext, to: 'jpeg', contentType: 'image/jpeg' };
  return null;
}

/**
 * Builds the renditions a new version gets (CORE-12, ADR-028): an email (.eml, .msg) becomes a
 * JSON rendition (`message.json`: headers, plain-text body, attachments) the web app shows and
 * saves attachments from. An Office file or HEIC photo is queued for a preview
 * (`documents-render`, CORE-12a), because converting it can take longer than the upload trigger
 * should wait. Best effort: the version is already stored, and a file without a rendition is
 * still downloadable.
 */
export async function startRenditions(deps: RenditionDeps, stored: Parameters<AfterVersion>[0]): Promise<void> {
  const { orgId, matterId, docId, version, data } = stored;
  const ids = { matterId, docId, version: version.version };
  if (previewFor(version.fileName)) {
    await deps.ports.tasks.enqueue(
      RENDER_QUEUE,
      { orgId, matterId, docId, version: version.version },
      { dedupeKey: `render#${orgId}#${matterId}#${docId}#${version.version}` },
    );
    deps.log.info('preview queued', ids);
    return;
  }
  if (!isEmailFile(version.fileName)) return;
  let json: string;
  try {
    const message = await parseMessage(version.fileName, data);
    json = JSON.stringify(message.rendition);
  } catch (error) {
    deps.log.warn('message not parsed', { ...ids, errorType: error instanceof Error ? error.name : typeof error });
    return;
  }
  const path = renditionPath(orgId, matterId, docId, version.version, 'message');
  await deps.files.write(path, Buffer.from(json), { contentType: 'application/json' });
  const recorded = await recordRendition(
    deps.db,
    deps.db.doc(documentPath(orgId, matterId, docId)),
    version.version,
    'message',
    path,
    deps.clock.now(),
  );
  deps.log.info('message rendition', { ...ids, recorded });
}

export const RenderTaskSchema = z.object({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  docId: DocIdSchema,
  version: z.number().int().min(1),
});
export type RenderTask = z.infer<typeof RenderTaskSchema>;

/** How long one conversion may take (LibreOffice on a cold instance included). */
export const PREVIEW_TIMEOUT_MS = 150_000;

/**
 * `documents-render` (CORE-12a): converts one stored version with the preview service and records
 * the rendition (`renditions/v{n}/preview.pdf` or `preview.jpg`). Idempotent: a version that
 * already has its preview, a removed document or a missing version is skipped. A file the service
 * can't convert is logged and left without a preview (the web app says "download instead"); a
 * service outage throws, so Cloud Tasks retries.
 */
export async function renderPreview(task: RenderTask, deps: RenditionDeps): Promise<'rendered' | 'skipped' | 'failed'> {
  const { orgId, matterId, docId } = task;
  const ids = { matterId, docId, version: task.version };
  const ref = deps.db.doc(documentPath(orgId, matterId, docId));
  const doc = (await ref.get()).data();
  const version = versionsOf(doc).find((v) => v.version === task.version);
  const preview = version ? previewFor(version.fileName) : null;
  if (!doc || isDeleted(doc) || !version || !preview || version.renditions?.[preview.rendition]) return 'skipped';
  const data = await deps.files.read(version.storagePath);
  if (!data) return 'skipped';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  let output: Buffer;
  try {
    output = await deps.ports.preview.render({ from: preview.from, to: preview.to, data }, controller.signal);
  } catch (error) {
    if (error instanceof PreviewUnavailableError && error.reason === 'failed') {
      deps.log.warn('preview failed', { ...ids, from: preview.from, sizeBytes: data.length });
      return 'failed';
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const path = renditionPath(orgId, matterId, docId, version.version, preview.rendition);
  await deps.files.write(path, output, { contentType: preview.contentType });
  const recorded = await recordRendition(deps.db, ref, version.version, preview.rendition, path, deps.clock.now());
  deps.log.info('preview rendition', { ...ids, rendition: preview.rendition, outBytes: output.length, recorded });
  return 'rendered';
}
