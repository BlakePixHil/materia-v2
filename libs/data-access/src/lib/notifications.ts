import { Notification } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';
import type { WithId } from './resources';

/*
 * The signed-in person's in-app notifications (FND-20): the unread count on the Inbox nav item, a
 * toast for urgent ones, and the inbox itself (CORE-22).
 */

export type NotificationItem = WithId<Notification>;

/** The badge counts up to this many unread; more shows as "99+". */
export const UNREAD_BADGE_LIMIT = 99;

/** The inbox listens to this many of the newest; older ones load a page at a time (CORE-22). */
export const INBOX_PAGE_SIZE = 100;

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

/**
 * The inbox (CORE-22): every in-app notification of mine, newest first, but a burst's members
 * (their summary stands for them). Archived ones (`hiddenAt`) come back too and are left out of
 * the list by the page: older documents don't store the field, so the query can't filter on it.
 * Indexed: recipientUid, channels (contains), summaryId, createdAt desc.
 */
export const myInboxQuery = (uid: string): QuerySpec<Notification> => ({
  where: [
    ['recipientUid', '==', uid],
    ['channels', 'array-contains', 'inapp'],
    ['summaryId', '==', null],
  ],
  orderBy: [['createdAt', 'desc']],
  pageSize: INBOX_PAGE_SIZE,
});

/** The members of one burst of mine, newest first. Indexed: recipientUid, summaryId, createdAt desc. */
export const burstMembersQuery = (uid: string, summaryId: string): QuerySpec<Notification> => ({
  where: [
    ['recipientUid', '==', uid],
    ['summaryId', '==', summaryId],
  ],
  orderBy: [['createdAt', 'desc']],
  pageSize: INBOX_PAGE_SIZE,
});

/** `orgs/{orgId}/notifications`: read and marked read by their recipient only. Call in an injection context. */
export function notificationsRepo(): Repository<Notification> {
  return repo((orgId) => `orgs/${orgId}/notifications`, Notification);
}

/** Marks notifications read (`readAt` is the server's time, as the rules require) or unread. */
export function markNotificationsRead(
  notifications: Repository<Notification>,
  ids: readonly string[],
  read: boolean,
): Promise<void> {
  return Promise.all(
    ids.map((id) =>
      read ? notifications.update(id, {}, { stamp: ['readAt'] }) : notifications.update(id, { readAt: null }),
    ),
  ).then(() => undefined);
}

/**
 * Archives notifications (`hiddenAt`, the server's time): they leave the inbox and the badge (an
 * archived one is marked read too) and are deleted with the rest after 90 days. `false` restores them.
 */
export function archiveNotifications(
  notifications: Repository<Notification>,
  ids: readonly string[],
  hidden: boolean,
): Promise<void> {
  return Promise.all(
    ids.map((id) =>
      hidden
        ? notifications.update(id, {}, { stamp: ['hiddenAt', 'readAt'] })
        : notifications.update(id, { hiddenAt: null }),
    ),
  ).then(() => undefined);
}
