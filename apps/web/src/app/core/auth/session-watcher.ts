import { effect, inject, Injectable, Injector, untracked } from '@angular/core';
import { Router } from '@angular/router';

import type { DomainError } from '@materia/domain';
import { ToastService } from '@materia/ui';

import { AuthState } from './auth-state';
import { SessionPolicy } from './session-policy';
import { PAGE_LOAD } from '../orgs/org-service';

/**
 * Follows the session across tabs (FND-19). Identity Platform shares the sign-in between tabs, so
 * when another tab signs out this one sees the session end: it runs the same clean-up as a local
 * sign-out (listeners, stores, the Firestore cache) and goes to sign-in. If someone else signs in
 * from another tab, the page reloads so nothing of the previous person stays on screen.
 */
@Injectable({ providedIn: 'root' })
export class SessionWatcher {
  private readonly auth = inject(AuthState);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly load = inject(PAGE_LOAD);
  private previous: string | null | undefined;

  constructor() {
    effect(() => {
      const session = this.auth.session();
      if (session === undefined) return;
      const uid = session?.uid ?? null;
      const previous = this.previous;
      this.previous = uid;
      if (!previous || previous === uid || untracked(this.auth.signingOut)) return;
      if (uid) {
        this.load('/today');
        return;
      }
      void this.signedOutElsewhere();
    });
  }

  private async signedOutElsewhere(): Promise<void> {
    await this.auth.cleanUp();
    await this.router.navigateByUrl('/auth/sign-in');
    this.toasts.show({ title: 'You signed out in another tab', tone: 'neutral' });
  }
}

/** How long a refused read waits before routing to "no access", so a sign-out that caused it can land first. */
export const ACCESS_REVOKED_SETTLE_MS = 300;

/**
 * Where a refused live read goes (`ACCESS_REVOKED`, FND-19): the no-access page, unless the session
 * ended meanwhile (a sign-out in another tab also makes reads fail), in which case the session
 * watcher is already taking the person to sign-in.
 */
export function accessRevokedHandler(): (error: DomainError) => void {
  const auth = inject(AuthState);
  const router = inject(Router);
  // Looked up when a read is refused: SessionPolicy reads through the data layer, which uses this handler.
  const injector = inject(Injector);
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      // Signing out everywhere else refuses this tab's reads too, until it confirms it's them (SEC-04).
      if (injector.get(SessionPolicy).checksPaused()) return;
      if (auth.status() === 'ready' && !auth.signingOut()) void router.navigateByUrl('/no-access');
    }, ACCESS_REVOKED_SETTLE_MS);
  };
}
