import type { Firestore } from 'firebase-admin/firestore';

import { SAFE_CUSTODY_RELEASE_ROLES } from '@materia/domain';

import type { Log } from '../core/log';
import { notify } from '../notifications/notify';
import type { Clock, Ports } from '../ports';

interface NotifyDeps {
  db: Firestore;
  orgId: string;
  uid: string;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

/**
 * A destruction waits for a second lawyer: every other active member who may confirm it (lawyers,
 * admins and owners) is told, in-app and by email. Keyed by the packet, so asking again replaces it.
 */
export async function notifyApprovers(deps: NotifyDeps, packetId: string, packetNo: string): Promise<string[]> {
  const members = await deps.db
    .collection(`orgs/${deps.orgId}/members`)
    .where('status', '==', 'active')
    .where('role', 'in', [...SAFE_CUSTODY_RELEASE_ROLES])
    .get();
  const recipients = members.docs.map((doc) => doc.id).filter((memberUid) => memberUid !== deps.uid);
  if (!recipients.length) {
    deps.log.warn('no second lawyer to confirm a destruction', { packetId });
    return [];
  }
  const result = await notify(deps, {
    kind: 'safe_custody',
    packetId,
    recipients,
    title: `Confirm the destruction of ${packetNo}`,
    body: 'A lawyer asked to destroy an original held in safe custody. A second lawyer must confirm it.',
    link: `/safe-custody/${packetId}`,
    key: `sc-destroy-${packetId}`,
    actor: deps.uid,
  });
  return result.ids;
}
