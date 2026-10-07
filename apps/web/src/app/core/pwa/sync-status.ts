import { computed, inject, Injectable } from '@angular/core';

import { Connectivity, FirestoreClient } from '@materia/data-access';

import { heldFor } from './held-for';

/** The Banner spec: offline shows after 3 seconds without a connection. */
export const OFFLINE_AFTER_MS = 3000;
/** Online but every live read still on cached data this long: Materia can't be reached. */
export const UNREACHABLE_AFTER_MS = 10_000;
/** Online, a change still unsynced after this long is worth showing (a slow connection). */
export const PENDING_AFTER_MS = 2000;

/**
 * The connection as the offline indicators see it (MOB-01): the browser's `navigator.onLine`, and
 * Firestore's snapshot metadata for the times the browser thinks it's online but the server can't
 * be reached.
 */
@Injectable({ providedIn: 'root' })
export class SyncStatus {
  private readonly connectivity = inject(Connectivity);
  private readonly firestore = inject(FirestoreClient);

  readonly online = this.connectivity.online;
  /** Documents with changes saved on this device that haven't reached the server yet. */
  readonly pending = this.firestore.pendingWrites;

  private readonly offlineHeld = heldFor(() => !this.online(), OFFLINE_AFTER_MS);
  private readonly unreachableHeld = heldFor(() => this.online() && this.firestore.cacheOnly(), UNREACHABLE_AFTER_MS);
  private readonly pendingHeld = heldFor(() => this.pending() > 0, PENDING_AFTER_MS);

  /** Offline for 3 seconds, or online with no live read reaching the server for 10. */
  readonly offline = computed(() => this.offlineHeld() || this.unreachableHeld());
  /** Show "Pending sync": changes waiting while offline, or for more than a moment online. */
  readonly showPending = computed(() => this.pending() > 0 && (!this.online() || this.pendingHeld()));
}
