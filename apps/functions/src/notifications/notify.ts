import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';

import {
  burstSummaryId,
  deliverAfter,
  Notification,
  NOTIFICATION_BURST_LIMIT,
  NOTIFICATION_BURST_WINDOW_MS,
  NOTIFICATION_KINDS,
  readNotificationPrefs,
  resolveChannels,
  validTimeZone,
  type NotificationChannel,
  type NotificationPayloadSchema,
  type NotificationPriority,
} from '@materia/domain';

import type { Log } from '../core/log';
import type { Clock, Ports } from '../ports';

/** The Cloud Tasks queue that sends email and push (`notifications-deliver`). */
export const DELIVER_QUEUE = 'notifications-deliver';

type Payload = z.input<typeof NotificationPayloadSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Fields `notify()` sets itself. */
type Managed =
  'recipientUid' | 'channels' | 'priority' | 'readAt' | 'deliveries' | 'deliverAfter' | 'summaryId' | 'collapsedCount';

/**
 * What to send: the kind and its payload ids, `title`, `body` (never privileged content: name the
 * thing and link to it) and an app `link`, plus who gets it.
 */
export type NotifyInput = DistributiveOmit<Payload, Managed> & {
  recipients: readonly string[];
  /** Default: the kind's (`NOTIFICATION_KINDS`). `critical` always emails. */
  priority?: NotificationPriority;
  /** The most it may go out on. Default: the kind's channels, plus any the recipient turned on. */
  channels?: readonly NotificationChannel[];
  /** A stable id: as is for one recipient, `{key}-{uid}` for several. Writing it again replaces it. */
  key?: string;
  /** `createdBy` (default `system`). */
  actor?: string;
};

export interface NotifyContext {
  db: Firestore;
  orgId: string;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
}

export interface DeliveryTask {
  orgId: string;
  notificationId: string;
  channel: 'email' | 'push';
  [key: string]: unknown;
}

export interface QueuedDelivery {
  task: DeliveryTask;
  /** The end of the recipient's quiet hours, when it waits. */
  scheduleTime?: Date;
}

export interface NotifyResult {
  /** The notifications written (one per recipient who gets it). */
  ids: string[];
  /** Recipients left out: no longer an active member, or every channel turned off. */
  skipped: { uid: string; reason: 'not_member' | 'no_channels' }[];
  /** Written as part of a burst (in-app only, counted on the burst summary). */
  collapsed: string[];
  deliveries: QueuedDelivery[];
  /**
   * Enqueues the email and push deliveries. `notify()` calls it itself; in a transaction call it
   * once the transaction has committed (until then the notifications don't exist).
   */
  dispatch(): Promise<void>;
}

const notificationsPath = (orgId: string) => `orgs/${orgId}/notifications`;

/** How many notifications the recipient got in the last minute (a count aggregation). */
async function recentCount(db: Firestore, orgId: string, uid: string, now: Date): Promise<number> {
  const snap = await db
    .collection(notificationsPath(orgId))
    .where('recipientUid', '==', uid)
    .where('createdAt', '>', new Date(now.getTime() - NOTIFICATION_BURST_WINDOW_MS))
    .count()
    .get();
  return snap.data().count;
}

interface Writer {
  set(ref: DocumentReference, data: Record<string, unknown>, options?: { merge: boolean }): unknown;
}

/**
 * Sends a notification to each recipient (FND-20). Per recipient:
 *
 * - someone who is no longer an active member of the org is left out;
 * - the channels follow their preferences (`resolveChannels`: critical always emails);
 * - after `NOTIFICATION_BURST_LIMIT` in a minute (critical aside), the rest are written in-app
 *   only, marked with the burst's summary, and the summary counts them;
 * - otherwise `orgs/{orgId}/notifications/{id}` is written (`readAt: null`) and each email and
 *   push delivery is enqueued on `notifications-deliver`, held until the end of the recipient's
 *   quiet hours when it isn't critical.
 *
 * Pass `tx` to write inside a transaction (all reads here are outside it, so it can come after the
 * transaction's own writes), then call `dispatch()` after it commits. Logs ids only.
 */
export async function notify(
  ctx: NotifyContext,
  input: NotifyInput,
  options: { tx?: Transaction } = {},
): Promise<NotifyResult> {
  const { recipients, priority: givenPriority, channels: cap, key, actor = 'system', ...payload } = input;
  const { db, orgId } = ctx;
  const kind = payload.kind;
  const priority = givenPriority ?? NOTIFICATION_KINDS[kind].priority;
  const uids = [...new Set(recipients.filter((uid) => typeof uid === 'string' && uid.length > 0))];
  const ids: string[] = [];
  const skipped: NotifyResult['skipped'] = [];
  const collapsed: string[] = [];
  const deliveries: QueuedDelivery[] = [];
  const dispatch = () => dispatchDeliveries(ctx, deliveries);

  if (uids.length) {
    const now = ctx.clock.now();
    const meta = {
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      schemaVersion: Notification.version,
    };
    const [org, ...people] = await db.getAll(
      db.doc(`orgs/${orgId}`),
      ...uids.flatMap((uid) => [db.doc(`orgs/${orgId}/members/${uid}`), db.doc(`users/${uid}`)]),
    );
    const batch = options.tx ? undefined : db.batch();
    const writer: Writer = (options.tx ?? batch) as unknown as Writer;

    for (const [i, uid] of uids.entries()) {
      const member = people[i * 2];
      const user = people[i * 2 + 1];
      if (member?.get('status') !== 'active') {
        skipped.push({ uid, reason: 'not_member' });
        continue;
      }
      const prefs = readNotificationPrefs(user?.get('prefs.notifications'));
      const channels = resolveChannels({ kind, priority, channels: cap, prefs });
      if (!channels.length) {
        skipped.push({ uid, reason: 'no_channels' });
        continue;
      }
      const id = key ? (uids.length === 1 ? key : `${key}-${uid}`) : db.collection(notificationsPath(orgId)).doc().id;
      const ref = db.doc(`${notificationsPath(orgId)}/${id}`);
      const base = { ...payload, recipientUid: uid, priority, readAt: null, ...meta };

      if (priority !== 'critical' && (await recentCount(db, orgId, uid, now)) >= NOTIFICATION_BURST_LIMIT) {
        const summaryId = burstSummaryId(uid, now);
        writer.set(ref, Notification.schema.parse({ ...base, channels: ['inapp'], summaryId }));
        const summary = Notification.schema.parse({
          kind: 'system',
          recipientUid: uid,
          title: 'Lots of notifications at once',
          body: 'More arrived in a minute than we send one by one. They are all in your inbox.',
          link: '/inbox',
          channels: ['inapp'],
          priority: 'normal',
          readAt: null,
          collapsedCount: 1,
          ...meta,
          createdBy: 'system',
          updatedBy: 'system',
        });
        writer.set(
          db.doc(`${notificationsPath(orgId)}/${summaryId}`),
          { ...summary, collapsedCount: FieldValue.increment(1) },
          { merge: true },
        );
        collapsed.push(id);
        continue;
      }

      const external = channels.filter((channel): channel is 'email' | 'push' => channel !== 'inapp');
      const timeZone = validTimeZone(user?.get('prefs.timezone'), org?.get('timezone'));
      const after = external.length ? deliverAfter(priority, now, timeZone, prefs) : null;
      writer.set(ref, Notification.schema.parse({ ...base, channels, ...(after ? { deliverAfter: after } : {}) }));
      ids.push(id);
      for (const channel of external) {
        deliveries.push({ task: { orgId, notificationId: id, channel }, ...(after ? { scheduleTime: after } : {}) });
      }
    }
    if (batch) await batch.commit();
    ctx.log.info('notified', {
      kind,
      priority,
      notified: ids.length,
      skipped: skipped.length,
      collapsed: collapsed.length,
      deliveries: deliveries.length,
    });
    if (!options.tx) await dispatch();
  }
  return { ids, skipped, collapsed, deliveries, dispatch: options.tx ? dispatch : async () => undefined };
}

/**
 * Enqueues deliveries, deduplicated per notification and channel. A failure to enqueue is logged
 * and recorded on the notification (it stays in-app) rather than thrown.
 */
export async function dispatchDeliveries(ctx: NotifyContext, deliveries: readonly QueuedDelivery[]): Promise<void> {
  for (const { task, scheduleTime } of deliveries) {
    try {
      await ctx.ports.tasks.enqueue(DELIVER_QUEUE, task, {
        dedupeKey: `notify/${task.orgId}/${task.notificationId}/${task.channel}`,
        ...(scheduleTime ? { scheduleTime } : {}),
      });
    } catch (error) {
      ctx.log.error('notification delivery not queued', {
        notificationId: task.notificationId,
        channel: task.channel,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      await ctx.db
        .doc(`${notificationsPath(task.orgId)}/${task.notificationId}`)
        .update({
          deliveries: FieldValue.arrayUnion({
            channel: task.channel,
            status: 'failed',
            reason: 'not_queued',
            at: ctx.clock.now(),
            attempt: 0,
          }),
        })
        .catch(() => undefined);
    }
  }
}
