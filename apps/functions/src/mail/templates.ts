/**
 * Email templates (FND-17): a subject, an HTML body and a plain-text fallback per template, with
 * `{{field}}` placeholders filled from the message model. The MailPort adapter (FND-20, Postmark)
 * renders with `renderMail`. Values are HTML-escaped in the HTML body; links must be https (or
 * localhost in the emulator).
 */
export interface MailTemplate {
  subject: string;
  html: string;
  text: string;
}

const ROLE_NAMES: Record<string, string> = {
  owner: 'an owner',
  admin: 'an admin',
  lawyer: 'a lawyer',
  paralegal: 'a paralegal',
  readonly: 'a read-only member',
};

export const MAIL_TEMPLATES: Record<string, MailTemplate> = {
  invite: {
    subject: '{{inviterName}} invited you to {{orgName}} on Materia',
    html: `<!doctype html>
<html lang="en-AU">
  <body style="font-family: system-ui, sans-serif; color: #111; line-height: 1.5">
    <p>{{inviterName}} invited you to join <strong>{{orgName}}</strong> on Materia as {{roleName}}.</p>
    <p><a href="{{link}}" style="display: inline-block; padding: 10px 16px; background: #111; color: #fff; border-radius: 6px; text-decoration: none">Accept the invitation</a></p>
    <p>The link works for 7 days. If you weren’t expecting this, you can ignore this email.</p>
  </body>
</html>`,
    text: `{{inviterName}} invited you to join {{orgName}} on Materia as {{roleName}}.

Accept the invitation: {{link}}

The link works for 7 days. If you weren't expecting this, you can ignore this email.`,
  },
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Fills a template. Unknown placeholders become empty; a link that isn't http(s) is refused. */
export function renderMail(name: string, model: Record<string, unknown>): MailTemplate {
  const template = MAIL_TEMPLATES[name];
  if (!template) throw new Error(`Unknown mail template ${name}`);
  const values: Record<string, string> = Object.fromEntries(
    Object.entries(model).map(([key, value]) => [key, value == null ? '' : String(value)]),
  );
  if (typeof model['role'] === 'string') values['roleName'] = ROLE_NAMES[model['role']] ?? 'a member';
  if (values['link'] !== undefined && !/^https?:\/\//.test(values['link']))
    throw new Error('Mail links must be http(s)');
  const fill = (text: string, escape: (value: string) => string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => escape(values[key] ?? ''));
  return {
    subject: fill(template.subject, (v) => v.replace(/[\r\n]+/g, ' ')),
    html: fill(template.html, escapeHtml),
    text: fill(template.text, (v) => v),
  };
}
