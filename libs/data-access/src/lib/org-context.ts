import { computed, Injectable, inject, signal, untracked } from '@angular/core';

import { DomainError, type Role } from '@materia/domain';

import { ListenerRegistry } from './listener-registry';

/** Who is signed in and which org they act in, from the ID token's claims (`AuthState` in the app). */
export interface DataSession {
  uid: string;
  orgId: string | null;
  role: Role | null;
}

/**
 * The active session for the data layer (ADR-005). The app keeps it in step with `AuthState`;
 * every repository builds its paths from `orgId()`, so feature code never passes an org id.
 *
 * Changing the person or the org stops every listener in the `ListenerRegistry` before the new
 * values are visible, so nothing from the previous org can stream in afterwards (FND-19).
 */
@Injectable({ providedIn: 'root' })
export class OrgContext {
  private readonly registry = inject(ListenerRegistry);
  private readonly state = signal<DataSession | null>(null);
  private readonly epoch = signal(0);

  readonly session = this.state.asReadonly();
  readonly uid = computed(() => this.state()?.uid ?? null);
  readonly orgId = computed(() => this.state()?.orgId ?? null);
  readonly role = computed(() => this.state()?.role ?? null);
  readonly hasOrg = computed(() => this.orgId() !== null);
  /** Goes up on every sign-in, sign-out and org switch; long-lived listeners restart when it changes. */
  readonly generation = this.epoch.asReadonly();

  setSession(next: DataSession | null): void {
    const previous = untracked(this.state);
    const changed = previous?.uid !== next?.uid || previous?.orgId !== next?.orgId;
    if (changed) {
      if (previous) this.registry.stopAll();
      this.epoch.update((n) => n + 1);
    }
    if (changed || previous?.role !== next?.role) this.state.set(next);
  }

  /** The active org id, or `ORG_CLAIM_MISSING` when there is none (signed out, onboarding). */
  requireOrgId(): string {
    const orgId = untracked(this.orgId);
    if (!orgId) throw new DomainError('ORG_CLAIM_MISSING', 'No active organisation');
    return orgId;
  }

  /** The signed-in uid, or `UNAUTHENTICATED`. */
  requireUid(): string {
    const uid = untracked(this.uid);
    if (!uid) throw new DomainError('UNAUTHENTICATED', 'Not signed in');
    return uid;
  }
}
