import type { Firestore } from 'firebase-admin/firestore';

import { DEFAULT_ORG_TIMEZONE, DomainError, trustSettingsOf, type TrustSettings } from '@materia/domain';

import { requireFlag } from '../core/flags';
import type { Clock } from '../ports';

type Data = Record<string, unknown>;

/** `orgs/{orgId}/trustSnapshots/{matterId}`: one snapshot per matter, the latest copy only. */
export const trustSnapshotPath = (orgId: string, matterId: string) => `orgs/${orgId}/trustSnapshots/${matterId}`;

/** A matter's trust record (its snapshot), which destroying the matter deletes (CORE-19). */
export const matterTrustDoc = (db: Firestore, orgId: string, matterId: string) =>
  db.doc(trustSnapshotPath(orgId, matterId));

/** The org, with the trust feature on: the flag is server-enforced (FND-23). */
export async function trustOrg(
  db: Firestore,
  orgId: string,
  clock: Clock,
): Promise<{ data: Data; settings: TrustSettings; timeZone: string }> {
  await requireFlag({ orgId, db, clock }, 'billing.trustDisplay');
  const data = (await db.doc(`orgs/${orgId}`).get()).data();
  if (!data) throw new DomainError('NOT_FOUND', 'Organisation not found');
  const timeZone = typeof data['timezone'] === 'string' && data['timezone'] ? data['timezone'] : DEFAULT_ORG_TIMEZONE;
  return { data, settings: trustSettingsOf(data as { trust?: TrustSettings }), timeZone };
}
