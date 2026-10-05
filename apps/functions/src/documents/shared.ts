import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

import { can, DomainError, type DocumentVersion, type Role } from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { liveMatter, matterPath, writableMatter } from '../matters/shared';

type Data = Record<string, unknown>;

export const documentPath = (orgId: string, matterId: string, docId: string) =>
  `${matterPath(orgId, matterId)}/documents/${docId}`;

/**
 * A document the caller may act on: it exists and, when privileged, the role has
 * `privileged.view`. Anything else is NOT_FOUND, so privileged documents stay invisible to
 * readonly (and their existence isn't revealed). Soft-deleted documents pass unless `live` is set.
 */
export function visibleDocument(snap: DocumentSnapshot, role: Role, docId: string, live = true): Data {
  const data = snap.data();
  if (!snap.exists || !data || (data['privileged'] === true && !can(role, 'privileged.view'))) {
    throw new DomainError('NOT_FOUND', 'Document not found', { docId });
  }
  if (live && isDeleted(data)) throw new DomainError('NOT_FOUND', 'Document not found', { docId });
  return data;
}

/**
 * The matter (live, visible) and the document (visible, live) in one read. `write`: the caller
 * changes something, so an archived matter (read-only, CORE-19) is refused.
 */
export async function loadDocument(
  db: Firestore,
  orgId: string,
  role: Role,
  matterId: string,
  docId: string,
  write = false,
): Promise<{ matter: Data; doc: Data }> {
  const [matterSnap, docSnap] = await db.getAll(
    db.doc(matterPath(orgId, matterId)),
    db.doc(documentPath(orgId, matterId, docId)),
  );
  const matter = (write ? writableMatter : liveMatter)(matterSnap as DocumentSnapshot, role, matterId);
  const doc = visibleDocument(docSnap as DocumentSnapshot, role, docId);
  return { matter, doc };
}

export const versionsOf = (doc: Data | undefined): DocumentVersion[] =>
  Array.isArray(doc?.['versions']) ? (doc['versions'] as DocumentVersion[]) : [];

export const isClean = (doc: Data) => (doc['scan'] as { status?: string } | undefined)?.status === 'clean';
