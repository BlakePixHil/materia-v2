import type { Provider } from '@angular/core';

import { TENANCY_PORT, type PendingInvite, type TenancyPort, type UserTenancy } from '@materia/data-access';

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
}

export function provideFakeTenancy(): { port: FakeTenancyPort; providers: Provider[] } {
  const port = new FakeTenancyPort();
  return { port, providers: [{ provide: TENANCY_PORT, useValue: port }] };
}
