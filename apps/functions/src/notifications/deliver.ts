import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { DocIdSchema, NOTIFICATION_KINDS, type NotificationDelivery, type NotificationKind } from '@materia/domain';

import { DELIVER_QUEUE } from './notify';
import type { Log } from '../core/log';
import { POSTMARK_TOKEN } from '../core/secrets';
import { defineQueue } from '../core/tasks';
import { appUrl } from '../orgs/shared';
import { MailError, type Ports } from '../ports';

export const DeliveryTaskSchema = z.object({
  orgId: DocIdSchema,
  notificationId: DocIdSchema,
  channel: z.enum(['email', 'push']),
});
export type DeliveryTaskInput = z.infer<typeof DeliveryTaskSchema>;

/** Attempts per delivery; Cloud Tasks backs off from 30 s, doubling, to at most an hour between them. */
export const DELIVERY_MAX_ATTEMPTS = 6;

/** Thrown to make Cloud Tasks try again later (after the failure is recorded). */
export class RetryDelivery extends Error {
  constructor() {
    super('delivery will be retried');
    this.name = 'RetryDelivery';
  }
}

export interface DeliverDeps {
  db: Firestore;
  ports: Pick<Ports, 'mail' | 'push' | 'clock'>;
  log: Log;
  /** Cloud Tasks' retry count (0 on the first attempt). */
  attempt: number;
  maxAttempts?: number;
}

export interface DeliveryOutcome {
  status: NotificationDelivery['status'] | 'missing' | 'done' | 'retry';
  reason?: string;
}

type Entry = Omit<NotificationDelivery, 'at' | 'attempt'>;

/** "You get this email for mentions." */
const kindLabel = (kind: unknown) => {
  const label = NOTIFICATION_KINDS[kind as NotificationKind]?.label ?? 'account and system messages';
  return label.charAt(0).toLowerCase() + label.slice(1);
};

/**
 * Delivers one notification on one channel (`notifications-deliver`, FND-20), and records each
 * outcome in the notification's `deliveries`:
 *
 * - a recipient who has left the org since is dropped (`not_member`); one who has read it in-app
 *   meanwhile isn't emailed or pushed (`read`), unless it is critical;
 * - email goes through the MailPort to the account's address (`no_address`, `undeliverable` after a
 *   hard bounce or complaint, `not_configured` until Postmark has a token);
 * - push goes to each of the person's devices; a token FCM reports gone deletes the device;
 * - a transient failure is recorded and retried with backoff, up to `DELIVERY_MAX_ATTEMPTS`.
 *
 * Running it again is safe: a channel already delivered, or a device already pushed to, is skipped.
 */
export async function deliverNotification(task: DeliveryTaskInput, deps: DeliverDeps): Promise<DeliveryOutcome> {
  const { db, ports, log, attempt } = deps;
  const maxAttempts = deps.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
  const ref = db.doc(`orgs/${task.orgId}/notifications/${task.notificationId}`);
  const snap = await ref.get();
  const data = snap.data();
  const ids = { notificationId: task.notificationId, channel: task.channel };
  if (!data) {
    log.warn('notification gone', ids);
    return { status: 'missing' };
  }
  const previous = ((data['deliveries'] as NotificationDelivery[] | undefined) ?? []).filter(
    (entry) => entry.channel === task.channel,
  );
  if (previous.some((entry) => !entry.deviceId && entry.status !== 'failed')) return { status: 'done' };
  if (previous.some((entry) => entry.status === 'failed' && entry.reason !== 'transient' && !entry.deviceId)) {
    return { status: 'done' };
  }

  const record = async (entries: Entry[]) => {
    if (!entries.length) return;
    const at = ports.clock.now();
    await ref.update({
      deliveries: FieldValue.arrayUnion(...entries.map((entry) => ({ ...entry, at, attempt }))),
      updatedAt: at,
      updatedBy: 'system',
    });
  };
  const finish = async (entry: Entry): Promise<DeliveryOutcome> => {
    await record([entry]);
    log.info('notification delivery', { ...ids, status: entry.status, reason: entry.reason ?? null, attempt });
    return { status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}) };
  };
  const lastAttempt = attempt + 1 >= maxAttempts;

  const uid = String(data['recipientUid']);
  const member = await db.doc(`orgs/${task.orgId}/members/${uid}`).get();
  if (member.get('status') !== 'active')
    return finish({ channel: task.channel, status: 'dropped', reason: 'not_member' });
  if (data['readAt'] && data['priority'] !== 'critical') {
    return finish({ channel: task.channel, status: 'skipped', reason: 'read' });
  }
  const user = await db.doc(`users/${uid}`).get();
  const title = String(data['title']);
  const body = typeof data['body'] === 'string' ? data['body'] : '';
  const link = typeof data['link'] === 'string' ? data['link'] : '/';

  if (task.channel === 'email') {
    const email = user.get('email') ?? member.get('email');
    if (typeof email !== 'string' || !email.includes('@')) {
      return finish({ channel: 'email', status: 'skipped', reason: 'no_address' });
    }
    if (user.get('emailDeliverability.status') === 'undeliverable') {
      return finish({ channel: 'email', status: 'skipped', reason: 'undeliverable' });
    }
    try {
      const sent = await ports.mail.send({
        to: email,
        template: 'notification',
        model: {
          title,
          body,
          link: `${appUrl()}${link}`,
          settingsLink: `${appUrl()}/settings`,
          kindLabel: kindLabel(data['kind']),
          critical: data['priority'] === 'critical',
        },
        idempotencyKey: `notification-${task.orgId}-${task.notificationId}`,
      });
      return finish({ channel: 'email', status: 'sent', providerId: sent.id });
    } catch (error) {
      const failure = error instanceof MailError ? error.failure : 'transient';
      if (failure === 'not_configured')
        return finish({ channel: 'email', status: 'skipped', reason: 'not_configured' });
      if (failure !== 'transient') return finish({ channel: 'email', status: 'failed', reason: failure });
      await finish({ channel: 'email', status: 'failed', reason: 'transient' });
      if (lastAttempt) return { status: 'failed', reason: 'transient' };
      throw new RetryDelivery();
    }
  }

  // Push: every device the person has registered.
  const devices = await db.collection(`users/${uid}/devices`).get();
  if (devices.empty) return finish({ channel: 'push', status: 'skipped', reason: 'no_devices' });
  const pushed = new Set(previous.filter((entry) => entry.status === 'sent').map((entry) => entry.deviceId));
  const entries: Entry[] = [];
  let retry = false;
  for (const device of devices.docs) {
    if (pushed.has(device.id)) continue;
    const token = device.get('token');
    const result =
      typeof token === 'string' && token
        ? await ports.push.send(token, { title, body, link })
        : ({ ok: false, reason: 'invalid_token' } as const);
    if (result.ok) {
      entries.push({ channel: 'push', status: 'sent', deviceId: device.id, providerId: result.id });
    } else {
      if (result.reason === 'invalid_token') await device.ref.delete();
      if (result.reason === 'transient') retry = true;
      entries.push({ channel: 'push', status: 'failed', reason: result.reason, deviceId: device.id });
    }
  }
  await record(entries);
  const sent = entries.filter((entry) => entry.status === 'sent').length;
  log.info('notification delivery', {
    ...ids,
    // The notification_delivery_failures log metric counts status "failed" (FND-21).
    status: sent ? 'sent' : 'failed',
    devices: devices.size,
    sent,
    pruned: entries.filter((entry) => entry.reason === 'invalid_token').length,
    attempt,
  });
  if (retry && !lastAttempt) throw new RetryDelivery();
  return sent ? { status: 'sent' } : { status: 'failed', reason: retry ? 'transient' : 'no_device_reached' };
}

/** `notifications-deliver` (FND-20): the Cloud Tasks queue behind `notify()`. */
export const deliver = defineQueue({
  name: DELIVER_QUEUE,
  input: DeliveryTaskSchema,
  retry: { maxAttempts: DELIVERY_MAX_ATTEMPTS, minBackoffSeconds: 30, maxBackoffSeconds: 3600 },
  rateLimits: { maxConcurrentDispatches: 20 },
  secrets: [POSTMARK_TOKEN],
  handler: async (task, { db, ports, log, attempt }) => {
    await deliverNotification(task, { db, ports, log, attempt });
  },
});
