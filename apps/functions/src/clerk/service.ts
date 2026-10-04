import type { Firestore } from 'firebase-admin/firestore';

import { isEnabled } from '../core/flags';
import type { Clock, Ports } from '../ports';
import { firestoreClerkStore } from './firestore-store';
import { createClerkGateway, type ClerkGateway } from './gateway';

/** The gateway as callables use it: the container's model port, Firestore, server flags. */
export function clerkGateway(deps: { db: Firestore; ports: Ports; clock: Clock }): ClerkGateway {
  return createClerkGateway({
    model: deps.ports.clerkModel,
    store: firestoreClerkStore(deps.db),
    flag: (orgId, key) => isEnabled({ orgId, db: deps.db, clock: deps.clock }, key),
  });
}
