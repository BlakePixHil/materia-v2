import * as z from 'zod';

import {
  CreditNote,
  INVOICE_CALLABLES,
  Invoice,
  type CreateCreditNoteInput,
  type CreateCreditNoteResult,
  type DeleteInvoiceDraftInput,
  type IssueInvoiceInput,
  type IssueInvoiceResult,
  type RetryInvoicePdfInput,
  type RetryInvoicePdfResult,
  type SaveInvoiceDraftInput,
  type SaveInvoiceDraftResult,
  type SendInvoiceInput,
  type SendInvoiceResult,
  type SetPaidFromTrustInput,
  type SetPaidFromTrustResult,
  type VoidInvoiceInput,
  type VoidInvoiceResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const invoice = Invoice.schema.shape;

/** An invoice or pre-bill as the billing screens read it (BILL-07). Other fields are dropped, not rejected. */
export const InvoiceItemSchema = /* @__PURE__ */ z.object({
  number: invoice.number,
  matterId: invoice.matterId,
  matterNumber: invoice.matterNumber,
  matterTitle: invoice.matterTitle,
  from: invoice.from,
  to: invoice.to,
  grouping: invoice.grouping,
  excludedTimeEntryIds: invoice.excludedTimeEntryIds,
  excludedDisbursementIds: invoice.excludedDisbursementIds,
  extraLines: invoice.extraLines,
  timeEntryIds: invoice.timeEntryIds,
  disbursementIds: invoice.disbursementIds,
  notes: invoice.notes,
  paymentTermsDays: invoice.paymentTermsDays,
  issueDate: invoice.issueDate,
  dueDate: invoice.dueDate,
  lines: invoice.lines,
  itemisation: invoice.itemisation,
  subtotalCents: invoice.subtotalCents,
  gstCents: invoice.gstCents,
  totalCents: invoice.totalCents,
  gstRegistered: invoice.gstRegistered,
  supplier: invoice.supplier,
  buyer: invoice.buyer,
  status: invoice.status,
  issuedAt: invoice.issuedAt,
  issuedBy: invoice.issuedBy,
  pdfStatus: invoice.pdfStatus,
  pdfJobId: invoice.pdfJobId,
  pdfDocumentId: invoice.pdfDocumentId,
  sentAt: invoice.sentAt,
  sentTo: invoice.sentTo,
  voidedAt: invoice.voidedAt,
  voidReason: invoice.voidReason,
  creditNoteIds: invoice.creditNoteIds,
  creditedCents: invoice.creditedCents,
  payments: invoice.payments,
  paidFromTrust: invoice.paidFromTrust,
  trustNotice: invoice.trustNotice,
  xero: invoice.xero,
  createdAt: invoice.createdAt.optional(),
  createdBy: invoice.createdBy.optional(),
  updatedAt: invoice.updatedAt.optional(),
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

/**
 * The org's invoices and pre-bills (`orgs/{orgId}/invoices`, BILL-07). Read-only: every write goes
 * through `invoiceCallables`. Members with billing.view read them.
 */
export function invoiceRepository(): Repository<InvoiceItem> {
  return repo((orgId) => `orgs/${orgId}/invoices`, { schema: InvoiceItemSchema, version: Invoice.version });
}

/** The newest first (pre-bills, which have no number yet, by when they were started). */
export const INVOICES_QUERY: QuerySpec<InvoiceItem> = { orderBy: [['createdAt', 'desc']], pageSize: 200 };

/** One matter's invoices and pre-bills, newest first. */
export function matterInvoicesQuery(matterId: string): QuerySpec<InvoiceItem> {
  return { where: [['matterId', '==', matterId]], orderBy: [['createdAt', 'desc']], pageSize: 100 };
}

const credit = CreditNote.schema.shape;

/** A credit (adjustment) note as read (BILL-07). */
export const CreditNoteItemSchema = /* @__PURE__ */ z.object({
  number: credit.number,
  invoiceId: credit.invoiceId,
  invoiceNumber: credit.invoiceNumber,
  matterId: credit.matterId,
  issueDate: credit.issueDate,
  reason: credit.reason,
  full: credit.full,
  lines: credit.lines,
  subtotalCents: credit.subtotalCents,
  gstCents: credit.gstCents,
  totalCents: credit.totalCents,
  gstRegistered: credit.gstRegistered,
  pdfStatus: credit.pdfStatus,
  pdfDocumentId: credit.pdfDocumentId,
  xero: credit.xero,
  createdAt: credit.createdAt.optional(),
});
export type CreditNoteItem = z.infer<typeof CreditNoteItemSchema>;

/** The org's credit notes (`orgs/{orgId}/creditNotes`, BILL-07). Read-only. */
export function creditNoteRepository(): Repository<CreditNoteItem> {
  return repo((orgId) => `orgs/${orgId}/creditNotes`, { schema: CreditNoteItemSchema, version: CreditNote.version });
}

/** An invoice's credit notes, oldest first. */
export function invoiceCreditNotesQuery(invoiceId: string): QuerySpec<CreditNoteItem> {
  return { where: [['invoiceId', '==', invoiceId]], orderBy: [['createdAt', 'asc']], pageSize: 100 };
}

// ---------- callables ----------

type Input<T> = Omit<T, 'requestId'>;
type Options = { requestId?: string };

/** The `billing-*` invoice callables (BILL-07). */
export interface InvoiceCallables {
  /** `billing-saveDraft`: creates or saves a pre-bill; the server builds its lines. */
  saveDraft(input: Input<SaveInvoiceDraftInput>, options?: Options): Promise<SaveInvoiceDraftResult>;
  /** `billing-deleteDraft`: deletes a pre-bill. */
  deleteDraft(input: Input<DeleteInvoiceDraftInput>, options?: Options): Promise<{ deleted: boolean }>;
  /** `billing-issueInvoice` (lawyers and above): numbers and freezes a pre-bill. */
  issue(input: Input<IssueInvoiceInput>, options?: Options): Promise<IssueInvoiceResult>;
  /** `billing-sendInvoice`: emails the PDF. Never automatic. */
  send(input: Input<SendInvoiceInput>, options?: Options): Promise<SendInvoiceResult>;
  /** `billing-voidInvoice` (owners and admins): voids an unpaid invoice; its work returns to WIP. */
  void(input: Input<VoidInvoiceInput>, options?: Options): Promise<VoidInvoiceResult>;
  /** `billing-createCreditNote` (owners and admins): credits all or part of an invoice. */
  createCreditNote(input: Input<CreateCreditNoteInput>, options?: Options): Promise<CreateCreditNoteResult>;
  /** `billing-retryPdf`: renders a failed PDF again. */
  retryPdf(input: Input<RetryInvoicePdfInput>, options?: Options): Promise<RetryInvoicePdfResult>;
  /** `billing-setPaidFromTrust` (BILL-12): marks a pre-bill or invoice "To be paid from trust", or clears it. */
  setPaidFromTrust(input: Input<SetPaidFromTrustInput>, options?: Options): Promise<SetPaidFromTrustResult>;
}

export function invoiceCallables(client: Pick<CallableClient, 'call'>): InvoiceCallables {
  const call =
    <I extends object, O>(name: string) =>
    (input: I, options: Options = {}) =>
      client.call<I, O>(name, input, { idempotent: true, ...options });
  return {
    saveDraft: call(INVOICE_CALLABLES.saveDraft),
    deleteDraft: call(INVOICE_CALLABLES.deleteDraft),
    issue: call(INVOICE_CALLABLES.issue),
    send: call(INVOICE_CALLABLES.send),
    void: call(INVOICE_CALLABLES.void),
    createCreditNote: call(INVOICE_CALLABLES.createCreditNote),
    retryPdf: call(INVOICE_CALLABLES.retryPdf),
    setPaidFromTrust: call(INVOICE_CALLABLES.setPaidFromTrust),
  };
}
