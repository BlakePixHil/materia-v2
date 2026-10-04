import type { Auth, UserRecord } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  computeClaims,
  pickActiveOrg,
  ROLES,
  TENANCY_CLAIM_KEYS,
  type MembershipRole,
  type Role,
  type TenancyClaims,
} from '@materia/domain';

export interface ClaimsDeps {
  db: Firestore;
  auth: Auth;
  now: Date;
}

export interface SyncOptions {
  /** Orgs to look at beyond those already on `users/{uid}` (the org just joined or changed). */
  alsoOrgIds?: readonly string[];
  /** Make this org active (when the person is an active member of it). */
  activeOrgId?: string;
}

export interface SyncResult {
  claims: TenancyClaims;
  activeOrgId: string | null;
  memberships: MembershipRole[];
  /** Whether the custom claims changed (and `claimsVersion` was incremented). */
  changed: boolean;
}

const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** The tenancy part of a claims object, with keys in a fixed order (for comparison). */
function tenancyPart(claims: Record<string, unknown> | undefined): string {
  const entries = TENANCY_CLAIM_KEYS.flatMap((key) => (claims?.[key] === undefined ? [] : [[key, claims[key]]]));
  return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

/** New custom claims: the tenancy claims replaced, everything else (`platformAdmin`) kept. */
export function mergeClaims(existing: Record<string, unknown> | undefined, tenancy: TenancyClaims) {
  const kept = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !(TENANCY_CLAIM_KEYS as readonly string[]).includes(key)),
  );
  return { ...kept, ...tenancy };
}

/** Profile defaults for a person's first `users/{uid}` document. */
function newUserDoc(user: UserRecord, now: Date) {
  const email = (user.email ?? '').toLowerCase();
  const displayName = user.displayName?.trim() || email.split('@')[0] || 'Member';
  const [firstName = displayName, ...rest] = displayName.split(' ');
  return {
    email,
    displayName,
    firstName,
    lastName: rest.join(' '),
    prefs: {
      theme: 'system',
      density: 'comfortable',
      shortcuts: true,
      notifications: { email: true, push: false, digestHour: 7 },
    },
    createdAt: now,
    createdBy: 'system',
    schemaVersion: 1,
  };
}

/**
 * Records the org a person is about to make active. Callables write this before (or with) the
 * member write that fires `auth-syncClaims`, so the trigger's pass agrees on the active org.
 */
export const activeOrgPatch = (orgId: string) => ({ activeOrgId: orgId });

/**
 * Recomputes a person's tenancy claims from their member documents (FND-17, ADR-005) and mirrors
 * them on `users/{uid}`: `orgIds`, `memberships` (with org names, for the switcher), `activeOrgId`,
 * and `claimsVersion`, which goes up whenever the claims change so the client refreshes its token.
 *
 * The member documents are the source of truth; `users/{uid}` only says which orgs to look at. The
 * claims are set before `claimsVersion` moves, so a client that refreshes on the change sees them.
 * Used by the orgs callables (so the caller's next token is right) and by `auth-syncClaims`.
 */
export async function syncClaims(deps: ClaimsDeps, uid: string, options: SyncOptions = {}): Promise<SyncResult> {
  const { db, auth, now } = deps;
  const userRef = db.doc(`users/${uid}`);
  const [userSnap, record] = await Promise.all([userRef.get(), auth.getUser(uid)]);
  const user = userSnap.data() ?? {};
  const orgIds = [
    ...new Set([
      ...((user['orgIds'] as string[] | undefined) ?? []),
      ...Object.keys((user['memberships'] as Record<string, unknown> | undefined) ?? {}),
      ...(options.alsoOrgIds ?? []),
      ...(options.activeOrgId ? [options.activeOrgId] : []),
    ]),
  ].sort();

  const memberships: MembershipRole[] = [];
  if (orgIds.length) {
    const refs = orgIds.flatMap((orgId) => [db.doc(`orgs/${orgId}/members/${uid}`), db.doc(`orgs/${orgId}`)]);
    const snaps = await db.getAll(...refs);
    orgIds.forEach((orgId, i) => {
      const member = snaps[i * 2];
      const org = snaps[i * 2 + 1];
      const role = member?.get('role') as unknown;
      // The member document decides; the org document only supplies the name.
      if (member?.exists && member.get('status') === 'active' && isRole(role)) {
        memberships.push({ orgId, role, name: String(org?.get('name') ?? '') });
      }
    });
  }

  const preferred = options.activeOrgId ?? (user['activeOrgId'] as string | null | undefined) ?? null;
  const activeOrgId = pickActiveOrg(memberships, preferred);
  const claims = computeClaims(memberships, activeOrgId);
  const changed = tenancyPart(record.customClaims) !== tenancyPart(claims as Record<string, unknown>);
  if (changed) await auth.setCustomUserClaims(uid, mergeClaims(record.customClaims, claims));

  const mirror = {
    orgIds: memberships.map((m) => m.orgId),
    memberships: Object.fromEntries(memberships.map((m) => [m.orgId, { role: m.role, name: m.name }])),
    activeOrgId,
    updatedAt: now,
    updatedBy: 'system',
  };
  // update() replaces the memberships map as a whole (set with merge would keep removed orgs). A
  // document holding only `activeOrgId` (written ahead by a callable) still needs its profile.
  if (userSnap.exists && userSnap.get('email') !== undefined) {
    await userRef.update({ ...mirror, ...(changed ? { claimsVersion: FieldValue.increment(1) } : {}) });
  } else {
    await userRef.set({ ...newUserDoc(record, now), ...mirror, claimsVersion: changed ? 1 : 0 }, { merge: true });
  }
  return { claims, activeOrgId, memberships, changed };
}
