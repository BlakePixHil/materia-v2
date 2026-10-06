import { FieldValue } from 'firebase-admin/firestore';

import { DomainError, INVOICE_CALLABLES, PERMISSIONS, VoidInvoiceInput, type VoidInvoiceResult } from '@materia/domain';

import { existing, invoicePath, invoicesPath, LIVE_INVOICE_STATUSES } from './invoice-shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';

/**
 * `billing-voidInvoice` (BILL-07; `billing.void`: owners and admins; flag `billing.invoicing`;
 * idempotent): voids an issued invoice that has no payments and no credit notes. In one
 * transaction the invoice keeps its number (numbers are never reused) and becomes `void` with
 * who, when and why; its time entries go back to `final` and its disbursements to `unbilled`
 * without the `invoiceId` (their triggers return them to WIP); and the matter's `lastInvoicedOn`
 * becomes its latest remaining invoice's date. A paid or credited invoice is corrected with a credit
 * note instead. Audited as `invoice.voided`.
 */
export const voidDefinition = {
  name: INVOICE_CALLABLES.void,
  input: VoidInvoiceInput,
  roles: PERMISSIONS['billing.void'],
  idempotent: true,
  handler: async (ctx): Promise<VoidInvoiceResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const reason = input.reason.trim();

    const result = await db.runTransaction(async (tx) => {
      const invoice = existing(await tx.get(ref));
      if (invoice['status'] === 'void') return { voided: false, released: 0, number: String(invoice['number']) };
      if (invoice['status'] === 'draft') {
        throw new DomainError('FAILED_PRECONDITION', 'A pre-bill isn’t issued; delete it instead');
      }
      const payments = (invoice['payments'] ?? []) as unknown[];
      if (invoice['status'] !== 'issued' || payments.length) {
        throw new DomainError('FAILED_PRECONDITION', 'A paid invoice can’t be voided; issue a credit note instead');
      }
      if (Number(invoice['creditedCents'] ?? 0) > 0) {
        throw new DomainError('FAILED_PRECONDITION', 'This invoice has a credit note; credit the rest instead');
      }
      const matterId = String(invoice['matterId']);
      const matterRef = db.doc(matterPath(orgId, matterId));
      liveMatter(await tx.get(matterRef), role, matterId);
      const [entries, disbursements, others] = await Promise.all([
        tx.get(db.collection(`${matterRef.path}/timeEntries`).where('invoiceId', '==', ref.id)),
        tx.get(db.collection(`${matterRef.path}/disbursements`).where('invoiceId', '==', ref.id)),
        tx.get(db.collection(invoicesPath(orgId)).where('matterId', '==', matterId)),
      ]);

      const now = clock.now();
      const meta = stamp(uid, now, requestId);
      tx.update(ref, { status: 'void', voidedAt: now, voidedBy: uid, voidReason: reason, ...meta });
      let released = 0;
      for (const entry of entries.docs) {
        if (entry.get('status') !== 'billed') continue;
        tx.update(entry.ref, { status: 'final', invoiceId: FieldValue.delete(), ...meta });
        released++;
      }
      for (const disbursement of disbursements.docs) {
        if (disbursement.get('status') !== 'billed') continue;
        tx.update(disbursement.ref, { status: 'unbilled', invoiceId: FieldValue.delete(), ...meta });
        released++;
      }
      const latest = others.docs
        .filter((doc) => doc.id !== ref.id && LIVE_INVOICE_STATUSES.has(String(doc.get('status'))))
        .map((doc) => String(doc.get('issueDate') ?? ''))
        .filter(Boolean)
        .sort()
        .pop();
      tx.update(matterRef, { lastInvoicedOn: latest ?? FieldValue.delete(), ...meta });
      return { voided: true, released, number: String(invoice['number']) };
    });

    if (result.voided) {
      await audit(ctx, {
        action: 'invoice.voided',
        entity: { path: ref.path },
        summary: `Invoice ${result.number} voided`,
        data: { number: result.number, released: result.released, reason },
      });
    }
    log.info('invoice voided', { invoiceId: ref.id, released: result.released, repeat: !result.voided });
    return { invoiceId: ref.id, released: result.released };
  },
} satisfies CallableDefinition<typeof VoidInvoiceInput, VoidInvoiceResult>;

export const voidInvoice = defineCallable(voidDefinition);
