import { MAIL_FROM } from '../config';
import { MailError, type MailPort } from '../ports';
import { renderMail } from './templates';

export const RESEND_API = 'https://api.resend.com/emails';

/**
 * The sender: `MAIL_FROM` (config.ts), or `MATERIA_MAIL_FROM` where the environment sets it.
 * Resend only sends from a verified domain (infra/MANUAL.md, ADR-057); until then it refuses the
 * message and the delivery is recorded as `rejected`.
 */
export function mailFrom(): string {
  return process.env['MATERIA_MAIL_FROM'] || MAIL_FROM;
}

export interface ResendOptions {
  /** The API key, read on each send (`''` when not configured). */
  apiKey: () => string;
  from: () => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Resend error names that mean the key is missing, wrong or not allowed to send. */
const KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key']);

/**
 * The MailPort adapter for Resend (ADR-057), over its HTTP API (no SDK): renders the template (HTML
 * and text), sends it tagged with the template name, and classifies failures. The message's
 * `idempotencyKey` goes in the `Idempotency-Key` header, so a retried send within 24 hours isn't
 * emailed twice. With no key it throws `not_configured` without calling out, so real email stays
 * off until the RESEND_API_KEY secret has a value. Open and click tracking are per-domain settings
 * in Resend, off by default; leave them off. Never logs or returns the address or content.
 *
 * Resend accepts mail to an address it suppresses (after a hard bounce or complaint) and reports it
 * by webhook (`email.suppressed`), so `inactive_recipient` never comes from here: the webhook marks
 * the address undeliverable and later sends skip it.
 */
export function resendMail(options: ResendOptions): MailPort {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(message) {
      const apiKey = options.apiKey();
      if (!apiKey) throw new MailError('not_configured', 'RESEND_API_KEY is not set');
      const mail = renderMail(message.template, message.model);
      let response: Response;
      try {
        response = await fetchImpl(RESEND_API, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: options.from(),
            to: [message.to],
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            tags: [{ name: 'template', value: message.template }],
            ...(message.attachments?.length
              ? {
                  attachments: message.attachments.map((file) => ({
                    filename: file.name,
                    content: Buffer.from(file.content).toString('base64'),
                    content_type: file.contentType,
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        throw new MailError('transient', 'Resend unreachable');
      }
      const result = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
      if (response.ok && typeof result.id === 'string' && result.id) return { id: result.id };
      const name = typeof result.name === 'string' ? result.name : '';
      const status = response.status;
      // 409 concurrent_idempotent_requests: the same send is still in flight; try again later.
      if (status === 429 || status >= 500 || name === 'concurrent_idempotent_requests') {
        throw new MailError('transient', `Resend ${status}`, status);
      }
      if (status === 401 || KEY_ERRORS.has(name)) {
        throw new MailError('not_configured', 'Resend refused the API key', status);
      }
      throw new MailError('rejected', `Resend ${status}${name ? ` ${name}` : ''}`, status);
    },
  };
}
