import { Injectable, inject } from '@angular/core';

import { FirestoreClient, setFirestoreCacheMode } from './firestore/firestore-client';
import { ListenerRegistry } from './listener-registry';
import { OrgContext } from './org-context';

/**
 * The data layer's side of an org switch and a sign-out (FND-19). The web app calls these from
 * its org-switch and sign-out clean-ups.
 */
@Injectable({ providedIn: 'root' })
export class DataLifecycle {
  private readonly registry = inject(ListenerRegistry);
  private readonly context = inject(OrgContext);
  private readonly firestore = inject(FirestoreClient);

  /** Before switching org: every listener stops and every store resets. */
  orgSwitch(): void {
    this.registry.stopAll();
  }

  /**
   * On sign-out: stop listeners, reset stores, forget the session, then terminate Firestore and
   * clear its IndexedDB cache, so nothing cached survives for the next person on this browser.
   */
  async signOut(): Promise<void> {
    this.registry.stopAll();
    this.context.setSession(null);
    await this.firestore.shutdown({ clearCache: true });
    setFirestoreCacheMode('persistent');
  }

  /** Whether edits made offline are still waiting to reach the server ("You have unsynced changes"). */
  hasUnsyncedChanges(): Promise<boolean> {
    return this.firestore.hasPendingWrites();
  }

  /** Waits for offline edits to reach the server. */
  waitForSync(): Promise<void> {
    return this.firestore.waitForPendingWrites();
  }
}
