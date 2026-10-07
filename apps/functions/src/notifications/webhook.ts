import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import * as z from 'zod';

import { notify } from './notify';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { createLog, functionsSink, type Log } from '../core/log';
import { RESEND_WEBHOOK_SECRET, secretValue } from '../core/secrets';
import type { Clock, Ports } from '../ports';
import { ports, systemClock } from '../ports/container';

/** How far a webhook's timestamp may be from now, either way (Svix's default). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** The parts of Resend's email webhooks we read (never logged). */
const ResendEventSchema = z.object({
  type: z.string(),
  data: z
    .object({
      to: z.union([z.array(z.string()), z.string()]).optional(),
      bounce: z.object({ type: z.string().optional() }).optional(),
    })
    .optional(),
});
type ResendEvent = z.infer<typeof ResendEventSchema>;

export interface WebhookRequest {
  method: string;
  /** The Svix headers Resend signs with: `svix-id`, `svix-timestamp` and `svix-signature`. */
  headers: { id?: string | undefined; timestamp?: string | undefined; signature?: string | undefined };
  /** The body exactly as received; the signature covers these bytes. */
  rawBody: string;
}

export interface WebhookDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'tasks'>;
  /** The webhook's signing secret, `whsec_…` (`''` when not configured: every call is refused). */
  secret: string;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; result?: string; users?: number };
}

/**
 * The Svix signature of a webhook call (Resend's webhooks): HMAC-SHA256 over `{id}.{timestamp}.{body}`,
 * keyed with the base64 part of the `whsec_` secret.
 */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): Buffer {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
}

/**
 * Checks the signature header's `v1,<base64>` entries against `svixSignature`, in constant time. A
 * timestamp more than five minutes off is refused, so a captured call can't be replayed later.
 */
export function verifySignature(request: WebhookRequest, secret: string, now: Date): boolean {
  const { id, timestamp, signature } = request.headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now.getTime() - seconds * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = svixSignature(secret, id, timestamp, request.rawBody);
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * What an event means for the address: undeliverable (and why), or nothing. A permanent bounce, or
 * a send Resend suppressed because the address bounced or complained before, is a hard bounce;
 * transient and undetermined bounces mean nothing.
 */
export function classifyResendEvent(event: ResendEvent) {
  if (event.type === 'email.complained') return 'spam_complaint' as const;
  if (event.type === 'email.suppressed') return 'hard_bounce' as const;
  if (event.type === 'email.bounced' && event.data?.bounce?.type === 'Permanent') return 'hard_bounce' as const;
  return null;
}

/**
 * Handles one Resend webhook call (FND-20, ADR-057). A hard bounce or a spam complaint marks every
 * account with that address `emailDeliverability: undeliverable` (so nothing more is emailed to
 * it) and tells the person in-app, in each org they are an active member of. Soft bounces and
 * other events are acknowledged and ignored. The address never reaches the logs.
 */
export async function handleResendWebhook(request: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  if (request.method !== 'POST') return { status: 405, body: { ok: false } };
  if (!deps.secret) {
    deps.log.warn('resend webhook not configured');
    return { status: 503, body: { ok: false } };
  }
  const now = deps.clock.now();
  if (!verifySignature(request, deps.secret, now)) {
    deps.log.warn('resend webhook refused');
    return { status: 401, body: { ok: false } };
  }
  let json: unknown;
  try {
    json = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, body: { ok: false } };
  }
  const parsed = ResendEventSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: { ok: false } };
  const event = parsed.data;
  const reason = classifyResendEvent(event);
  const to = event.data?.to;
  const emails = [...new Set((Array.isArray(to) ? to : to ? [to] : []).map((e) => e.trim().toLowerCase()))].filter(
    Boolean,
  );
  if (!reason || emails.length === 0) {
    deps.log.info('resend event ignored', { type: event.type, bounceType: event.data?.bounce?.type ?? null });
    return { status: 200, body: { ok: true, result: 'ignored' } };
  }

  let accounts = 0;
  let marked = 0;
  for (const email of emails) {
    const users = await deps.db.collection('users').where('email', '==', email).get();
    accounts += users.size;
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
  }
  deps.log.info('resend event', { type: event.type, reason, accounts, marked });
  return { status: 200, body: { ok: true, result: reason, users: marked } };
}

/** `notifications-resendWebhook` (FND-20, ADR-057): Resend's bounce, suppression and complaint webhook. */
export const resendWebhook = onRequest(
  { region: REGION, secrets: [RESEND_WEBHOOK_SECRET], invoker: 'public', cors: false, concurrency: 20 },
  async (req, res) => {
    const log = createLog({ fn: 'notifications-resendWebhook' }, functionsSink);
    const response = await handleResendWebhook(
      {
        method: req.method,
        headers: {
          id: req.get('svix-id'),
          timestamp: req.get('svix-timestamp'),
          signature: req.get('svix-signature'),
        },
        rawBody: req.rawBody?.toString('utf8') ?? '',
      },
      {
        db: adminDb(),
        clock: systemClock,
        log,
        ports: ports(),
        secret: secretValue(() => RESEND_WEBHOOK_SECRET.value()),
      },
    );
    res.status(response.status).json(response.body);
  },
);
