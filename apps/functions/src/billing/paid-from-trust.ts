import { FieldValue } from 'firebase-admin/firestore';

import {
  DomainError,
  formatCents,
  cents,
  INVOICE_CALLABLES,
  PERMISSIONS,
  SetPaidFromTrustInput,
  trustNoticeFor,
  type SetPaidFromTrustResult,
  type TrustNotice,
} from '@materia/domain';

import { startDocumentPdf } from './invoice-pdf';
import { existing, invoicePath, LIVE_INVOICE_STATUSES } from './invoice-shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { isEnabled, requireFlag, type FlagContext } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** Whether issued invoices marked "To be paid from trust" carry the r 42(3) notice (BILL-12). */
export const trustNoticeOn = (ctx: FlagContext): Promise<boolean> => isEnabled(ctx, 'billing.trustNotice');

/**
 * The r 42(3) notice for an issued invoice (BILL-12, ADR-035): who is withdrawing, how much, for
 * which matter and invoice. Frozen on the invoice, so the PDF prints what the client was given.
 */
export function trustNoticeOf(invoice: {
  number: string;
  totalCents: number;
  supplierName?: string | undefined;
  matterNumber?: string | undefined;
  matterTitle?: string | undefined;
}): TrustNotice {
  const matter = invoice.matterNumber
    ? `${invoice.matterNumber}${invoice.matterTitle ? ` (${invoice.matterTitle})` : ''}`
    : 'this matter';
  return trustNoticeFor({
    firm: invoice.supplierName || 'The firm',
    amount: formatCents(cents(invoice.totalCents)),
    matter,
    number: invoice.number,
  });
}

/**
 * `billing-setPaidFromTrust` (BILL-12; `billing.issue`; flag `billing.invoicing`; idempotent):
 * marks a pre-bill or an issued invoice "To be paid from trust", or clears it. It records the
 * intention only: Materia never starts, schedules or authorises a withdrawal, and the 7 business
 * days in r 42(3) are never counted down as permission. On an issued invoice with
 * `billing.trustNotice` on, the r 42(3) notice is frozen on it (or removed) and the PDF is rendered
 * again. Audited as `invoice.trust_option_set`.
 */
export const setPaidFromTrustDefinition = {
  name: INVOICE_CALLABLES.setPaidFromTrust,
  input: SetPaidFromTrustInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<SetPaidFromTrustResult> => {
    const { input, orgId, uid, role, db, requestId, clock, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const noticeOn = await trustNoticeOn({ orgId, db, clock });
    const ref = db.doc(invoicePath(orgId, input.invoiceId));

    const result = await db.runTransaction(async (tx) => {
      const invoice = existing(await tx.get(ref));
      const status = String(invoice['status']);
      const issued = LIVE_INVOICE_STATUSES.has(status);
      if (status !== 'draft' && !issued) throw new DomainError('FAILED_PRECONDITION', 'This invoice is void');
      const matterId = String(invoice['matterId']);
      const matter = liveMatter(await tx.get(db.doc(matterPath(orgId, matterId))), role, matterId);
      const before = invoice['trustNotice'] as TrustNotice | undefined;
      const notice =
        issued && noticeOn && input.paidFromTrust
          ? trustNoticeOf({
              number: String(invoice['number']),
              totalCents: Number(invoice['totalCents'] ?? 0),
              supplierName: (invoice['supplier'] as { name?: string } | undefined)?.name,
              matterNumber: invoice['matterNumber'] as string | undefined,
              matterTitle: invoice['matterTitle'] as string | undefined,
            })
          : undefined;
      // The notice a bill already carries stays as given while it remains marked.
      const kept = input.paidFromTrust ? (before ?? notice) : undefined;
      const noticeChanged = issued && (before?.text ?? null) !== (kept?.text ?? null);
      const changed = (invoice['paidFromTrust'] === true) !== input.paidFromTrust || noticeChanged;
      if (!changed) return { changed: false, render: false, number: String(invoice['number'] ?? ''), matter };
      tx.update(ref, {
        paidFromTrust: input.paidFromTrust,
        trustNotice: kept ?? FieldValue.delete(),
        ...stamp(uid, clock.now(), requestId),
      });
      return { changed: true, render: noticeChanged, number: String(invoice['number'] ?? ''), matter };
    });

    if (result.changed) {
      await audit(ctx, {
        action: 'invoice.trust_option_set',
        entity: { path: ref.path },
        summary: input.paidFromTrust
          ? `Invoice ${result.number || '(pre-bill)'} marked to be paid from trust`
          : `Invoice ${result.number || '(pre-bill)'} no longer marked to be paid from trust`,
        data: { paidFromTrust: input.paidFromTrust, notice: result.render },
      });
    }
    let pdfRendering = false;
    if (result.render) {
      const doc = (await ref.get()).data() as Parameters<typeof startDocumentPdf>[3] & Data;
      pdfRendering = (await startDocumentPdf(ctx, 'invoice', ref.id, doc, result.matter)) !== null;
    }
    log.info('paid from trust set', { invoiceId: ref.id, paidFromTrust: input.paidFromTrust, pdfRendering });
    return { paidFromTrust: input.paidFromTrust, pdfRendering };
  },
} satisfies CallableDefinition<typeof SetPaidFromTrustInput, SetPaidFromTrustResult>;

export const setPaidFromTrust = defineCallable(setPaidFromTrustDefinition);
