import * as z from 'zod';

import { DocIdSchema, InstantSchema } from './schemas/common';
import { DateOnlySchema } from './values/date-only';
import { CentsSchema } from './values/money';

/**
 * Xero (BILL-09, ADR-053): the practice's Xero organisation, connected once through the OAuth token
 * vault (INT-01). Issued invoices, credit notes and voids go to Xero as receivables (ACCREC);
 * payments made against them in Xero come back as payments. Each direction is one way: Materia
 * never changes an invoice Xero holds except to void it, and Xero never changes a Materia invoice
 * except to add or reverse a payment. Behind `integrations.xero`.
 */

export const XERO_CALLABLES = {
  /** The Xero organisations the connection can reach, and one organisation's accounts. */
  options: 'xero-options',
  saveSettings: 'xero-saveSettings',
  /** Send (or resend) one invoice or credit note, or everything not yet in Xero (the `xero-push` queue sends). */
  send: 'xero-send',
} as const;

/** Xero's Australian tax types on sales: "GST on Income" and "GST Free Income". */
export const XERO_TAX_TYPES = { gst: 'OUTPUT', gstFree: 'EXEMPTOUTPUT' } as const;

/** A Xero tenant (organisation) id: a GUID. */
export const XeroTenantIdSchema = z.string().regex(/^[0-9a-fA-F-]{36}$/, 'A Xero organisation id');

/** A chart-of-accounts code ("200"). */
export const XeroAccountCodeSchema = z
  .string()
  .trim()
  .min(1, 'Choose an account')
  .max(10)
  .regex(/^[A-Za-z0-9.\-_]+$/, 'A Xero account code');

/**
 * `orgs/{orgId}.xero`: which Xero organisation, and where invoice lines go in its chart of
 * accounts. Written only by `xero-saveSettings` (owners and admins). Kept when Xero is
 * disconnected, so reconnecting needs no setup.
 */
export const XeroSettingsSchema = z.object({
  tenantId: XeroTenantIdSchema,
  tenantName: z.string().max(200),
  /** Professional fees, fixed fees and adjustments. */
  feesAccountCode: XeroAccountCodeSchema,
  /** Disbursements recovered from the client. */
  disbursementsAccountCode: XeroAccountCodeSchema,
  /** Send each invoice, credit note and void as it happens. Off: only "Send to Xero" sends. */
  autoPush: z.boolean(),
  /** Invoices issued before this date stay out of Xero unless someone sends them. */
  sendFrom: DateOnlySchema,
});
export type XeroSettings = z.infer<typeof XeroSettingsSchema>;

/** What Settings → Integrations saves; the organisation's name comes from Xero. */
export const XeroSettingsInput = XeroSettingsSchema.omit({ tenantName: true });
export type XeroSettingsInput = z.infer<typeof XeroSettingsInput>;

export const SaveXeroSettingsInput = z.object({ requestId: z.uuid(), settings: XeroSettingsInput });
export type SaveXeroSettingsInput = z.input<typeof SaveXeroSettingsInput>;

export interface SaveXeroSettingsResult {
  saved: boolean;
  /** Invoices issued since `sendFrom` that aren't in Xero yet (the Integrations page offers to send them). */
  unsent: number;
}

export const XeroOptionsInput = z.object({ requestId: z.uuid(), tenantId: XeroTenantIdSchema.optional() });
export type XeroOptionsInput = z.input<typeof XeroOptionsInput>;

export interface XeroTenant {
  tenantId: string;
  tenantName: string;
}

export interface XeroAccount {
  code: string;
  name: string;
  /** Xero's account class: REVENUE, LIABILITY, ASSET, EXPENSE, EQUITY. */
  class: string;
}

export interface XeroOptionsResult {
  tenants: XeroTenant[];
  /** The organisation `accounts` belong to: the one asked for, else the saved one, else the only one. */
  tenantId: string | null;
  /** Its active accounts by code, bank accounts left out. */
  accounts: XeroAccount[];
}

/** One invoice or credit note, or (neither) everything issued since `sendFrom` that isn't in Xero. */
export const SendToXeroInput = z
  .object({
    requestId: z.uuid(),
    invoiceId: DocIdSchema.optional(),
    creditNoteId: DocIdSchema.optional(),
  })
  .refine((input) => !(input.invoiceId && input.creditNoteId), { message: 'One invoice or one credit note' });
export type SendToXeroInput = z.input<typeof SendToXeroInput>;

export interface SendToXeroResult {
  queued: number;
}

/** Where an invoice or credit note stands with Xero. */
export const XeroSyncStatusSchema = z.enum(['queued', 'synced', 'failed', 'conflict']);
export type XeroSyncStatus = z.infer<typeof XeroSyncStatusSchema>;

/**
 * Why it isn't in Xero: not connected (or no organisation chosen), Xero refused it (an account
 * code, a locked period), its number is already used in Xero by something else, or Xero kept
 * failing.
 */
export const XeroSyncErrorSchema = z.enum(['not_connected', 'rejected', 'number_taken', 'unavailable']);
export type XeroSyncError = z.infer<typeof XeroSyncErrorSchema>;

/** A payment Xero holds against the invoice that Materia couldn't record, and why. */
export const XeroUnrecordedPaymentSchema = z.object({
  /** Xero's PaymentID. */
  id: z.string().max(64),
  date: DateOnlySchema,
  amountCents: CentsSchema,
  reason: z.string().max(300),
});
export type XeroUnrecordedPayment = z.infer<typeof XeroUnrecordedPaymentSchema>;

export const XERO_UNRECORDED_MAX = 20;

/**
 * `invoices/{id}.xero` and `creditNotes/{id}.xero` (BILL-09): the document's copy in Xero. Written
 * only by the Xero functions. `id` is Xero's InvoiceID or CreditNoteID in `tenantId`; a document
 * sent to another organisation counts as not sent there.
 */
export const XeroSyncSchema = z.object({
  status: XeroSyncStatusSchema,
  tenantId: z.string().max(64).optional(),
  id: z.string().max(64).optional(),
  contactId: z.string().max(64).optional(),
  queuedAt: InstantSchema.optional(),
  syncedAt: InstantSchema.optional(),
  /** Invoices: the void reached Xero. */
  voidedAt: InstantSchema.optional(),
  /** Credit notes: allocated against the invoice in Xero. */
  allocatedAt: InstantSchema.optional(),
  error: z.object({ code: XeroSyncErrorSchema, message: z.string().max(500), at: InstantSchema }).optional(),
  /** Invoices: Xero's payments Materia couldn't record (it would overpay, or the invoice is void). */
  unrecordedPayments: z.array(XeroUnrecordedPaymentSchema).max(XERO_UNRECORDED_MAX).optional(),
});
export type XeroSync = z.infer<typeof XeroSyncSchema>;

/** `integrationStatus/xero.sync`: when payments were last fetched, and from when the next fetch asks. */
export const XeroPullStateSchema = z.object({
  paymentsCheckedAt: InstantSchema.optional(),
  /** Xero's If-Modified-Since for the next fetch: the latest payment update seen. */
  paymentsCursor: InstantSchema.optional(),
});
export type XeroPullState = z.infer<typeof XeroPullStateSchema>;

/** How far back the first payment fetch looks (BILL-09: invoices synced in the last 180 days). */
export const XERO_PAYMENTS_LOOKBACK_DAYS = 180;

/** Two payments look like the same money: the same amount, dated within a week of each other. */
export const XERO_DUPLICATE_WINDOW_DAYS = 7;

export const XERO_SYNC_ERROR_COPY: Record<XeroSyncError, string> = {
  not_connected: 'Xero isn’t connected, or no Xero organisation is chosen. An owner or admin can fix it in Settings.',
  rejected: 'Xero didn’t accept it.',
  number_taken: 'Xero already has a different document with this number, so Materia left it alone.',
  unavailable: 'Xero didn’t respond. Try again later.',
};

/** A short label for the document's Xero state, for chips and lists. */
export function xeroSyncLabel(sync: Pick<XeroSync, 'status'> | null | undefined): string {
  switch (sync?.status) {
    case 'synced':
      return 'In Xero';
    case 'queued':
      return 'Sending to Xero';
    case 'failed':
    case 'conflict':
      return 'Not in Xero';
    default:
      return 'Not sent to Xero';
  }
}

/** Opens the document in Xero (in whichever organisation the person last used there). */
export function xeroDocumentUrl(kind: 'invoice' | 'creditNote', id: string): string {
  return kind === 'invoice'
    ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(id)}`
    : `https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(id)}`;
}
