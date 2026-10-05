import { FieldPath, type Firestore, type QuerySnapshot } from 'firebase-admin/firestore';

import { contactDisplayName, RoleSchema, type Contact } from '@materia/domain';

import type { ContextSource, Row } from './ports';

const rows = (snap: QuerySnapshot): Row[] => snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));

/** Reads that would be unbounded on a large matter are capped; `buildContext` keeps far fewer. */
const MAX_ROWS = 200;

/**
 * `buildContext`'s reads on Firestore (AI-03). Every query is a matter subcollection under the
 * caller's org, so nothing crosses orgs or matters. Single-field filters only (no new indexes);
 * notes without `privileged.view` use the CORE-13 `privileged + createdAt` index, so the query
 * itself proves `privileged == false`.
 */
export function firestoreContextSource(db: Firestore): ContextSource {
  const matterPath = (orgId: string, matterId: string) => `orgs/${orgId}/matters/${matterId}`;
  const sub = (orgId: string, matterId: string, name: string) =>
    db.collection(`${matterPath(orgId, matterId)}/${name}`);

  return {
    async member(orgId, uid) {
      const snap = await db.doc(`orgs/${orgId}/members/${uid}`).get();
      if (!snap.exists) return null;
      const role = RoleSchema.safeParse(snap.get('role'));
      const status = snap.get('status');
      if (!role.success || typeof status !== 'string') return null;
      return { status, role: role.data };
    },

    async orgTimeZone(orgId) {
      const timezone = (await db.doc(`orgs/${orgId}`).get()).get('timezone');
      return typeof timezone === 'string' && timezone ? timezone : undefined;
    },

    async matter(orgId, matterId) {
      const snap = await db.doc(matterPath(orgId, matterId)).get();
      return snap.exists ? { id: snap.id, data: snap.data() ?? {} } : null;
    },

    async parties(orgId, matterId) {
      return rows(await sub(orgId, matterId, 'parties').limit(MAX_ROWS).get());
    },

    async contactNames(orgId, contactIds) {
      const names = new Map<string, string>();
      if (!contactIds.length) return names;
      const snaps = await db.getAll(...contactIds.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)));
      for (const snap of snaps) {
        if (snap.exists) names.set(snap.id, contactDisplayName(snap.data() as Partial<Contact>));
      }
      return names;
    },

    async events(orgId, matterId) {
      return rows(await sub(orgId, matterId, 'events').orderBy('date', 'desc').limit(MAX_ROWS).get());
    },

    async openDeadlines(orgId, matterId) {
      return rows(
        await sub(orgId, matterId, 'deadlines').where('status', 'in', ['upcoming', 'blocked']).limit(MAX_ROWS).get(),
      );
    },

    async openTasks(orgId, matterId) {
      return rows(
        await sub(orgId, matterId, 'tasks')
          .where('status', 'in', ['todo', 'in_progress', 'blocked'])
          .limit(MAX_ROWS)
          .get(),
      );
    },

    async recentNotes(orgId, matterId, { allowPrivileged, limit }) {
      let query = sub(orgId, matterId, 'notes').orderBy('createdAt', 'desc');
      if (!allowPrivileged)
        query = sub(orgId, matterId, 'notes').where('privileged', '==', false).orderBy('createdAt', 'desc');
      return rows(await query.limit(limit).get());
    },

    async documents(orgId, matterId, ids) {
      if (!ids.length) return [];
      const snaps = await db.getAll(...ids.map((id) => db.doc(`${matterPath(orgId, matterId)}/documents/${id}`)));
      return snaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, data: snap.data() ?? {} }));
    },

    async metrics(orgId, limit) {
      return rows(
        await db.collection(`orgs/${orgId}/metrics`).orderBy(FieldPath.documentId(), 'desc').limit(limit).get(),
      );
    },
  };
}
