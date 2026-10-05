import { createHash, timingSafeEqual } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

import { notify } from './notify';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, functionsSink, type Log } from '../core/log';
import { POSTMARK_WEBHOOK_SECRET, secretValue } from '../core/secrets';
import type { Clock, Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

/** The basic-auth user name in the webhook URL Postmark calls (`https://postmark:<secret>@…`). */
export const WEBHOOK_USER = 'postmark';

/** The parts of Postmark's bounce and spam-complaint webhooks we read (never logged). */
const PostmarkEventSchema = z.object({
  RecordType: z.string(),
  Type: z.string().optional(),
  Inactive: z.boolean().optional(),
  Email: z.string().optional(),
  ID: z.union([z.number(), z.string()]).optional(),
  MessageID: z.string().optional(),
});

/**
 * Bounce types that mean the address will never work (Postmark `Type`); any bounce Postmark marks
 * `Inactive` (it suppresses the address) counts too.
 */
const HARD_BOUNCES = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated']);

export interface WebhookRequest {
  method: string;
  authorization: string | undefined;
  body: unknown;
}

export interface WebhookDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
  /** The shared secret (`''` when not configured: every call is refused). */
  secret: string;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; result?: string; users?: number };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Checks `Authorization: Basic base64(postmark:<secret>)` in constant time. */
export function authorised(header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return timingSafeEqual(digest(decoded), digest(`${WEBHOOK_USER}:${secret}`));
}

/** What an event means for the address: undeliverable (and why), or nothing. */
export function classifyPostmarkEvent(event: z.infer<typeof PostmarkEventSchema>) {
  if (event.RecordType === 'SpamComplaint') return 'spam_complaint' as const;
  if (event.RecordType === 'Bounce' && (event.Inactive === true || HARD_BOUNCES.has(event.Type ?? ''))) {
    return 'hard_bounce' as const;
  }
  return null;
}

/**
 * Handles one Postmark webhook call (FND-20). A hard bounce or a spam complaint marks every
 * account with that address `emailDeliverability: undeliverable` (so nothing more is emailed to
 * it) and tells the person in-app, in each org they are an active member of. Soft bounces and
 * other events are acknowledged and ignored. The address never reaches the logs.
 */
export async function handlePostmarkWebhook(request: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  if (request.method !== 'POST') return { status: 405, body: { ok: false } };
  if (!deps.secret) {
    deps.log.warn('postmark webhook not configured');
    return { status: 503, body: { ok: false } };
  }
  if (!authorised(request.authorization, deps.secret)) {
    deps.log.warn('postmark webhook refused');
    return { status: 401, body: { ok: false } };
  }
  const parsed = PostmarkEventSchema.safeParse(request.body);
  if (!parsed.success) return { status: 400, body: { ok: false } };
  const event = parsed.data;
  const reason = classifyPostmarkEvent(event);
  const email = event.Email?.trim().toLowerCase();
  if (!reason || !email) {
    deps.log.info('postmark event ignored', { recordType: event.RecordType, type: event.Type ?? null });
    return { status: 200, body: { ok: true, result: 'ignored' } };
  }

  const now = deps.clock.now();
  const users = await deps.db.collection('users').where('email', '==', email).get();
  let marked = 0;
  for (const user of users.docs) {
    if (user.get('emailDeliverability.status') === 'undeliverable') continue; // A repeat: already told.
    await user.ref.update({
      emailDeliverability: { status: 'undeliverable', reason, at: now },
      updatedAt: now,
      updatedBy: 'system',
    });
    marked += 1;
    const orgIds = user.get('orgIds');
    for (const orgId of Array.isArray(orgIds) ? (orgIds as unknown[]) : []) {
      if (typeof orgId !== 'string' || !orgId) continue;
      await notify(
        { db: deps.db, orgId, clock: deps.clock, log: deps.log, ports: deps.ports },
        {
          kind: 'system',
          recipients: [user.id],
          channels: ['inapp'],
          priority: 'high',
          title: 'We can’t email you',
          body:
            reason === 'spam_complaint'
              ? 'An email from Materia was reported as spam, so we’ve stopped emailing you. You’ll still see notifications here.'
              : 'Email to your address bounced, so we’ve stopped emailing you. Check your address; you’ll still see notifications here.',
          link: '/settings',
          key: `undeliverable-${user.id}-${now.getTime()}`,
        },
      );
    }
  }
  deps.log.info('postmark event', { recordType: event.RecordType, reason, accounts: users.size, marked });
  return { status: 200, body: { ok: true, result: reason, users: marked } };
}

/** `notifications-postmarkWebhook` (FND-20): Postmark's bounce and spam-complaint webhook. */
export const postmarkWebhook = onRequest(
  { region: REGION, secrets: [POSTMARK_WEBHOOK_SECRET], invoker: 'public', cors: false, concurrency: 20 },
  async (req, res) => {
    const log = createLog({ fn: 'notifications-postmarkWebhook' }, functionsSink);
    const response = await handlePostmarkWebhook(
      { method: req.method, authorization: req.get('authorization'), body: req.body },
      {
        db: adminDb(),
        clock: systemClock,
        log,
        ports: ports(),
        secret: secretValue(() => POSTMARK_WEBHOOK_SECRET.value()),
      },
    );
    res.status(response.status).json(response.body);
  },
);
