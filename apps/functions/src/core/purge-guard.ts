import type { Firestore } from 'firebase-admin/firestore';

import { ORG_PURGE_QUEUE } from '@materia/domain';

import type { Clock } from '../ports';

/**
 * Whether a practice is being deleted, or was (SEC-05): its `deletedOrgs/{orgId}` tombstone
 * exists. Triggers and queued tasks for it are skipped, so nothing writes into a practice while
 * the deletion job takes it apart (the audit trigger would otherwise record every delete, and a
 * late reminder recreate a notification). A "yes" is kept for the instance's life (a deletion is
 * never undone); a "no" for 30 seconds, and the deletion job waits two minutes after writing the
 * tombstone before it deletes anything, so every instance has seen it by then.
 */
export type PurgeLookup = ((orgId: string) => Promise<boolean>) & { clear(): void };

export const PURGE_LOOKUP_TTL_MS = 30_000;

export function cachedPurgeLookup(db: () => Firestore, clock: Clock, ttlMs = PURGE_LOOKUP_TTL_MS): PurgeLookup {
  const purging = new Set<string>();
  const notPurging = new Map<string, number>();
  const lookup = async (orgId: string) => {
    if (purging.has(orgId)) return true;
    const now = clock.now().getTime();
    const until = notPurging.get(orgId);
    if (until !== undefined && until > now) return false;
    const exists = (await db().doc(`deletedOrgs/${orgId}`).get()).exists;
    if (exists) {
      purging.add(orgId);
      notPurging.delete(orgId);
    } else {
      notPurging.set(orgId, now + ttlMs);
    }
    return exists;
  };
  return Object.assign(lookup, {
    clear: () => {
      purging.clear();
      notPurging.clear();
    },
  });
}

/** The `orgId` of a task's payload, when it has one. */
export function payloadOrgId(payload: unknown): string | null {
  const orgId = (payload as { orgId?: unknown } | null | undefined)?.orgId;
  return typeof orgId === 'string' && orgId ? orgId : null;
}

/**
 * The practice a queued task is for, when that practice is being deleted (so the task is
 * dropped), or null. The deletion job's own queue always runs.
 */
export async function purgedTaskOrg(queue: string, payload: unknown, purging: PurgeLookup): Promise<string | null> {
  if (queue === ORG_PURGE_QUEUE) return null;
  const orgId = payloadOrgId(payload);
  return orgId && (await purging(orgId)) ? orgId : null;
}
