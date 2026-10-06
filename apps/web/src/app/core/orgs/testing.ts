import type { Provider } from '@angular/core';

import {
  TENANCY_PORT,
  type PendingInvite,
  type SessionSecurity,
  type TenancyPort,
  type UserTenancy,
} from '@materia/data-access';

/** An in-memory TenancyPort: set `invites_`, and `emit` a new `users/{uid}`. */
export class FakeTenancyPort implements TenancyPort {
  invites_: PendingInvite[] = [];
  private listener: ((tenancy: UserTenancy | null) => void) | null = null;
  watching: string | null = null;

  watchUser(uid: string, callback: (tenancy: UserTenancy | null) => void): () => void {
    this.watching = uid;
    this.listener = callback;
    return () => {
      this.watching = null;
      this.listener = null;
    };
  }

  emit(tenancy: UserTenancy | null): void {
    this.listener?.(tenancy);
  }

  async invites(): Promise<PendingInvite[]> {
    return this.invites_;
  }

  private securityListener: ((security: SessionSecurity | null) => void) | null = null;
  /** The org whose security is being followed (SEC-04). */
  watchingSecurity: string | null = null;
  /** What `watchSecurity` reports at once: null (no policy) unless a test sets one; undefined waits for `emitSecurity`. */
  security_: SessionSecurity | null | undefined = null;

  watchSecurity(orgId: string, _uid: string, callback: (security: SessionSecurity | null) => void): () => void {
    this.watchingSecurity = orgId;
    this.securityListener = callback;
    if (this.security_ !== undefined) callback(this.security_);
    return () => {
      this.watchingSecurity = null;
      this.securityListener = null;
    };
  }

  emitSecurity(security: SessionSecurity | null): void {
    this.securityListener?.(security);
  }
}

export function provideFakeTenancy(): { port: FakeTenancyPort; providers: Provider[] } {
  const port = new FakeTenancyPort();
  return { port, providers: [{ provide: TENANCY_PORT, useValue: port }] };
}
