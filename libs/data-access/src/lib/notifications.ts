import { Notification } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { WithId } from './resources';

/*
 * The signed-in person's in-app notifications (FND-20). The inbox itself is CORE-22; the shell
 * shows the unread count on the Inbox nav item and a toast for urgent ones.
 */

export type NotificationItem = WithId<Notification>;

/** The badge counts up to this many unread; more shows as "99+". */
export const UNREAD_BADGE_LIMIT = 99;

/**
 * My unread in-app notifications, newest first, leaving out the members of a burst (their summary
 * stands for them). Indexed: recipientUid, channels (contains), readAt, summaryId, createdAt desc.
 */
export const myUnreadNotificationsQuery = (uid: string): QuerySpec<Notification> => ({
  where: [
    ['recipientUid', '==', uid],
    ['channels', 'array-contains', 'inapp'],
    ['readAt', '==', null],
    ['summaryId', '==', null],
  ],
  orderBy: [['createdAt', 'desc']],
  pageSize: UNREAD_BADGE_LIMIT,
});

/** `orgs/{orgId}/notifications`: read and marked read by their recipient only. Call in an injection context. */
export function notificationsRepo(): Repository<Notification> {
  return repo((orgId) => `orgs/${orgId}/notifications`, Notification);
}
