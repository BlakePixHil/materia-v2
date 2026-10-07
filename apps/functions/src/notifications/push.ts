import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';

import { adminApp } from '../core/admin';
import { appUrl } from '../orgs/shared';
import type { PushMessage, PushPort, PushResult } from '../ports';

/** FCM says the token no longer belongs to an app install: delete the device. */
const GONE = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-recipient',
]);
/** Worth another attempt later. */
const TRANSIENT = new Set([
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/unknown-error',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
]);

export function classifyPushError(error: unknown): PushResult {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && GONE.has(code)) return { ok: false, reason: 'invalid_token' };
  if (typeof code === 'string' && TRANSIENT.has(code)) return { ok: false, reason: 'transient' };
  return { ok: false, reason: 'rejected' };
}

/**
 * The FCM message: title and body on the lock screen, the app link (and its org) on tap. On the
 * web, the app's service worker (`sw.js`, MOB-04) shows it and routes the tap; `fcmOptions.link`
 * is for clients without it. High urgency, so a phone saving battery doesn't hold it back.
 */
export function fcmMessage(token: string, message: PushMessage) {
  const url = `${appUrl()}${message.link}`;
  return {
    token,
    notification: { title: message.title, body: message.body },
    data: {
      link: message.link,
      ...(message.orgId ? { orgId: message.orgId } : {}),
      ...(message.tag ? { tag: message.tag } : {}),
    },
    webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: url } },
  };
}

/**
 * The PushPort adapter on Firebase Cloud Messaging (FND-20), through the Admin SDK (loaded on first
 * use). Never logs the token or the message.
 */
export function fcmPush(messaging?: () => Promise<Pick<Messaging, 'send'>>): PushPort {
  const load =
    messaging ?? (async () => (await import('firebase-admin/messaging')).getMessaging(adminApp()) as Messaging);
  return {
    async send(token, message) {
      try {
        const id = await (await load()).send(fcmMessage(token, message));
        return { ok: true, id };
      } catch (error) {
        return classifyPushError(error);
      }
    },
  };
}

/**
 * The emulator's push: each message is written to `emulatorPushOutbox/{id}` (server-only, like
 * `emulatorOutbox`) for the dev mail page and tests. Tokens starting `invalid-` are reported gone.
 */
export function emulatorPush(db: () => Firestore): PushPort {
  return {
    async send(token, message) {
      if (token.startsWith('invalid-')) return { ok: false, reason: 'invalid_token' };
      const ref = await db()
        .collection('emulatorPushOutbox')
        .add({ token, ...message, sentAt: new Date() });
      return { ok: true, id: ref.id };
    },
  };
}
