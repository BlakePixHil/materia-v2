import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

import { can, contactDisplayName, DomainError, matterSearchTokens, type Contact, type Role } from '@materia/domain';

import { isDeleted, isLive } from '../contacts/shared';

/** Shared helpers for the matters functions (CORE-03). */

export const mattersPath = (orgId: string) => `orgs/${orgId}/matters`;
export const matterPath = (orgId: string, matterId: string) => `${mattersPath(orgId)}/${matterId}`;
export const counterPath = (orgId: string, counterId: string) => `orgs/${orgId}/counters/${counterId}`;
export const matterNumberPath = (orgId: string, key: string) => `orgs/${orgId}/matterNumbers/${key}`;

type Data = Record<string, unknown>;

/**
 * A matter's data when the caller may act on it: it exists, is not soft-deleted and, when
 * privileged, the caller's role has `privileged.view`. Anything else is NOT_FOUND, so a privileged
 * matter's existence isn't revealed.
 */
export function liveMatter(snap: DocumentSnapshot, role: Role, matterId: string): Data {
  const data = snap.data();
  if (!snap.exists || !data || isDeleted(data) || (data['privileged'] === true && !can(role, 'privileged.view'))) {
    throw new DomainError('NOT_FOUND', 'Matter not found', { matterId });
  }
  return data;
}

/** The display names of the contacts a matter's search covers (missing contacts are skipped). */
export async function contactNames(db: Firestore, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)));
  const names = new Map<string, string>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const name = contactDisplayName(snap.data() as Partial<Contact>);
    if (name) names.set(snap.id, name);
  }
  return names;
}

/** The contact ids a matter's search reads: its clients and its deceased. */
export function searchContactIds(matter: Data): string[] {
  const clients = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const deceased = (matter['deceased'] as { contactId?: string } | undefined)?.contactId;
  return [...clients, ...(deceased ? [deceased] : [])];
}

/** `search` for a matter: number, title, client and deceased names, and the external reference. */
export function matterSearch(matter: Data, names: ReadonlyMap<string, string>): string[] {
  const clients = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const deceased = (matter['deceased'] as { contactId?: string } | undefined)?.contactId;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const deceasedName = deceased ? names.get(deceased) : undefined;
  const externalRef = text(matter['externalRef']);
  return matterSearchTokens({
    number: text(matter['number']),
    title: text(matter['title']),
    clientNames: clients.map((id) => names.get(id)).filter((name): name is string => !!name),
    ...(deceasedName ? { deceasedName } : {}),
    ...(externalRef ? { externalRef } : {}),
  });
}

/** Contacts a new matter may reference: live (not deleted, not merged) and in the org. */
export async function liveContactIds(db: Firestore, orgId: string, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const snaps = await db.getAll(...unique.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)));
  return new Set(snaps.filter((snap) => snap.exists && isLive(snap.data())).map((snap) => snap.id));
}
