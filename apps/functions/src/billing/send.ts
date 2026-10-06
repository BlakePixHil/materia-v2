import type { Firestore } from 'firebase-admin/firestore';

import {
  cents,
  DomainError,
  formatAbn,
  formatCents,
  INVOICE_CALLABLES,
  invoicePdfName,
  PERMISSIONS,
  SendInvoiceInput,
  toDisplay,
  type DateOnly,
  type SendInvoiceResult,
} from '@materia/domain';

import { existing, invoicePath, LIVE_INVOICE_STATUSES } from './invoice-shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { storageFiles, type FileStore } from '../documents/files';
import { liveMatter, matterPath } from '../matters/shared';
import { MailError } from '../ports';

type Data = Record<string, unknown>;

/** The PDF's bytes are read from the matter-files bucket; tests swap it for an in-memory one. */
let files: () => FileStore = () => storageFiles();
export function setInvoiceFiles(next?: () => FileStore): void {
  files = next ?? (() => storageFiles());
}

/** The bytes of an invoice's rendered PDF, or null when it isn't ready or is missing. */
export async function invoicePdfBytes(db: Firestore, orgId: string, invoice: Data): Promise<Uint8Array | null> {
  const documentId = invoice['pdfDocumentId'];
  if (invoice['pdfStatus'] !== 'ready' || typeof documentId !== 'string') return null;
  const matterId = String(invoice['matterId']);
  const document = (await db.doc(`${matterPath(orgId, matterId)}/documents/${documentId}`).get()).data() as
    Data | undefined;
  const storagePath = typeof document?.['storagePath'] === 'string' ? document['storagePath'] : null;
  return storagePath ? files().read(storagePath) : null;
}

/** What an invoice email shows (the title, number, firm, total and due date) and its PDF attachment. */
export function invoiceMail(invoice: Data, bytes: Uint8Array | null) {
  const number = String(invoice['number']);
  const registered = invoice['gstRegistered'] !== false;
  const supplier = (invoice['supplier'] ?? {}) as { name?: string; abn?: string };
  const title = invoicePdfName('invoice', number, registered).replace(` ${number}`, '');
  const model = {
    documentTitle: title,
    number,
    firmName: supplier.name ?? '',
    firmAbn: supplier.abn ? formatAbn(supplier.abn) : '',
    total: formatCents(cents(Number(invoice['totalCents']))),
    dueLabel: typeof invoice['dueDate'] === 'string' ? toDisplay(invoice['dueDate'] as DateOnly) : '',
  };
  const attachment = bytes ? { name: `${title} ${number}.pdf`, contentType: 'application/pdf', content: bytes } : null;
  return { model, attachment };
}

export const MAIL_FAILURE_COPY: Record<string, string> = {
  not_configured: 'Email isn’t set up yet, so nothing was sent. Download the PDF and send it yourself.',
  inactive_recipient: 'That address has bounced before, so nothing was sent to it.',
  rejected: 'The email service refused the message, so nothing was sent.',
  transient: 'The email service didn’t answer; try again shortly.',
};

/**
 * `billing-sendInvoice` (BILL-07; `billing.issue`; flag `billing.invoicing`; idempotent): emails an
 * issued invoice's PDF, as an attachment, to the addresses given (the client's by default in the
 * app), with an optional message, through the MailPort; then records `sentAt`, `sentBy` and
 * `sentTo`. Invoices are never sent automatically: only this call sends one. The PDF must be ready.
 * Audited as `invoice.sent` (how many recipients, never the addresses).
 */
export const sendDefinition = {
  name: INVOICE_CALLABLES.send,
  input: SendInvoiceInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<SendInvoiceResult> => {
    const { input, orgId, uid, role, db, clock, requestId, ports, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const invoice = existing(await ref.get());
    if (!LIVE_INVOICE_STATUSES.has(String(invoice['status']))) {
      throw new DomainError('FAILED_PRECONDITION', 'Only an issued invoice can be sent');
    }
    const matterId = String(invoice['matterId']);
    liveMatter(await db.doc(matterPath(orgId, matterId)).get(), role, matterId);
    if (invoice['pdfStatus'] !== 'ready' || typeof invoice['pdfDocumentId'] !== 'string') {
      throw new DomainError('FAILED_PRECONDITION', 'The PDF isn’t ready yet');
    }
    const bytes = await invoicePdfBytes(db, orgId, invoice);
    if (!bytes) throw new DomainError('FAILED_PRECONDITION', 'The PDF is missing; render it again');

    const number = String(invoice['number']);
    const { model: base, attachment } = invoiceMail(invoice, bytes);
    const model = { ...base, message: input.message.trim() };
    const to = [...new Set(input.to)];
    let sent = 0;
    for (const [index, address] of to.entries()) {
      try {
        await ports.mail.send({
          to: address,
          template: 'invoice',
          model,
          idempotencyKey: `${requestId}-${index}`,
          attachments: attachment ? [attachment] : [],
        });
        sent++;
      } catch (error) {
        log.warn('invoice email not sent', {
          invoiceId: ref.id,
          reason: error instanceof MailError ? error.failure : 'unknown',
          sentBefore: sent,
        });
        const copy = error instanceof MailError ? MAIL_FAILURE_COPY[error.failure] : undefined;
        if (sent)
          await ref.update({
            sentAt: clock.now(),
            sentBy: uid,
            sentTo: to.slice(0, sent),
            ...stamp(uid, clock.now(), requestId),
          });
        throw new DomainError(
          error instanceof MailError && error.failure === 'transient' ? 'UNAVAILABLE' : 'FAILED_PRECONDITION',
          copy ?? 'The invoice couldn’t be emailed',
          { sent },
        );
      }
    }
    const now = clock.now();
    await ref.update({ sentAt: now, sentBy: uid, sentTo: to, ...stamp(uid, now, requestId) });
    await audit(ctx, {
      action: 'invoice.sent',
      entity: { path: ref.path },
      summary: `Invoice ${number} emailed`,
      data: { number, recipients: sent },
    });
    log.info('invoice sent', { invoiceId: ref.id, recipients: sent });
    return { sent };
  },
} satisfies CallableDefinition<typeof SendInvoiceInput, SendInvoiceResult>;

export const send = defineCallable(sendDefinition);
