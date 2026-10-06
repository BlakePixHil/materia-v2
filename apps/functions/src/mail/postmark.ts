import { MAIL_FROM } from '../config';
import { MailError, type MailPort } from '../ports';
import { renderMail } from './templates';

/** Postmark's transactional stream; broadcast mail would use another (FND-20). */
export const POSTMARK_STREAM = 'outbound';
export const POSTMARK_API = 'https://api.postmarkapp.com/email';

/**
 * The sender: `MAIL_FROM` (config.ts), or `MATERIA_MAIL_FROM` where the environment sets it.
 * Postmark only sends from a confirmed sender signature or a verified domain (infra/MANUAL.md,
 * FND-20); until then it refuses the message and the delivery is recorded as `rejected`.
 */
export function mailFrom(): string {
  return process.env['MATERIA_MAIL_FROM'] || MAIL_FROM;
}

export interface PostmarkOptions {
  /** The server token, read on each send (`''` when not configured). */
  token: () => string;
  from: () => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Postmark error codes that mean "this request will never succeed" (not worth retrying). */
const INACTIVE_RECIPIENT = 406;
const BAD_TOKEN = 10;

/**
 * The MailPort adapter for Postmark (FND-20), over its HTTP API (no SDK): renders the template
 * (HTML and text), sends on the `outbound` stream with tracking off, and classifies failures. With
 * no token it throws `not_configured` without calling out, so real email stays off until the
 * POSTMARK_TOKEN secret has a value. Never logs or returns the address or content.
 */
export function postmarkMail(options: PostmarkOptions): MailPort {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(message) {
      const token = options.token();
      if (!token) throw new MailError('not_configured', 'POSTMARK_TOKEN is not set');
      const mail = renderMail(message.template, message.model);
      let response: Response;
      try {
        response = await fetchImpl(POSTMARK_API, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': token,
          },
          body: JSON.stringify({
            From: options.from(),
            To: message.to,
            Subject: mail.subject,
            HtmlBody: mail.html,
            TextBody: mail.text,
            MessageStream: POSTMARK_STREAM,
            Tag: message.template,
            TrackOpens: false,
            TrackLinks: 'None',
            ...(message.attachments?.length
              ? {
                  Attachments: message.attachments.map((file) => ({
                    Name: file.name,
                    Content: Buffer.from(file.content).toString('base64'),
                    ContentType: file.contentType,
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        throw new MailError('transient', 'Postmark unreachable');
      }
      const result = (await response.json().catch(() => ({}))) as { ErrorCode?: number; MessageID?: string };
      const code = typeof result.ErrorCode === 'number' ? result.ErrorCode : undefined;
      if (response.ok && (code ?? 0) === 0 && result.MessageID) return { id: result.MessageID };
      if (response.status === 429 || response.status >= 500) {
        throw new MailError('transient', `Postmark ${response.status}`, code);
      }
      if (response.status === 401 || code === BAD_TOKEN) {
        throw new MailError('not_configured', 'Postmark refused the server token', code);
      }
      if (code === INACTIVE_RECIPIENT) throw new MailError('inactive_recipient', 'Inactive recipient', code);
      throw new MailError('rejected', `Postmark ${response.status}`, code);
    },
  };
}
