/**
 * Email templates (FND-17, FND-20): a subject, an HTML body and a plain-text version per template.
 * `{{field}}` is filled from the message model (HTML-escaped in the HTML body); `{{#list}}…{{/list}}`
 * repeats for each item of an array (or shows once when the value is truthy) and `{{^field}}…{{/field}}`
 * shows when it is empty. Every `link` or `…Link` value must be http(s). The MailPort adapter
 * (Postmark) renders with `renderMail`; the emulator's dev mail page does too.
 *
 * Subjects never carry matter content (names, facts): at most a matter number, as notification
 * titles do ("Deadline in 3 days: M-2026-0142").
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

const BUTTON =
  'display: inline-block; padding: 10px 16px; background: #111; color: #fff; border-radius: 6px; text-decoration: none';
const BODY = 'font-family: system-ui, sans-serif; color: #111; line-height: 1.5; max-width: 560px';
const FOOTER = 'color: #555; font-size: 13px; margin-top: 24px';

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

  // One notification (FND-20). The title is the subject; the body never holds privileged content.
  notification: {
    subject: '{{title}}',
    html: `<!doctype html>
<html lang="en-AU">
  <body style="${BODY}">
    {{#critical}}<p style="color: #b42318; font-weight: 600; margin: 0 0 8px">Needs attention today</p>{{/critical}}
    <h1 style="font-size: 18px; margin: 0 0 12px">{{title}}</h1>
    {{#body}}<p>{{body}}</p>{{/body}}
    <p><a href="{{link}}" style="${BUTTON}">Open in Materia</a></p>
    <p style="${FOOTER}">You get this email for {{kindLabel}}. <a href="{{settingsLink}}">Change your notification settings</a>.</p>
  </body>
</html>`,
    text: `{{#critical}}Needs attention today
{{/critical}}{{title}}
{{#body}}
{{body}}
{{/body}}
Open in Materia: {{link}}

You get this email for {{kindLabel}}. Change your notification settings: {{settingsLink}}`,
  },

  // The daily digest (FND-20): items on privileged matters show only the matter number.
  digest: {
    subject: '{{subject}}',
    html: `<!doctype html>
<html lang="en-AU">
  <body style="${BODY}">
    <h1 style="font-size: 18px; margin: 0 0 12px">Your day in Materia, {{dateLabel}}</h1>
    {{#dueToday}}{{#first}}<h2 style="font-size: 15px; margin: 16px 0 4px">Due today</h2><ul>{{/first}}
      <li>{{#critical}}<strong>Critical:</strong> {{/critical}}<a href="{{link}}">{{label}}</a>{{#matterNumber}} · {{matterNumber}}{{/matterNumber}}</li>{{#last}}</ul>{{/last}}{{/dueToday}}
    {{#overdue}}{{#first}}<h2 style="font-size: 15px; margin: 16px 0 4px">Overdue</h2><ul>{{/first}}
      <li>{{#critical}}<strong>Critical:</strong> {{/critical}}<a href="{{link}}">{{label}}</a>{{#matterNumber}} · {{matterNumber}}{{/matterNumber}} (due {{dueLabel}})</li>{{#last}}</ul>{{/last}}{{/overdue}}
    {{#unreadMentions}}<p><a href="{{inboxLink}}">{{unreadMentionsLabel}}</a></p>{{/unreadMentions}}
    <p><a href="{{link}}" style="${BUTTON}">Open Today</a></p>
    <p style="${FOOTER}">You get this summary each morning. <a href="{{settingsLink}}">Change your notification settings</a>.</p>
  </body>
</html>`,
    text: `Your day in Materia, {{dateLabel}}
{{#dueToday}}{{#first}}
Due today
{{/first}}- {{#critical}}Critical: {{/critical}}{{label}}{{#matterNumber}} · {{matterNumber}}{{/matterNumber}}: {{link}}
{{/dueToday}}{{#overdue}}{{#first}}
Overdue
{{/first}}- {{#critical}}Critical: {{/critical}}{{label}}{{#matterNumber}} · {{matterNumber}}{{/matterNumber}} (due {{dueLabel}}): {{link}}
{{/overdue}}{{#unreadMentions}}
{{unreadMentionsLabel}}: {{inboxLink}}
{{/unreadMentions}}
Open Today: {{link}}

You get this summary each morning. Change your notification settings: {{settingsLink}}`,
  },
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

type Scope = Record<string, unknown>;

const isLinkKey = (key: string) => key === 'link' || key.endsWith('Link');

/** A field from the innermost scope that has it (an item, then the model). */
function lookup(scopes: Scope[], key: string): unknown {
  for (const scope of scopes) if (key in scope) return scope[key];
  return undefined;
}

function text(scopes: Scope[], key: string): string {
  const value = lookup(scopes, key);
  const result = value == null ? '' : String(value);
  if (isLinkKey(key) && result && !/^https?:\/\//.test(result)) throw new Error('Mail links must be http(s)');
  return result;
}

const SECTION = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;

function fill(template: string, scopes: Scope[], escape: (value: string) => string): string {
  return template
    .replace(SECTION, (_match, type: string, key: string, inner: string) => {
      const value = lookup(scopes, key);
      const present = Array.isArray(value) ? value.length > 0 : !!value;
      if (type === '^') return present ? '' : fill(inner, scopes, escape);
      if (!present) return '';
      if (!Array.isArray(value)) return fill(inner, scopes, escape);
      return value
        .map((item, index) =>
          fill(
            inner,
            [{ ...(item as Scope), first: index === 0, last: index === value.length - 1 }, ...scopes],
            escape,
          ),
        )
        .join('');
    })
    .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => escape(text(scopes, key)));
}

/** Fills a template. Unknown placeholders become empty; a link that isn't http(s) is refused. */
export function renderMail(name: string, model: Record<string, unknown>): MailTemplate {
  const template = MAIL_TEMPLATES[name];
  if (!template) throw new Error(`Unknown mail template ${name}`);
  const scope: Scope = { ...model };
  if (typeof model['role'] === 'string') scope['roleName'] = ROLE_NAMES[model['role']] ?? 'a member';
  return {
    subject: fill(template.subject, [scope], (v) => v.replace(/[\r\n]+/g, ' ')).trim(),
    html: fill(template.html, [scope], escapeHtml),
    text: fill(template.text, [scope], (v) => v),
  };
}
