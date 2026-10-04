import { InjectionToken } from '@angular/core';
import type { FirebaseApp } from 'firebase/app';

import type { Role } from '@materia/domain';

/** The part of `users/{uid}` the app follows (FND-17): the claims version and the memberships. */
export interface UserTenancy {
  claimsVersion: number;
  activeOrgId: string | null;
  /** Active memberships with the org name, for the org switcher. */
  memberships: Record<string, { role: Role; name: string }>;
}

/** A row of the team list. */
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
 * Reads for tenancy (FND-17): the signed-in person's `users/{uid}` (re-read every 30 seconds) and the team.
 * FND-19 folds this into its repositories. The Firebase implementation loads Firestore lazily.
 */
export interface TenancyPort {
  /** Calls back with the user's tenancy now and on every change; returns the unsubscribe. */
  watchUser(uid: string, callback: (tenancy: UserTenancy | null) => void): () => void;
  members(orgId: string): Promise<TeamMember[]>;
  invites(orgId: string): Promise<PendingInvite[]>;
}

/** How to reach Firebase: the app (initialised by the web app) and whether to use the emulators. */
export interface FirebaseSetup {
  /** The initialised app (loaded lazily, so the SDK stays out of the initial bundle). */
  app: () => Promise<FirebaseApp>;
  useEmulators: boolean;
}

export const FIREBASE_SETUP = new InjectionToken<FirebaseSetup>('FIREBASE_SETUP');

export const TENANCY_PORT = new InjectionToken<TenancyPort>('TENANCY_PORT');

/** A port that never loads anything, for tests and pages without Firebase. */
export const NULL_TENANCY_PORT: TenancyPort = {
  watchUser: () => () => undefined,
  members: async () => [],
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

const STATUS_ORDER = { active: 0, suspended: 1, removed: 2 } as const;

/** Members as the team list shows them: removed members hidden, then by name, then email. */
export function sortMembers(members: TeamMember[]): TeamMember[] {
  return members
    .filter((m) => m.status !== 'removed')
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.displayName.localeCompare(b.displayName) ||
        (a.email ?? '').localeCompare(b.email ?? ''),
    );
}

/** How often `watchUser` re-reads `users/{uid}` (a claims change applies within a minute). */
export const USER_POLL_MS = 30_000;

/**
 * The Firestore implementation, on the Lite SDK (imported on first use, outside the initial bundle).
 * The full SDK's listeners would put its lazy chunk over the 150 kB budget, so `watchUser` re-reads
 * `users/{uid}` every 30 seconds and whenever the tab becomes visible again. FND-19 may swap in a
 * snapshot listener when the data layer brings the full SDK.
 */
export function firebaseTenancyPort(setup: FirebaseSetup, pollMs = USER_POLL_MS): TenancyPort {
  const load = async () => {
    const [sdk, app] = await Promise.all([import('firebase/firestore/lite'), setup.app()]);
    const firestore = sdk.getFirestore(app);
    if (setup.useEmulators) {
      // Connecting twice throws; the feature flag source may already have connected this instance.
      try {
        sdk.connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
      } catch {
        // Already connected.
      }
    }
    return { sdk, firestore };
  };
  // Loading starts on first use only.
  let started: ReturnType<typeof load> | undefined;
  const get = () => (started ??= load());

  return {
    watchUser(uid, callback) {
      let stopped = false;
      let last: string | undefined;
      const read = async () => {
        try {
          const { sdk, firestore } = await get();
          const snap = await sdk.getDoc(sdk.doc(firestore, 'users', uid));
          const tenancy = toUserTenancy(snap.data());
          const key = JSON.stringify(tenancy);
          if (!stopped && key !== last) {
            last = key;
            callback(tenancy);
          }
        } catch {
          // Offline or signed out mid-read: the next poll tries again.
        }
      };
      void read();
      const timer = setInterval(() => void read(), pollMs);
      const onVisible = () => {
        if (globalThis.document?.visibilityState !== 'hidden') void read();
      };
      globalThis.document?.addEventListener('visibilitychange', onVisible);
      return () => {
        stopped = true;
        clearInterval(timer);
        globalThis.document?.removeEventListener('visibilitychange', onVisible);
      };
    },
    async members(orgId) {
      const { sdk, firestore } = await get();
      const snap = await sdk.getDocs(sdk.collection(firestore, 'orgs', orgId, 'members'));
      return sortMembers(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            uid: d.id,
            displayName: String(data['displayName'] ?? d.id),
            email: typeof data['email'] === 'string' ? data['email'] : null,
            initials: String(data['initials'] ?? '?'),
            role: data['role'] as Role,
            status: data['status'] as TeamMember['status'],
            colour: String(data['colour'] ?? ''),
          };
        }),
      );
    },
    async invites(orgId) {
      const { sdk, firestore } = await get();
      const snap = await sdk.getDocs(
        sdk.query(sdk.collection(firestore, 'orgs', orgId, 'invites'), sdk.where('status', '==', 'pending')),
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
