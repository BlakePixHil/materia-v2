import { computed, effect, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';

import { DataLifecycle, NULL_TENANCY_PORT, OrgContext, TENANCY_PORT, type UserTenancy } from '@materia/data-access';
import { can, type CreateOrgInput, type Role } from '@materia/domain';

import { AuthState } from '../auth/auth-state';
import { CALLABLES } from '../data/callables';

/** Clean-up before switching org: the data layer stops every listener and resets stores (FND-19). */
export type OrgSwitchCleanup = () => void | Promise<void>;
export const ORG_SWITCH_CLEANUP = new InjectionToken<OrgSwitchCleanup[]>('ORG_SWITCH_CLEANUP', {
  factory: () => {
    const data = inject(DataLifecycle);
    return [() => data.orgSwitch()];
  },
});

/** Loads a URL as a fresh page (tests replace it). */
export const PAGE_LOAD = new InjectionToken<(url: string) => void>('PAGE_LOAD', {
  factory: () => (url) => globalThis.location.assign(url),
});

/** Whether the browser is online (tests replace it). */
export const IS_ONLINE = new InjectionToken<() => boolean>('IS_ONLINE', {
  factory: () => () => globalThis.navigator?.onLine ?? true,
});

/** An org switch needs the network: the token and the new org's data come from the server. */
export class OfflineError extends Error {
  constructor() {
    super('You’re offline. Reconnect to switch practices.');
    this.name = 'OfflineError';
  }
}

/** An org the person can switch to. */
export interface OrgChoice {
  orgId: string;
  name: string;
  role: Role;
  active: boolean;
}

/** Where an invite link waits while the person signs up or confirms their email (this tab only). */
const PENDING_INVITE_KEY = 'materia.pendingInvite';

export function rememberInvite(path: string): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_INVITE_KEY, path);
  } catch {
    // Storage may be unavailable.
  }
}

export function pendingInvite(): string | null {
  try {
    const path = globalThis.sessionStorage?.getItem(PENDING_INVITE_KEY) ?? null;
    return path?.startsWith('/invite/') ? path : null;
  } catch {
    return null;
  }
}

export function forgetInvite(): void {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

/** Whether `users/{uid}` says the token's claims are out of date. */
export function claimsLookStale(tenancy: UserTenancy, claims: { orgId?: string; role?: Role }): boolean {
  if ((tenancy.activeOrgId ?? undefined) !== claims.orgId) return true;
  return !!claims.orgId && tenancy.memberships[claims.orgId]?.role !== claims.role;
}

/**
 * Organisations for the signed-in person (FND-17): follows `users/{uid}` and refreshes the ID
 * token when `claimsVersion` changes (a role change or removal takes effect without signing out),
 * keeps the data-access OrgContext on the active org, and wraps the orgs-* callables.
 */
@Injectable({ providedIn: 'root' })
export class OrgService {
  private readonly auth = inject(AuthState);
  // The app provides the Firebase port (app.config.ts); unit tests without one load nothing.
  private readonly port = inject(TENANCY_PORT, { optional: true }) ?? NULL_TENANCY_PORT;
  private readonly context = inject(OrgContext);
  private readonly cleanups = inject(ORG_SWITCH_CLEANUP);
  private readonly load = inject(PAGE_LOAD);
  private readonly online = inject(IS_ONLINE);
  private readonly callables = inject(CALLABLES);

  private readonly uid = computed(() => this.auth.session()?.uid ?? null);
  /** The latest `users/{uid}` tenancy fields, or null before they load. */
  readonly tenancy = signal<UserTenancy | null>(null);
  readonly role = computed(() => this.auth.claims().role ?? null);
  readonly canManageMembers = computed(() => {
    const role = this.role();
    return !!role && can(role, 'members.manage');
  });
  /** Orgs to switch between, by name; the active org alone until `users/{uid}` loads. */
  readonly orgs = computed<OrgChoice[]>(() => {
    const claims = this.auth.claims();
    const memberships = this.tenancy()?.memberships ?? {};
    const list = Object.entries(memberships).map(([orgId, m]) => ({
      orgId,
      name: m.name || 'Untitled practice',
      role: m.role,
      active: orgId === claims.orgId,
    }));
    if (claims.orgId && !list.some((o) => o.orgId === claims.orgId)) {
      list.push({
        orgId: claims.orgId,
        name: claims.orgName ?? 'Materia',
        role: claims.role ?? 'readonly',
        active: true,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  });

  constructor() {
    effect(() => {
      const session = this.auth.session();
      this.context.setSession(
        session ? { uid: session.uid, orgId: session.claims.orgId ?? null, role: session.claims.role ?? null } : null,
      );
    });
    effect((onCleanup) => {
      // OrgContext's uid, not the auth session's: sign-out clears it before Identity Platform signs
      // out, so nothing reopens Firestore while its cache is being deleted.
      const uid = this.context.uid();
      // An org switch stops every listener (OrgContext); follow users/{uid} again for the new session.
      this.context.generation();
      this.tenancy.set(null);
      if (!uid) return;
      let seen: number | undefined;
      const stop = this.port.watchUser(uid, (tenancy) => {
        this.tenancy.set(tenancy);
        if (!tenancy) return;
        const first = seen === undefined;
        const changed = !first && tenancy.claimsVersion !== seen;
        seen = tenancy.claimsVersion;
        if (changed || (first && untracked(() => claimsLookStale(tenancy, this.auth.claims())))) {
          void this.auth.refreshClaims().catch(() => undefined);
        }
      });
      onCleanup(stop);
    });
  }

  /** The orgs-* callables are idempotent: a retry re-uses the request id. */
  private call<T>(name: string, data: Record<string, unknown>): Promise<T> {
    return this.callables.call<Record<string, unknown>, T>(name, data, { idempotent: true });
  }

  /** Onboarding: creates the org, then refreshes the token so its claims apply. */
  async createOrg(input: Omit<CreateOrgInput, 'requestId'>): Promise<{ orgId: string }> {
    const result = await this.call<{ orgId: string }>('orgs-createOrg', input);
    await this.auth.refreshClaims();
    return result;
  }

  async acceptInvite(inviteId: string, token: string): Promise<{ orgId: string; orgName: string }> {
    const result = await this.call<{ orgId: string; orgName: string }>('orgs-acceptInvite', { inviteId, token });
    forgetInvite();
    await this.auth.refreshClaims();
    return result;
  }

  /**
   * Switches the active org, then loads Today as a fresh page: listeners, stores and caches from
   * the previous org are gone, so nothing from it stays on screen. Needs the network.
   */
  async switchOrg(orgId: string): Promise<void> {
    if (!this.online()) throw new OfflineError();
    await this.call('orgs-switchActiveOrg', { orgId });
    for (const cleanup of this.cleanups) {
      try {
        await cleanup();
      } catch {
        // One failing clean-up must not block the switch; the page load clears memory anyway.
      }
    }
    await this.auth.refreshClaims();
    this.load('/today');
  }

  inviteMember(email: string, role: Role): Promise<{ inviteId: string; emailed: boolean }> {
    return this.call('orgs-inviteMember', { email, role });
  }

  revokeInvite(inviteId: string): Promise<unknown> {
    return this.call('orgs-revokeInvite', { inviteId });
  }

  resendInvite(inviteId: string): Promise<{ inviteId: string; emailed: boolean }> {
    return this.call('orgs-resendInvite', { inviteId });
  }

  changeRole(uid: string, role: Role): Promise<unknown> {
    return this.call('orgs-changeRole', { uid, role });
  }

  /** Pauses a member's access, or with `suspended: false` reinstates them. */
  suspendMember(uid: string, suspended: boolean): Promise<unknown> {
    return this.call('orgs-suspendMember', { uid, suspended });
  }

  /** Makes another active member the owner; the caller becomes an admin, so their claims refresh at once. */
  async transferOwnership(toUid: string): Promise<void> {
    await this.call('orgs-transferOwnership', { toUid });
    await this.auth.refreshClaims().catch(() => undefined);
  }

  invites() {
    const orgId = this.auth.activeOrgId();
    return orgId ? this.port.invites(orgId) : Promise.resolve([]);
  }
}
