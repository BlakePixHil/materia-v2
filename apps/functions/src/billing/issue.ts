import { FieldValue } from 'firebase-admin/firestore';

import {
  buildInvoice,
  draftChanges,
  DomainError,
  formatInvoiceNumber,
  INVOICE_CALLABLES,
  INVOICE_COUNTER,
  invoiceDueDate,
  IssueInvoiceInput,
  PERMISSIONS,
  today,
  type InvoiceItem,
  type InvoiceLine,
  type IssueInvoiceResult,
} from '@materia/domain';

import { draftFields } from './drafts';
import { startDocumentPdf } from './invoice-pdf';
import {
  buyerOf,
  existing,
  invoiceOrg,
  invoicePath,
  LIVE_INVOICE_STATUSES,
  readClients,
  readInvoiceSources,
  reader,
  supplierOf,
} from './invoice-shared';
import { trustNoticeOf, trustNoticeOn } from './paid-from-trust';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import { counterPath, liveMatter, matterPath } from '../matters/shared';

/** Concurrent issues queue on the counter; give them room to retry. */
const MAX_ATTEMPTS = 25;

/**
 * `billing-issueInvoice` (BILL-07; `billing.issue`: lawyers and above; flag `billing.invoicing`;
 * idempotent). One transaction:
 *
 * 1. reads the pre-bill, its matter, the org, the matter's time and disbursements and its clients,
 *    and rebuilds the lines; a pre-bill that changed since it was saved is refused (save it again
 *    to review the change), so what was previewed is exactly what is issued;
 * 2. takes the next number from `orgs/{orgId}/counters/invoice` (the org's prefix and six digits);
 *    the counter is read last and written with everything else, so a transaction that fails
 *    never uses a number up, and concurrent issues queue on it: no gaps, no repeats;
 * 3. freezes the invoice: number, issue and due dates (payment terms), the supplier and buyer,
 *    `status: issued`, and (BILL-12, `billing.trustNotice` on) the r 42(3) notice on an invoice
 *    to be paid from trust;
 * 4. marks each time entry and disbursement on it `billed` with the `invoiceId` (their triggers
 *    take them out of WIP, and BILL-05's budget counts them billed), and sets the matter's
 *    `lastInvoicedOn`.
 *
 * Then it is audited (`invoice.issued`) and the PDF render starts; a render that fails leaves the
 * invoice issued with `pdfStatus: failed` and a retry. Issuing an issued invoice again returns it.
 */
export const issueDefinition = {
  name: INVOICE_CALLABLES.issue,
  input: IssueInvoiceInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<IssueInvoiceResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'billing.invoicing');
    const noticeOn = await trustNoticeOn({ orgId, db, clock: ctx.clock });
    const clock = await orgClock(db, orgId, ctx.clock);
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const counterRef = db.doc(counterPath(orgId, INVOICE_COUNTER));

    const result = await db.runTransaction(
      async (tx) => {
        const read = reader(db, tx);
        const invoice = existing(await tx.get(ref));
        if (LIVE_INVOICE_STATUSES.has(String(invoice['status']))) {
          return { issued: false, number: String(invoice['number']), totalCents: Number(invoice['totalCents']) };
        }
        if (invoice['status'] !== 'draft') throw new DomainError('FAILED_PRECONDITION', 'This invoice is void');
        const matterId = String(invoice['matterId']);
        const matterRef = db.doc(matterPath(orgId, matterId));
        const [matterSnap, orgSnap] = await Promise.all([tx.get(matterRef), tx.get(db.doc(`orgs/${orgId}`))]);
        const matter = liveMatter(matterSnap, role, matterId);
        const org = invoiceOrg(orgSnap.data());
        const [sources, clients] = await Promise.all([
          readInvoiceSources(read, db, orgId, matterId, matter, org),
          readClients(read, db, orgId, matter),
        ]);
        const build = buildInvoice(draftFields(invoice, org.paymentTermsDays), sources);
        if (build.problem) throw new DomainError('FAILED_PRECONDITION', build.problem);
        const changes = draftChanges(
          {
            lines: (invoice['lines'] ?? []) as InvoiceLine[],
            itemisation: invoice['itemisation'] as InvoiceItem[] | undefined,
            totalCents: Number(invoice['totalCents']),
            timeEntryIds: (invoice['timeEntryIds'] ?? []) as string[],
            disbursementIds: (invoice['disbursementIds'] ?? []) as string[],
          },
          build,
        );
        if (changes.stale) {
          throw new DomainError(
            'FAILED_PRECONDITION',
            'This pre-bill changed since it was saved. Review it and save it again before issuing.',
            { reason: 'stale_draft', changed: changes.changed.slice(0, 50), added: changes.added.slice(0, 50) },
          );
        }

        // The counter last: the reads above don't hold it, and nothing below can fail.
        const counter = await tx.get(counterRef);
        const seq = typeof counter.get('next') === 'number' ? (counter.get('next') as number) : 1;
        const number = formatInvoiceNumber(org.invoicePrefix, seq);
        const now = clock.now();
        const issueDate = today(org.timeZone, now);
        const meta = stamp(uid, now, requestId);

        tx.set(
          counterRef,
          counter.exists
            ? { next: seq + 1, ...meta }
            : { next: seq + 1, createdAt: now, createdBy: uid, ...meta, schemaVersion: 1 },
          { merge: true },
        );
        tx.update(ref, {
          number,
          status: 'issued',
          issueDate,
          dueDate: invoiceDueDate(issueDate, Number(invoice['paymentTermsDays'] ?? org.paymentTermsDays)),
          matterNumber: matter['number'] ?? FieldValue.delete(),
          matterTitle: matter['title'] ?? FieldValue.delete(),
          gstRegistered: org.gstRegistered,
          supplier: supplierOf(org),
          buyer: buyerOf(clients),
          // BILL-12: the r 42(3) notice, frozen as given, on an invoice to be paid from trust.
          ...(invoice['paidFromTrust'] === true && noticeOn
            ? {
                trustNotice: trustNoticeOf({
                  number,
                  totalCents: build.totalCents,
                  supplierName: supplierOf(org).name,
                  matterNumber: matter['number'] as string | undefined,
                  matterTitle: matter['title'] as string | undefined,
                }),
              }
            : {}),
          issuedAt: now,
          issuedBy: uid,
          pdfStatus: 'pending',
          ...meta,
        });
        const billed = { status: 'billed', invoiceId: ref.id, ...meta };
        for (const id of build.timeEntryIds) tx.update(db.doc(`${matterRef.path}/timeEntries/${id}`), billed);
        for (const id of build.disbursementIds) tx.update(db.doc(`${matterRef.path}/disbursements/${id}`), billed);
        tx.update(matterRef, { lastInvoicedOn: issueDate, ...meta });
        return {
          issued: true,
          number,
          totalCents: build.totalCents as number,
          matter,
          items: build.timeEntryIds.length + build.disbursementIds.length,
        };
      },
      { maxAttempts: MAX_ATTEMPTS },
    );

    if (result.issued && 'matter' in result) {
      await audit(ctx, {
        action: 'invoice.issued',
        entity: { path: ref.path },
        summary: `Invoice ${result.number} issued`,
        data: { number: result.number, totalCents: result.totalCents, items: result.items },
      });
      const issued = (await ref.get()).data() as Parameters<typeof startDocumentPdf>[3];
      await startDocumentPdf(ctx, 'invoice', ref.id, issued, result.matter);
    }
    log.info('invoice issued', { invoiceId: ref.id, number: result.number, repeat: !result.issued });
    return { invoiceId: ref.id, number: result.number, totalCents: result.totalCents };
  },
} satisfies CallableDefinition<typeof IssueInvoiceInput, IssueInvoiceResult>;

export const issue = defineCallable(issueDefinition);
