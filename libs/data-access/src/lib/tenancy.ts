import { InjectionToken } from '@angular/core';

import type { Role } from '@materia/domain';

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
  };
}
