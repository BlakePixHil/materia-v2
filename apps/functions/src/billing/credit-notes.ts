import { FieldValue } from 'firebase-admin/firestore';

import {
  CREDIT_NOTE_COUNTER,
  CreateCreditNoteInput,
  CreditNote,
  creditNoteLines,
  DomainError,
  formatCreditNoteNumber,
  INVOICE_CALLABLES,
  invoiceTotals,
  PERMISSIONS,
  today,
  type CreateCreditNoteResult,
  type InvoiceLine,
} from '@materia/domain';

import { startDocumentPdf } from './invoice-pdf';
import { creditNotesPath, existing, invoiceOrg, invoicePath, LIVE_INVOICE_STATUSES } from './invoice-shared';
import { audit } from '../audit/audit';
import { compact, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import { counterPath, liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/**
 * `billing-createCreditNote` (BILL-07; `billing.void`; flag `billing.invoicing`; idempotent):
 * credits all of an issued invoice (`full`) or part of its lines. In one transaction it takes the
 * next `CN-` number from `orgs/{orgId}/counters/credit-note`, writes the credit note (linked to the
 * invoice, with the invoice's supplier and buyer) and adds it to the invoice's `creditNoteIds` and
 * `creditedCents`. A line is never credited beyond what is left of it. The billed time and
 * disbursements stay billed: a credit note reduces what is owed, it doesn't reopen the work (void
 * an unpaid invoice for that). BILL-05's budget counts billed fees less credits
 * (`fees-budgetOnCreditNote`). Then audited (`invoice.credited`) and its PDF rendered.
 */
export const createCreditNoteDefinition = {
  name: INVOICE_CALLABLES.createCreditNote,
  input: CreateCreditNoteInput,
  roles: PERMISSIONS['billing.void'],
  idempotent: true,
  handler: async (ctx): Promise<CreateCreditNoteResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'billing.invoicing');
    const clock = await orgClock(db, orgId, ctx.clock);
    const invoiceRef = db.doc(invoicePath(orgId, input.invoiceId));
    const counterRef = db.doc(counterPath(orgId, CREDIT_NOTE_COUNTER));
    const ref = db.collection(creditNotesPath(orgId)).doc();
    const reason = input.reason.trim();

    const result = await db.runTransaction(
      async (tx) => {
        const invoice = existing(await tx.get(invoiceRef));
        if (!LIVE_INVOICE_STATUSES.has(String(invoice['status']))) {
          throw new DomainError('FAILED_PRECONDITION', 'Only an issued invoice can be credited');
        }
        const matterId = String(invoice['matterId']);
        const [matterSnap, orgSnap, earlier] = await Promise.all([
          tx.get(db.doc(matterPath(orgId, matterId))),
          tx.get(db.doc(`orgs/${orgId}`)),
          tx.get(db.collection(creditNotesPath(orgId)).where('invoiceId', '==', invoiceRef.id)),
        ]);
        const matter = liveMatter(matterSnap, role, matterId);
        const org = invoiceOrg(orgSnap.data());
        const { lines, problem } = creditNoteLines(
          {
            lines: (invoice['lines'] ?? []) as InvoiceLine[],
            gstRegistered: invoice['gstRegistered'] as boolean | undefined,
          },
          earlier.docs.map((doc) => ({ lines: (doc.get('lines') ?? []) as InvoiceLine[] })),
          input.full ? { full: true } : { lines: input.lines },
        );
        if (problem) throw new DomainError('FAILED_PRECONDITION', problem);
        const totals = invoiceTotals(lines);

        const counter = await tx.get(counterRef);
        const seq = typeof counter.get('next') === 'number' ? (counter.get('next') as number) : 1;
        const number = formatCreditNoteNumber(seq);
        const now = clock.now();
        const meta = stamp(uid, now, requestId);
        tx.set(
          counterRef,
          counter.exists
            ? { next: seq + 1, ...meta }
            : { next: seq + 1, createdAt: now, createdBy: uid, ...meta, schemaVersion: 1 },
          { merge: true },
        );
        const note = CreditNote.schema.parse(
          compact({
            number,
            invoiceId: invoiceRef.id,
            invoiceNumber: String(invoice['number']),
            matterId,
            issueDate: today(org.timeZone, now),
            reason,
            full: input.full,
            lines,
            ...totals,
            gstRegistered: invoice['gstRegistered'] as boolean | undefined,
            supplier: invoice['supplier'] as Data | undefined,
            buyer: invoice['buyer'] as Data | undefined,
            pdfStatus: 'pending',
            createdAt: now,
            createdBy: uid,
            ...meta,
            schemaVersion: CreditNote.version,
          }),
        );
        tx.create(ref, note);
        tx.update(invoiceRef, {
          creditNoteIds: FieldValue.arrayUnion(ref.id),
          creditedCents: FieldValue.increment(totals.totalCents),
          ...meta,
        });
        return {
          number,
          totalCents: totals.totalCents as number,
          note,
          matter,
          invoiceNumber: String(invoice['number']),
        };
      },
      { maxAttempts: 25 },
    );

    await audit(ctx, {
      action: 'invoice.credited',
      entity: { path: invoiceRef.path },
      summary: `Credit note ${result.number} against invoice ${result.invoiceNumber}`,
      data: { creditNoteId: ref.id, number: result.number, totalCents: result.totalCents, full: input.full, reason },
    });
    await startDocumentPdf(
      ctx,
      'credit_note',
      ref.id,
      result.note as Parameters<typeof startDocumentPdf>[3],
      result.matter,
    );
    log.info('credit note created', {
      creditNoteId: ref.id,
      invoiceId: invoiceRef.id,
      lines: result.note.lines.length,
    });
    return { creditNoteId: ref.id, number: result.number, totalCents: result.totalCents };
  },
} satisfies CallableDefinition<typeof CreateCreditNoteInput, CreateCreditNoteResult>;

export const createCreditNote = defineCallable(createCreditNoteDefinition);
