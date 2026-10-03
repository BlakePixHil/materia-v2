import { Injectable, computed, signal } from '@angular/core';

/**
 * Holds the active organisation for the session. Every repository scopes its queries to it
 * (ADR-005). FND-17 sets it from the auth claim; FND-19 tears down listeners when it changes.
 */
@Injectable({ providedIn: 'root' })
export class OrgContext {
  private readonly activeOrgId = signal<string | null>(null);

  readonly orgId = this.activeOrgId.asReadonly();
  readonly hasOrg = computed(() => this.activeOrgId() !== null);

  setOrg(orgId: string | null): void {
    this.activeOrgId.set(orgId);
  }
}
