import { InjectionToken } from '@angular/core';

import { resolveSecurity, type OrgSecurity, type ResolvedSecurity, type Role } from '@materia/domain';

import type { FirestoreSource } from './firestore/firestore-client';
import type { ListenerRegistry } from './listener-registry';

/** The part of `users/{uid}` the app follows (FND-17): the claims version and the memberships. */
export interface UserTenancy {
  claimsVersion: number;
  activeOrgId: string | null;
  /** Active memberships with the org name, for the org switcher. */
  memberships: Record<string, { role: Role; name: string }>;
}

/** A row of the team list (from `MemberListItem`, plus the uid). */
export interface TeamMember {
  uid: string;
  displayName: string;
  email: string | null;
  initials: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  colour: string;
}

/** A pending invite (the token never leaves the server). */
export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

/**
 * Reads for tenancy (FND-17): the signed-in person's `users/{uid}` (a live listener since FND-19)
 * and the pending invites. Members are read through `membersRepository()` (FND-19). The Firebase implementation loads Firestore lazily.
 */
export interface TenancyPort {
  /** Calls back with the user's tenancy now and on every change; returns the unsubscribe. */
  watchUser(uid: string, callback: (tenancy: UserTenancy | null) => void): () => void;
  invites(orgId: string): Promise<PendingInvite[]>;
  /**
   * The org's security policy and this member's `sessionsValidAfter` (SEC-04), now and on every
   * change; null when they can't be read. Both documents stay readable whatever the policy says.
   */
  watchSecurity?(orgId: string, uid: string, callback: (security: SessionSecurity | null) => void): () => void;
}

/** What the app enforces on this sign-in (SEC-04). */
export interface SessionSecurity {
  policy: ResolvedSecurity;
  /** Sign-ins before this were signed out everywhere. */
  validAfter: Date | null;
}

const asDate = (value: unknown): Date | undefined =>
  value instanceof Date
    ? value
    : value && typeof value === 'object' && 'toDate' in value
      ? (value as { toDate(): Date }).toDate()
      : undefined;

/** The org document's `security`, with Timestamps as Dates and defaults filled. */
export function toResolvedSecurity(raw: unknown): ResolvedSecurity {
  if (!raw || typeof raw !== 'object') return resolveSecurity(undefined);
  const security = raw as Record<string, unknown>;
  return resolveSecurity({
    ...(security as Partial<OrgSecurity>),
    mfaRequiredSince: asDate(security['mfaRequiredSince']),
    mfaEnforceAfter: asDate(security['mfaEnforceAfter']),
  });
}

export const TENANCY_PORT = new InjectionToken<TenancyPort>('TENANCY_PORT');

/** A port that never loads anything, for tests and pages without Firebase. */
export const NULL_TENANCY_PORT: TenancyPort = {
  watchUser: () => () => undefined,
  invites: async () => [],
};

/** Parses `users/{uid}` defensively: a missing field means "not set yet". */
export function toUserTenancy(data: Record<string, unknown> | undefined): UserTenancy | null {
  if (!data) return null;
  const memberships = (data['memberships'] ?? {}) as UserTenancy['memberships'];
  return {
    claimsVersion: typeof data['claimsVersion'] === 'number' ? data['claimsVersion'] : 0,
    activeOrgId: typeof data['activeOrgId'] === 'string' ? data['activeOrgId'] : null,
    memberships: typeof memberships === 'object' && memberships ? memberships : {},
  };
}

/**
 * The Firestore implementation (FND-19), on the full SDK's `FirestoreClient`: `watchUser` is a
 * snapshot listener on `users/{uid}`, tracked by the `ListenerRegistry`, so a claims change applies
 * as soon as `auth-syncClaims` writes it (ADR-021 allowed this once the full SDK was in).
 */
export function firestoreTenancyPort(source: FirestoreSource, registry: ListenerRegistry): TenancyPort {
  return {
    watchUser(uid, callback) {
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      let last: string | undefined;
      source.get().then(
        ({ sdk, db }) => {
          if (stopped) return;
          unsubscribe = sdk.onSnapshot(
            sdk.doc(db, 'users', uid),
            (snap) => {
              const tenancy = toUserTenancy(snap.data());
              const key = JSON.stringify(tenancy);
              if (!stopped && key !== last) {
                last = key;
                callback(tenancy);
              }
            },
            // Refused after a sign-out in another tab: the session watcher takes it from here.
            () => undefined,
          );
        },
        () => undefined,
      );
      return registry.add(
        () => {
          stopped = true;
          unsubscribe?.();
        },
        { label: `users/${uid}` },
      );
    },
    async invites(orgId) {
      const { sdk, db } = await source.get();
      const snap = await sdk.getDocs(
        sdk.query(sdk.collection(db, 'orgs', orgId, 'invites'), sdk.where('status', '==', 'pending')),
      );
      return snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            email: String(data['email']),
            role: data['role'] as Role,
            expiresAt: (data['expiresAt'] as { toDate(): Date }).toDate(),
          };
        })
        .sort((a, b) => a.email.localeCompare(b.email));
    },
    watchSecurity(orgId, uid, callback) {
      let stopped = false;
      const stops: (() => void)[] = [];
      let policy: ResolvedSecurity | undefined;
      let validAfter: Date | null | undefined;
      let last: string | undefined;
      const emit = () => {
        if (stopped || policy === undefined || validAfter === undefined) return;
        const key = JSON.stringify([policy, validAfter]);
        if (key === last) return;
        last = key;
        callback({ policy, validAfter });
      };
      source.get().then(
        ({ sdk, db }) => {
          if (stopped) return;
          stops.push(
            sdk.onSnapshot(
              sdk.doc(db, 'orgs', orgId),
              (snap) => {
                policy = toResolvedSecurity(snap.data()?.['security']);
                emit();
              },
              () => !stopped && callback(null),
            ),
            sdk.onSnapshot(
              sdk.doc(db, 'orgs', orgId, 'members', uid),
              (snap) => {
                validAfter = asDate(snap.data()?.['sessionsValidAfter']) ?? null;
                emit();
              },
              () => !stopped && callback(null),
            ),
          );
        },
        () => undefined,
      );
      return registry.add(
        () => {
          stopped = true;
          for (const stop of stops) stop();
        },
        { label: `orgs/${orgId}#security` },
      );
    },
  };
}
