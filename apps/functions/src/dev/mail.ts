import type { Firestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { isEmulator } from '../core/env';
import { renderMail } from '../mail/templates';

const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const when = (value: unknown) => {
  const date = (value as { toDate?: () => Date } | undefined)?.toDate?.();
  return date ? date.toISOString().replace('T', ' ').slice(0, 19) : '';
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <title>${escape(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
      table { border-collapse: collapse; width: 100%; font-size: 14px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
      iframe { width: 100%; height: 480px; border: 1px solid #ddd; }
      pre { white-space: pre-wrap; background: #f6f6f6; padding: 12px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;

/**
 * The dev mail preview (FND-20, emulator only): the emails the fake MailPort captured in
 * `emulatorOutbox`, newest first, each rendered as Postmark would send it (HTML in a sandboxed
 * frame, and the text version), plus the pushes in `emulatorPushOutbox`.
 */
export async function devMailPage(db: Firestore, id: string | undefined): Promise<{ status: number; html: string }> {
  if (id) {
    const snap = await db.doc(`emulatorOutbox/${id}`).get();
    if (!snap.exists) return { status: 404, html: page('Not found', '<p>No such email. <a href="?">All mail</a></p>') };
    const data = snap.data() as { to?: string; template?: string; model?: Record<string, unknown>; sentAt?: unknown };
    let mail;
    try {
      mail = renderMail(String(data.template), data.model ?? {});
    } catch (error) {
      return {
        status: 200,
        html: page(
          'Unrenderable',
          `<p>Template ${escape(data.template)} failed: ${escape((error as Error).message)}</p>`,
        ),
      };
    }
    return {
      status: 200,
      html: page(
        mail.subject,
        `<p><a href="?">← All mail</a></p>
<h1 style="font-size: 20px">${escape(mail.subject)}</h1>
<p>To <strong>${escape(data.to)}</strong> · template <code>${escape(data.template)}</code> · ${escape(when(data.sentAt))}</p>
<h2 style="font-size: 16px">HTML</h2>
<iframe title="HTML version" sandbox="" srcdoc="${escape(mail.html)}"></iframe>
<h2 style="font-size: 16px">Text</h2>
<pre>${escape(mail.text)}</pre>`,
      ),
    };
  }
  const [mail, pushes] = await Promise.all([
    db.collection('emulatorOutbox').orderBy('sentAt', 'desc').limit(100).get(),
    db.collection('emulatorPushOutbox').orderBy('sentAt', 'desc').limit(50).get(),
  ]);
  const mailRows = mail.docs
    .map((doc) => {
      const data = doc.data();
      let subject = '';
      try {
        subject = renderMail(String(data['template']), (data['model'] as Record<string, unknown>) ?? {}).subject;
      } catch {
        subject = '(unrenderable)';
      }
      return `<tr><td>${escape(when(data['sentAt']))}</td><td>${escape(data['to'])}</td><td><a href="?id=${encodeURIComponent(doc.id)}">${escape(subject)}</a></td><td><code>${escape(data['template'])}</code></td></tr>`;
    })
    .join('');
  const pushRows = pushes.docs
    .map((doc) => {
      const data = doc.data();
      return `<tr><td>${escape(when(data['sentAt']))}</td><td><code>${escape(String(data['token']).slice(0, 24))}</code></td><td>${escape(data['title'])}</td><td>${escape(data['link'])}</td></tr>`;
    })
    .join('');
  return {
    status: 200,
    html: page(
      'Dev mail',
      `<h1 style="font-size: 20px">Dev mail</h1>
<p>Emails and pushes the emulator captured instead of sending (newest first). Nothing here leaves this machine.</p>
<table><caption style="text-align: left; font-weight: 600; padding: 8px 0">Email</caption><thead><tr><th scope="col">Sent</th><th scope="col">To</th><th scope="col">Subject</th><th scope="col">Template</th></tr></thead><tbody>${mailRows || '<tr><td colspan="4">No email yet.</td></tr>'}</tbody></table>
<table style="margin-top: 24px"><caption style="text-align: left; font-weight: 600; padding: 8px 0">Push</caption><thead><tr><th scope="col">Sent</th><th scope="col">Token</th><th scope="col">Title</th><th scope="col">Link</th></tr></thead><tbody>${pushRows || '<tr><td colspan="4">No pushes yet.</td></tr>'}</tbody></table>`,
    ),
  };
}

/** `dev-mail`: only defined (and so only deployed) in the emulator; it refuses anything else anyway. */
export function devMailFunction() {
  return onRequest({ region: REGION, invoker: 'public', cors: true }, async (req, res) => {
    if (!isEmulator()) {
      res.status(404).send('Not found');
      return;
    }
    const id = typeof req.query['id'] === 'string' ? req.query['id'] : undefined;
    const { status, html } = await devMailPage(adminDb(), id);
    res.status(status).type('html').send(html);
  });
}
