import type { Firestore } from 'firebase-admin/firestore';

import { isEnabled } from '../core/flags';
import type { Clock, Ports } from '../ports';
import { firestoreClerkStore } from './firestore-store';
import { createClerkGateway, type ClerkGateway } from './gateway';
import { firestoreKeyring, type ClerkKeyring } from './keyring';

let keyring: { db: Firestore; kms: Ports['clerkKms']; value: ClerkKeyring } | undefined;

/** One keyring per instance, so its short-lived plaintext cache is shared across calls. */
function keyringFor(db: Firestore, kms: Ports['clerkKms']): ClerkKeyring {
  if (!keyring || keyring.db !== db || keyring.kms !== kms) keyring = { db, kms, value: firestoreKeyring(db, kms) };
  return keyring.value;
}

/** The gateway as callables use it: the container's model and KMS ports, Firestore, server flags. */
export function clerkGateway(deps: { db: Firestore; ports: Ports; clock: Clock }): ClerkGateway {
  return createClerkGateway({
    model: deps.ports.clerkModel,
    store: firestoreClerkStore(deps.db),
    keyring: keyringFor(deps.db, deps.ports.clerkKms),
    flag: (orgId, key) => isEnabled({ orgId, db: deps.db, clock: deps.clock }, key),
  });
}
