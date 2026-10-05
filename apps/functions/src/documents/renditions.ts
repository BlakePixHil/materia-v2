import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import { isEmailFile, renditionPath, type DocumentVersion, type RenditionKind } from '@materia/domain';

import { parseMessage } from './email';
import type { FileStore } from './files';
import type { AfterVersion } from './pipeline';
import { documentPath, versionsOf } from './shared';
import type { Log } from '../core/log';
import type { Clock, Ports } from '../ports';

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

/**
 * Builds the renditions a new version gets (CORE-12, ADR-028): an email (.eml, .msg) becomes a
 * JSON rendition (`message.json`: headers, plain-text body, attachments) the web app shows and
 * saves attachments from. Office and HEIC previews are a follow-up (ADR-028). Best effort: the
 * version is already stored, and a message that can't be parsed is still downloadable.
 */
export async function startRenditions(deps: RenditionDeps, stored: Parameters<AfterVersion>[0]): Promise<void> {
  const { orgId, matterId, docId, version, data } = stored;
  const ids = { matterId, docId, version: version.version };
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
