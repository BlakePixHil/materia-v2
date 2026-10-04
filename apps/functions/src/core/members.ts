import type { Firestore } from 'firebase-admin/firestore';

import type { Clock } from '../ports';

/** Looks up whether a uid is an active member of an org. */
export type MemberLookup = (orgId: string, uid: string) => Promise<boolean>;

const TTL_MS = 60_000;

/**
 * Reads `orgs/{orgId}/members/{uid}` and caches the answer for 60 s per instance, so a burst of
 * calls costs one read. A suspension therefore takes effect within a minute.
 */
export function cachedMemberLookup(db: () => Firestore, clock: Clock): MemberLookup & { clear(): void } {
  const cache = new Map<string, { active: boolean; until: number }>();
  const lookup = async (orgId: string, uid: string) => {
    const key = `${orgId}/${uid}`;
    const hit = cache.get(key);
    const now = clock.now().getTime();
    if (hit && hit.until > now) return hit.active;
    const snap = await db().doc(`orgs/${orgId}/members/${uid}`).get();
    const active = snap.exists && snap.get('status') === 'active';
    cache.set(key, { active, until: now + TTL_MS });
    return active;
  };
  return Object.assign(lookup, { clear: () => cache.clear() });
}
