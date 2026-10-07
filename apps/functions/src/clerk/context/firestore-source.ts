import { type Firestore, type QuerySnapshot } from 'firebase-admin/firestore';

import {
  contactDisplayName,
  OPEN_SUGGESTION_STATUSES,
  RoleSchema,
  sumMetricShards,
  trustSettingsOf,
  type Contact,
} from '@materia/domain';

import type { ContextSource, Row } from './ports';
import { isEnabled } from '../../core/flags';

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
      const displayName = snap.get('displayName');
      const title = snap.get('title');
      return {
        status,
        role: role.data,
        ...(typeof displayName === 'string' && displayName ? { displayName } : {}),
        ...(typeof title === 'string' && title ? { title } : {}),
      };
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

    async recentActivity(orgId, matterId, { limit }) {
      return rows(await sub(orgId, matterId, 'activity').orderBy('at', 'desc').limit(limit).get());
    },

    async recentDocuments(orgId, matterId, { limit }) {
      return rows(await sub(orgId, matterId, 'documents').orderBy('createdAt', 'desc').limit(limit).get());
    },

    async openSuggestions(orgId, matterId, { limit }) {
      return rows(
        await sub(orgId, matterId, 'suggestions')
          .where('status', 'in', [...OPEN_SUGGESTION_STATUSES])
          .limit(limit)
          .get(),
      );
    },

    async metricMonths(orgId, months) {
      const read = await Promise.all(
        months.map(async (month) => {
          const ref = db.doc(`orgs/${orgId}/metrics/month-${month}`);
          // Shards exist only in an org that has had more than 20 active members (ADR-048); the
          // nightly recompute folds them back, so most months have none.
          const [snap, shards] = await Promise.all([ref.get(), ref.collection('shards').get()]);
          if (!snap.exists && shards.empty) return null;
          const data: Record<string, unknown> = snap.data() ?? { period: `month-${month}` };
          const values = sumMetricShards(
            data['values'] as Record<string, unknown> | undefined,
            shards.docs.map((shard) => shard.get('values') as Record<string, unknown> | undefined),
          );
          const row: Row = { id: ref.id, data: { ...data, values } };
          return row;
        }),
      );
      return read.filter((row): row is Row => row !== null);
    },

    async trustSnapshot(orgId, matterId) {
      if (!(await isEnabled({ orgId, db, clock: { now: () => new Date() } }, 'billing.trustDisplay'))) return null;
      const settings = trustSettingsOf((await db.doc(`orgs/${orgId}`).get()).data());
      if (!settings.showOnMatters) return null;
      const snap = await db.doc(`orgs/${orgId}/trustSnapshots/${matterId}`).get();
      return snap.exists
        ? { snapshot: { id: snap.id, data: snap.data() ?? {} }, staleAfterDays: settings.staleAfterDays }
        : null;
    },
  };
}
