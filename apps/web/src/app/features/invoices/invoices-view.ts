import type {
  CreditNoteItem,
  DisbursementItem,
  InvoiceItem,
  MatterDetail,
  OrgSettings,
  TimeEntryItem,
  WithId,
} from '@materia/data-access/repository';
import {
  feesOf,
  INVOICE_STATUS_LABELS,
  toDisplay,
  type DateOnly,
  type InvoiceExtraLine,
  type InvoiceSources,
} from '@materia/domain';
import type { MtBadgeTone } from '@materia/ui';

import { dollarsText, parseDollars } from '../settings/money';

/** Statuses whose lines count as billed (not pre-bills, not void). */
export const LIVE_INVOICE_STATUSES: ReadonlySet<string> = new Set(['issued', 'part_paid', 'paid']);

export const INVOICE_STATUS_TONES: Record<string, MtBadgeTone> = {
  draft: 'neutral',
  issued: 'info',
  part_paid: 'warning',
  paid: 'success',
  void: 'neutral',
};

/** An invoice's name in lists: its number, or "Pre-bill" before it's issued. */
export function invoiceName(invoice: Pick<InvoiceItem, 'number' | 'status'>): string {
  return invoice.number || 'Pre-bill';
}

export function invoiceStatusLabel(invoice: Pick<InvoiceItem, 'status'>): string {
  return INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status;
}

/** "1 Oct 2026", or an em dash. */
export function dateText(date: string | null | undefined): string {
  return date ? toDisplay(date as DateOnly) : '—';
}

/**
 * What a pre-bill is built from, as the browser reads it: the same sources `billing-saveDraft`
 * reads on the server (the org's GST registration and unit, the matter's fee and cap, its time and
 * disbursements, who did the work, and the fees already billed less credits), so the preview shows
 * what saving gives.
 */
export function invoiceSourcesFrom(input: {
  org: OrgSettings | null | undefined;
  matter: MatterDetail | null | undefined;
  entries: readonly WithId<TimeEntryItem>[];
  disbursements: readonly WithId<DisbursementItem>[];
  invoices: readonly WithId<InvoiceItem>[];
  creditNotes: readonly CreditNoteItem[];
  people: Readonly<Record<string, string>>;
}): InvoiceSources {
  const live = new Set(input.invoices.filter((i) => LIVE_INVOICE_STATUSES.has(i.status)).map((i) => i.id));
  let billed = 0;
  for (const invoice of input.invoices) if (live.has(invoice.id)) billed += feesOf(invoice.lines);
  for (const note of input.creditNotes) if (live.has(note.invoiceId)) billed -= feesOf(note.lines);
  const unitMinutes = input.org?.billing?.unitMinutes;
  return {
    gstRegistered: input.org?.billing?.gstRegistered !== false,
    ...(unitMinutes ? { unitMinutes } : {}),
    fee: (input.matter?.fee ?? null) as InvoiceSources['fee'],
    entries: input.entries.map((entry) => ({ ...entry, invoiceId: entry.invoiceId ?? null })),
    disbursements: input.disbursements.map((d) => ({ ...d, invoiceId: d.invoiceId ?? null })),
    people: input.people,
    billedFeesCents: billed,
  };
}

/** A fixed fee or discount as the pre-bill edits it: a positive dollar amount. */
export interface ExtraLineForm {
  kind: 'fixed_fee' | 'discount';
  description: string;
  amount: string;
  gstFree: boolean;
}

export function extraLineForm(line: InvoiceExtraLine): ExtraLineForm {
  // The pre-bill only makes fixed fees and discounts (negative adjustments).
  return {
    kind: line.amountExGstCents < 0 ? 'discount' : 'fixed_fee',
    description: line.description,
    amount: dollarsText(Math.abs(line.amountExGstCents)),
    gstFree: !!line.gstFree,
  };
}

/** The lines the form describes, or the first problem. A discount is a negative adjustment. */
export function extraLinesFrom(forms: readonly ExtraLineForm[]): { lines: InvoiceExtraLine[]; error: string | null } {
  const lines: InvoiceExtraLine[] = [];
  for (const form of forms) {
    const what = form.kind === 'fixed_fee' ? 'fixed fee' : 'discount';
    const description = form.description.trim();
    if (!description) return { lines, error: `Describe each ${what}.` };
    const cents = parseDollars(form.amount);
    if (cents === undefined || cents === null || cents === 0) {
      return { lines, error: `Enter an amount in dollars for “${description}”.` };
    }
    lines.push({
      kind: form.kind === 'fixed_fee' ? 'fixed_fee' : 'adjustment',
      description,
      amountExGstCents: (form.kind === 'fixed_fee' ? cents : -cents) as InvoiceExtraLine['amountExGstCents'],
      ...(form.gstFree ? { gstFree: true } : {}),
    });
  }
  return { lines, error: null };
}
