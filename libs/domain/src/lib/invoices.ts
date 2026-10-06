import * as z from 'zod';

import { BILLING_UNIT_MINUTES } from './constants';
import { contactDisplayName } from './contacts';
import { disbursementInvoiceLine } from './disbursements';
import { formatAbn } from './org-settings';
import { owingCents, type InvoiceMoneyLike } from './payments';
import { DocIdSchema } from './schemas/common';
import { InvoiceExtraLineSchema, type InvoiceItem, type InvoiceLine, type InvoiceParty } from './schemas/org-records';
import { addDays, DateOnlySchema, toDisplay, type DateOnly } from './values/date-only';
import { cents, formatCents, gstOf, type Cents } from './values/money';

/**
 * Invoicing (BILL-07, ADR-045): building a pre-bill's lines from a matter's unbilled time and
 * disbursements, GST and totals, the fee cap, gapless numbers, credit notes, and what the PDF
 * shows. Pure and in integer cents, so the pre-bill's live preview, the `billing-*` callables and
 * the tests share one set of rules.
 *
 * Rounding (the "line method"): GST is worked out on each line, half away from zero (`gstOf`), and
 * the document's GST is the sum of the lines. That can differ by a cent or two from 10% of the
 * subtotal; we always use the line method, as the ATO allows, so a line's GST never changes when
 * other lines are added or credited.
 */

// ---------- numbers ----------

/** `orgs/{orgId}/counters/invoice` and `…/credit-note`: the gapless sequences. */
export const INVOICE_COUNTER = 'invoice';
export const CREDIT_NOTE_COUNTER = 'credit-note';
export const CREDIT_NOTE_PREFIX = 'CN-';

/** `INV-000123`: the org's prefix (`org.billing.invoicePrefix`) and six digits. */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix.trim()}${String(seq).padStart(6, '0')}`;
}

export function formatCreditNoteNumber(seq: number): string {
  return `${CREDIT_NOTE_PREFIX}${String(seq).padStart(6, '0')}`;
}

// ---------- limits ----------

/** Time entries and disbursements one invoice bills at most (one transaction writes them all). */
export const INVOICE_MAX_ITEMS = 400;
export const INVOICE_EXTRA_LINES_MAX = 50;
export const INVOICE_NOTES_MAX = 2000;
export const INVOICE_SEND_MAX_RECIPIENTS = 5;
export const INVOICE_MESSAGE_MAX = 2000;

// ---------- sources ----------

/** The time entry fields a pre-bill reads (a `TimeEntryItem` fits). */
export interface InvoiceEntryLike {
  id: string;
  uid: string;
  date: string;
  units: number;
  rateCents: number;
  amountCents: number;
  narrative: string;
  billable: boolean;
  status: string;
  invoiceId?: string | null | undefined;
  deletedAt?: unknown;
  writeDown?: unknown;
}

/** The disbursement fields a pre-bill reads (a `DisbursementItem` fits). */
export interface InvoiceDisbursementLike {
  id: string;
  date: string;
  description: string;
  payee?: string | undefined;
  amountExGstCents: number;
  gstCents: number;
  gstTreatment: string;
  status: string;
  invoiceId?: string | null | undefined;
  deletedAt?: unknown;
}

/** The matter's fee terms the cap reads (BILL-05). */
export interface InvoiceFeeLike {
  arrangement?: string | undefined;
  amountCents?: number | undefined;
  capCents?: number | undefined;
}

/** What a pre-bill is built from. */
export interface InvoiceSources {
  gstRegistered: boolean;
  unitMinutes?: number | undefined;
  fee?: InvoiceFeeLike | null | undefined;
  entries: readonly InvoiceEntryLike[];
  disbursements: readonly InvoiceDisbursementLike[];
  /** Display names by uid, for "who did the work". */
  people?: Readonly<Record<string, string>>;
  /** Professional fees (ex GST) already billed on the matter, less credits: what the cap has used. */
  billedFeesCents?: number;
}

/** What the person chooses on a pre-bill. */
export const InvoiceDraftFieldsSchema = /* @__PURE__ */ z
  .object({
    from: DateOnlySchema.optional(),
    to: DateOnlySchema.optional(),
    grouping: z.enum(['itemised', 'summary']).default('itemised'),
    excludedTimeEntryIds: z.array(DocIdSchema).max(2000).default([]),
    excludedDisbursementIds: z.array(DocIdSchema).max(2000).default([]),
    extraLines: z.array(InvoiceExtraLineSchema).max(INVOICE_EXTRA_LINES_MAX).default([]),
    notes: z.string().max(INVOICE_NOTES_MAX).default(''),
    paymentTermsDays: z.number().int().min(0).max(365),
    /** "To be paid from trust" (BILL-12): the intention only; no money moves. */
    paidFromTrust: z.boolean().optional(),
  })
  .refine((fields) => !fields.from || !fields.to || fields.from <= fields.to, {
    message: 'The start date is after the end date',
    path: ['to'],
  })
  .refine((fields) => fields.extraLines.every((line) => line.kind === 'adjustment' || line.amountExGstCents >= 0), {
    message: 'A fixed fee can’t be negative; add a discount instead',
    path: ['extraLines'],
  });
export type InvoiceDraftFields = z.output<typeof InvoiceDraftFieldsSchema>;
export type InvoiceDraftFieldsInput = z.input<typeof InvoiceDraftFieldsSchema>;

const inRange = (date: string, fields: Pick<InvoiceDraftFields, 'from' | 'to'>) =>
  (!fields.from || date >= fields.from) && (!fields.to || date <= fields.to);

/** Final, billable, live time not yet on an invoice: what a pre-bill can bill. */
export function isBillableEntry(entry: InvoiceEntryLike): boolean {
  return !entry.deletedAt && entry.billable === true && entry.status === 'final' && !entry.invoiceId;
}

/** Unbilled, live disbursements not yet on an invoice. */
export function isBillableDisbursement(disbursement: InvoiceDisbursementLike): boolean {
  return !disbursement.deletedAt && disbursement.status === 'unbilled' && !disbursement.invoiceId;
}

/** Hours for a number of billing units, to two places: 3 six-minute units are 0.3 h. */
export function unitsToHours(units: number, unitMinutes: number = BILLING_UNIT_MINUTES): number {
  return Math.round((units * unitMinutes * 100) / 60) / 100;
}

// ---------- building ----------

export type InvoiceWarning = 'zero_total' | 'unapproved_time' | 'cap_applied' | 'too_many_items';

export interface InvoiceBuild {
  lines: InvoiceLine[];
  itemisation?: InvoiceItem[];
  subtotalCents: Cents;
  gstCents: Cents;
  totalCents: Cents;
  timeEntryIds: string[];
  disbursementIds: string[];
  /** Billable time and disbursements in the date range, included or not (the pre-bill's checklist). */
  available: { entries: InvoiceEntryLike[]; disbursements: InvoiceDisbursementLike[] };
  /** Draft (unapproved) billable time in the range: it needs approving before it can be billed. */
  unapprovedEntries: number;
  /** The fee-cap adjustment applied (negative), or 0. */
  capAdjustmentCents: Cents;
  warnings: InvoiceWarning[];
  /** A problem that stops the invoice being issued. */
  problem: string | null;
}

const byDate = <T extends { date: string; id: string }>(a: T, b: T) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The GST on a line the firm charges GST on: none when not registered or the line is GST-free. */
function lineGst(amountExGstCents: number, gstRegistered: boolean, gstFree: boolean | undefined): Cents {
  return gstRegistered && !gstFree ? gstOf(cents(amountExGstCents)) : cents(0);
}

const FEE_KINDS = new Set<InvoiceLine['kind']>(['time', 'fixed_fee', 'adjustment']);

/** Subtotal, GST (the sum of the lines' GST) and total. */
export function invoiceTotals(lines: readonly Pick<InvoiceLine, 'amountExGstCents' | 'gstCents'>[]): {
  subtotalCents: Cents;
  gstCents: Cents;
  totalCents: Cents;
} {
  let subtotal = 0;
  let gst = 0;
  for (const line of lines) {
    subtotal += line.amountExGstCents;
    gst += line.gstCents;
  }
  return { subtotalCents: cents(subtotal), gstCents: cents(gst), totalCents: cents(subtotal + gst) };
}

/** The professional fees on lines (time, fixed fees and adjustments, ex GST): what a cap limits. */
export function feesOf(lines: readonly Pick<InvoiceLine, 'kind' | 'amountExGstCents'>[]): Cents {
  return cents(lines.reduce((sum, line) => sum + (FEE_KINDS.has(line.kind) ? line.amountExGstCents : 0), 0));
}

/**
 * A pre-bill's lines from the matter's current time and disbursements and the person's choices:
 *
 * - time: final, billable entries in the range, less those left out; one line each (`itemised`,
 *   with hours, the rate and who did it) or one "Professional fees" line with the entries as its
 *   itemisation (`summary`);
 * - disbursements: unbilled ones in the range, less those left out, each keeping its own GST
 *   (`disbursementInvoiceLine`). A firm not registered for GST charges no GST, so it passes on
 *   what it paid, GST included, as the amount;
 * - the fixed-fee and adjustment lines the person added (a discount is a negative adjustment);
 * - on a capped matter, an adjustment that keeps the fees billed so far plus these within the cap.
 */
export function buildInvoice(fields: InvoiceDraftFieldsInput, sources: InvoiceSources): InvoiceBuild {
  const choice = InvoiceDraftFieldsSchema.parse(fields);
  const unitMinutes = sources.unitMinutes ?? BILLING_UNIT_MINUTES;
  const registered = sources.gstRegistered;
  const excludedTime = new Set(choice.excludedTimeEntryIds);
  const excludedDisbursements = new Set(choice.excludedDisbursementIds);

  const availableEntries = sources.entries
    .filter((entry) => isBillableEntry(entry) && inRange(entry.date, choice))
    .sort(byDate);
  const availableDisbursements = sources.disbursements
    .filter((d) => isBillableDisbursement(d) && inRange(d.date, choice))
    .sort(byDate);
  const unapprovedEntries = sources.entries.filter(
    (entry) =>
      !entry.deletedAt && entry.billable && entry.status === 'draft' && !entry.invoiceId && inRange(entry.date, choice),
  ).length;
  const entries = availableEntries.filter((entry) => !excludedTime.has(entry.id));
  const disbursements = availableDisbursements.filter((d) => !excludedDisbursements.has(d.id));

  const lines: InvoiceLine[] = [];
  let itemisation: InvoiceItem[] | undefined;
  const who = (uid: string) => sources.people?.[uid];
  if (choice.grouping === 'summary') {
    if (entries.length) {
      itemisation = entries.map((entry) => ({
        refId: entry.id,
        date: entry.date as DateOnly,
        ...(who(entry.uid) ? { by: who(entry.uid) } : {}),
        description: entry.narrative.trim() || 'Professional services',
        hours: unitsToHours(entry.units, unitMinutes),
        amountExGstCents: cents(entry.amountCents),
      }));
      const amount = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
      const hours = Math.round(itemisation.reduce((sum, item) => sum + item.hours * 100, 0)) / 100;
      lines.push({
        kind: 'time',
        description: 'Professional fees (itemised in the schedule)',
        quantity: hours,
        amountExGstCents: cents(amount),
        gstCents: lineGst(amount, registered, false),
      });
    }
  } else {
    for (const entry of entries) {
      const quantity = unitsToHours(entry.units, unitMinutes);
      // A write-down bills less than hours × rate, so the rate isn't the line's price then.
      const atRate = Math.round((entry.units * unitMinutes * entry.rateCents) / 60) === entry.amountCents;
      const person = who(entry.uid);
      lines.push({
        kind: 'time',
        refId: entry.id,
        description: entry.narrative.trim() || 'Professional services',
        quantity,
        ...(atRate ? { unitPriceCents: cents(entry.rateCents) } : {}),
        amountExGstCents: cents(entry.amountCents),
        gstCents: lineGst(entry.amountCents, registered, false),
        date: entry.date as DateOnly,
        ...(person ? { by: person } : {}),
      });
    }
  }

  for (const extra of choice.extraLines) {
    lines.push({
      kind: extra.kind,
      description: extra.description.trim(),
      quantity: 1,
      amountExGstCents: cents(extra.amountExGstCents),
      gstCents: lineGst(extra.amountExGstCents, registered, extra.gstFree),
      ...(extra.gstFree ? { gstFree: true } : {}),
    });
  }

  // The cap (BILL-05) limits professional fees across the matter's invoices; disbursements are
  // passed on at cost and don't count against it.
  let capAdjustment = 0;
  const fee = sources.fee;
  if (fee?.arrangement === 'capped' && typeof fee.capCents === 'number') {
    const remaining = Math.max(0, fee.capCents - Math.max(0, sources.billedFeesCents ?? 0));
    const fees = feesOf(lines);
    if (fees > remaining) {
      capAdjustment = remaining - fees;
      lines.push({
        kind: 'adjustment',
        description: `Fee cap: fees capped at ${formatCents(cents(fee.capCents))}`,
        quantity: 1,
        amountExGstCents: cents(capAdjustment),
        gstCents: lineGst(capAdjustment, registered, false),
        cap: true,
      });
    }
  }

  for (const d of disbursements) {
    const line = disbursementInvoiceLine({
      id: d.id,
      description: d.description,
      ...(d.payee ? { payee: d.payee } : {}),
      amountExGstCents: d.amountExGstCents,
      gstCents: d.gstCents,
    });
    const gstFree = d.gstTreatment !== 'taxable';
    lines.push({
      ...line,
      amountExGstCents: cents(registered ? line.amountExGstCents : line.amountExGstCents + line.gstCents),
      gstCents: cents(registered ? line.gstCents : 0),
      date: d.date as DateOnly,
      ...(gstFree ? { gstFree: true } : {}),
    });
  }

  const totals = invoiceTotals(lines);
  const warnings: InvoiceWarning[] = [];
  if (totals.totalCents === 0) warnings.push('zero_total');
  if (unapprovedEntries) warnings.push('unapproved_time');
  if (capAdjustment) warnings.push('cap_applied');
  const items = entries.length + disbursements.length;
  if (items > INVOICE_MAX_ITEMS) warnings.push('too_many_items');

  let problem: string | null = null;
  if (!lines.length) problem = 'There is nothing to bill: add time, disbursements or a fixed fee';
  else if (totals.totalCents < 0) problem = 'The total can’t be negative';
  else if (items > INVOICE_MAX_ITEMS)
    problem = `One invoice bills up to ${INVOICE_MAX_ITEMS} entries; narrow the dates`;

  return {
    lines,
    ...(itemisation ? { itemisation } : {}),
    ...totals,
    timeEntryIds: entries.map((entry) => entry.id),
    disbursementIds: disbursements.map((d) => d.id),
    available: { entries: availableEntries, disbursements: availableDisbursements },
    unapprovedEntries,
    capAdjustmentCents: cents(capAdjustment),
    warnings,
    problem,
  };
}

/** The warning copy a pre-bill shows. */
export const INVOICE_WARNING_COPY: Record<InvoiceWarning, string> = {
  zero_total: 'This invoice totals $0.00. You can still issue it, for the record.',
  unapproved_time: 'Some time in these dates isn’t approved yet, so it isn’t on this bill.',
  cap_applied: 'The fees pass the matter’s cap, so a cap adjustment brings them back to it.',
  too_many_items: `One invoice bills up to ${INVOICE_MAX_ITEMS} entries. Narrow the dates.`,
};

// ---------- "changed since added" ----------

/** A line's identity for comparing: what it bills and for how much. */
const lineKey = (line: Pick<InvoiceLine, 'kind' | 'refId'>) => `${line.kind}:${line.refId ?? ''}`;
const sameLine = (a: InvoiceLine, b: InvoiceLine) =>
  a.description === b.description &&
  a.quantity === b.quantity &&
  a.amountExGstCents === b.amountExGstCents &&
  a.gstCents === b.gstCents &&
  (a.date ?? '') === (b.date ?? '');

/** A pre-bill's lines as saved, or as built now. */
export interface DraftSnapshot {
  lines: readonly InvoiceLine[];
  itemisation?: readonly InvoiceItem[] | undefined;
  totalCents: number;
  timeEntryIds: readonly string[];
  disbursementIds: readonly string[];
}

export interface DraftChanges {
  /** Items on the saved pre-bill that were edited, unapproved, billed elsewhere or deleted since. */
  changed: string[];
  /** Items that are new since it was saved (billable and in its range). */
  added: string[];
  /** Whether saving it again would change any line or total. */
  stale: boolean;
}

/**
 * What changed between a saved pre-bill and the same choices built from the matter now: the
 * draft shows "changed since added" on those items, and saving it again refreshes the lines.
 * Issuing refuses a pre-bill that is stale, so what was reviewed is what is issued.
 */
export function draftChanges(saved: DraftSnapshot, now: DraftSnapshot): DraftChanges {
  const savedIds = new Set([...saved.timeEntryIds, ...saved.disbursementIds]);
  const nowIds = new Set([...now.timeEntryIds, ...now.disbursementIds]);
  const changed = new Set([...savedIds].filter((id) => !nowIds.has(id)));
  const added = [...nowIds].filter((id) => !savedIds.has(id));

  const nowLines = new Map(now.lines.filter((line) => line.refId).map((line) => [lineKey(line), line]));
  for (const line of saved.lines) {
    if (!line.refId) continue;
    const current = nowLines.get(lineKey(line));
    if (current && !sameLine(line, current)) changed.add(line.refId);
  }
  const nowItems = new Map((now.itemisation ?? []).map((item) => [item.refId, item]));
  for (const item of saved.itemisation ?? []) {
    const current = nowItems.get(item.refId);
    if (
      current &&
      (current.amountExGstCents !== item.amountExGstCents ||
        current.hours !== item.hours ||
        current.description !== item.description ||
        current.date !== item.date)
    )
      changed.add(item.refId);
  }

  const stale =
    changed.size > 0 ||
    added.length > 0 ||
    saved.totalCents !== now.totalCents ||
    saved.lines.length !== now.lines.length ||
    saved.lines.some((line, i) => {
      const other = now.lines[i];
      return !other || lineKey(line) !== lineKey(other) || !sameLine(line, other);
    });
  return { changed: [...changed], added, stale };
}

// ---------- dates and parties ----------

/** The due date: the issue date plus the payment terms. */
export function invoiceDueDate(issueDate: DateOnly, paymentTermsDays: number): DateOnly {
  return addDays(issueDate, paymentTermsDays);
}

/** The contact fields the buyer is read from. */
export interface InvoiceClientLike {
  kind?: 'person' | 'organisation' | undefined;
  givenNames?: string | undefined;
  familyName?: string | undefined;
  preferredName?: string | undefined;
  orgName?: string | undefined;
  abn?: string | undefined;
  emails?: readonly { address: string }[] | undefined;
  addresses?:
    | readonly {
        type?: string;
        line1: string;
        line2?: string | undefined;
        suburb: string;
        state: string;
        postcode: string;
      }[]
    | undefined;
}

/** One line of an address: `1 Fictional St, Geelong VIC 3220`. */
export function addressLine(address: NonNullable<InvoiceClientLike['addresses']>[number]): string {
  return [address.line1, address.line2, `${address.suburb} ${address.state} ${address.postcode}`]
    .filter((part) => part && part.trim())
    .join(', ');
}

/**
 * The buyer: the matter's clients by name (joint clients as "A and B"), the first ABN and the first
 * postal (else any) address among them.
 */
export function invoiceBuyer(clients: readonly InvoiceClientLike[]): InvoiceParty {
  const names = clients.map((client) => contactDisplayName(client as Parameters<typeof contactDisplayName>[0]));
  const name =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'Client');
  const abn = clients.find((client) => client.abn)?.abn;
  const addresses = clients.flatMap((client) => client.addresses ?? []);
  const address = addresses.find((a) => a.type === 'postal') ?? addresses[0];
  return { name, ...(abn ? { abn } : {}), ...(address ? { address: addressLine(address) } : {}) };
}

/** The clients' email addresses (the send dialog's default "To"), without repeats. */
export function invoiceClientEmails(clients: readonly InvoiceClientLike[]): string[] {
  return [...new Set(clients.flatMap((client) => (client.emails ?? []).map((email) => email.address)))];
}

// ---------- credit notes ----------

/** A line credited: the invoice line's index and how much of it (ex GST); the whole line when absent. */
export const CreditLineInputSchema = /* @__PURE__ */ z.object({
  line: z.number().int().min(0),
  amountExGstCents: z.number().int().min(1).optional(),
});
export type CreditLineInput = z.infer<typeof CreditLineInputSchema>;

/** What an invoice line has left to credit, ex GST and GST (earlier credit notes' lines). */
export function creditableLines(
  invoice: { lines: readonly InvoiceLine[] },
  credited: readonly { lines: readonly InvoiceLine[] }[],
): { amountExGstCents: number; gstCents: number }[] {
  const left = invoice.lines.map((line) => ({
    amountExGstCents: line.amountExGstCents as number,
    gstCents: line.gstCents as number,
  }));
  for (const note of credited) {
    for (const line of note.lines) {
      const slot = line.invoiceLine === undefined ? undefined : left[line.invoiceLine];
      if (!slot) continue;
      slot.amountExGstCents -= line.amountExGstCents;
      slot.gstCents -= line.gstCents;
    }
  }
  return left;
}

/**
 * A credit note's lines: every line in full (`full`), or the lines asked for. Only positive
 * lines can be credited (a discount or cap adjustment isn't). A line credited in full credits its
 * own GST, so a full credit note mirrors the invoice exactly; part of a line gets GST on that part.
 */
export function creditNoteLines(
  invoice: { lines: readonly InvoiceLine[]; gstRegistered?: boolean | undefined },
  credited: readonly { lines: readonly InvoiceLine[] }[],
  request: { full: true } | { full?: false; lines: readonly CreditLineInput[] },
): { lines: InvoiceLine[]; problem: string | null } {
  const left = creditableLines(invoice, credited);
  const asked: CreditLineInput[] = request.full
    ? invoice.lines.flatMap((line, i) => ((left[i]?.amountExGstCents ?? 0) > 0 ? [{ line: i }] : []))
    : [...request.lines];
  if (!asked.length) return { lines: [], problem: 'Nothing is left to credit on this invoice' };
  if (new Set(asked.map((a) => a.line)).size !== asked.length) {
    return { lines: [], problem: 'Each line can be credited once per credit note' };
  }
  const lines: InvoiceLine[] = [];
  for (const ask of asked) {
    const line = invoice.lines[ask.line];
    const remaining = left[ask.line];
    if (!line || !remaining) return { lines: [], problem: `Line ${ask.line + 1} isn’t on this invoice` };
    if (remaining.amountExGstCents <= 0) {
      return { lines: [], problem: `Line ${ask.line + 1} has nothing left to credit` };
    }
    const amount = ask.amountExGstCents ?? remaining.amountExGstCents;
    if (amount > remaining.amountExGstCents) {
      return {
        lines: [],
        problem: `Line ${ask.line + 1} has ${formatCents(cents(remaining.amountExGstCents))} left to credit`,
      };
    }
    const whole = amount === remaining.amountExGstCents;
    const gst = whole ? remaining.gstCents : invoice.gstRegistered === false || line.gstFree ? 0 : gstOf(cents(amount));
    lines.push({
      kind: line.kind,
      ...(line.refId ? { refId: line.refId } : {}),
      description: line.description,
      quantity: whole ? line.quantity : 1,
      amountExGstCents: cents(amount),
      gstCents: cents(gst),
      ...(line.gstFree ? { gstFree: true } : {}),
      ...(line.date ? { date: line.date } : {}),
      invoiceLine: ask.line,
    });
  }
  return { lines, problem: null };
}

/** What is still owed on an invoice: its total less credits and payments (`owingCents`, BILL-08). */
export function invoiceBalanceCents(invoice: InvoiceMoneyLike): Cents {
  return owingCents(invoice);
}

// ---------- the PDF ----------

/** What the `invoice` template (apps/jobs/templates/invoice.html) is filled with. */
export interface InvoicePdfData {
  [key: string]: unknown;
  /** "Tax invoice", "Invoice", "Adjustment note" or "Credit note". */
  title: string;
  number: string;
  issueDate: string;
  dueDate?: string;
  reference?: string;
  supplierName: string;
  supplierAbn?: string;
  buyerName: string;
  buyerAbn?: string;
  buyerAddress?: string;
  gst: boolean;
  lines: {
    date: string;
    description: string;
    by?: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    gst: string;
    gstFree: boolean;
  }[];
  anyGstFree: boolean;
  itemisation?: { date: string; by?: string; description: string; hours: string; amount: string }[];
  subtotal: string;
  gstTotal: string;
  total: string;
  /** "Total includes GST of $x" for a GST-registered firm. */
  gstStatement?: string;
  notes?: string;
  terms?: string;
  /** The r 42(3) notice of intended withdrawal from trust (BILL-12), when the invoice carries one. */
  trustNotice?: string;
  /** Credit notes: the invoice credited and why. */
  creditOf?: string;
  reason?: string;
}

/** A stored line or itemisation row as the PDF reads it (amounts as plain integers). */
type Plain<T> = Omit<T, 'amountExGstCents' | 'gstCents' | 'unitPriceCents' | 'date'> & {
  date?: string | undefined;
  amountExGstCents: number;
  gstCents?: number;
  unitPriceCents?: number | undefined;
};

const money = (value: number) => formatCents(cents(value));
const display = (value: string | undefined) => (value ? toDisplay(value as DateOnly) : '');
const hoursText = (value: number) => value.toFixed(2);

/**
 * The PDF's content from an issued invoice or credit note (ATO tax invoice requirements): the
 * words "Tax invoice", the supplier's name and ABN, the issue date, the buyer's identity, each
 * line's description, quantity, price and GST (GST-free lines marked), and the totals. A firm not
 * registered for GST issues an "Invoice" with no GST.
 */
export function invoicePdfData(
  doc: {
    number: string;
    issueDate?: string | undefined;
    dueDate?: string | undefined;
    lines: readonly (Plain<InvoiceLine> & { gstCents: number })[];
    itemisation?: readonly Plain<InvoiceItem>[] | undefined;
    subtotalCents: number;
    gstCents: number;
    totalCents: number;
    gstRegistered?: boolean | undefined;
    supplier?: InvoiceParty | undefined;
    buyer?: InvoiceParty | undefined;
    notes?: string | undefined;
    paymentTermsDays?: number | undefined;
    matterNumber?: string | undefined;
    matterTitle?: string | undefined;
    trustNotice?: { text: string } | undefined;
  },
  credit?: { invoiceNumber: string; reason: string },
): InvoicePdfData {
  const gst = doc.gstRegistered !== false;
  const title = credit ? (gst ? 'Adjustment note' : 'Credit note') : gst ? 'Tax invoice' : 'Invoice';
  const lines = doc.lines.map((line) => ({
    date: display(line.date),
    description: line.description,
    ...(line.by ? { by: line.by } : {}),
    quantity: line.kind === 'time' ? `${hoursText(line.quantity)} h` : String(line.quantity),
    unitPrice:
      line.unitPriceCents !== undefined ? `${money(line.unitPriceCents)}${line.kind === 'time' ? '/h' : ''}` : '',
    amount: money(line.amountExGstCents),
    gst: line.gstFree ? 'GST-free' : money(line.gstCents),
    gstFree: gst && line.gstFree === true,
  }));
  const terms =
    !credit && doc.paymentTermsDays !== undefined
      ? doc.paymentTermsDays === 0
        ? 'Payment is due on receipt.'
        : `Payment is due within ${doc.paymentTermsDays} days${doc.dueDate ? `, by ${display(doc.dueDate)}` : ''}.`
      : undefined;
  return {
    title,
    number: doc.number,
    issueDate: display(doc.issueDate),
    ...(doc.dueDate && !credit ? { dueDate: display(doc.dueDate) } : {}),
    ...(doc.matterNumber
      ? { reference: doc.matterTitle ? `${doc.matterNumber} · ${doc.matterTitle}` : doc.matterNumber }
      : {}),
    supplierName: doc.supplier?.name ?? '',
    ...(doc.supplier?.abn ? { supplierAbn: formatAbn(doc.supplier.abn) } : {}),
    buyerName: doc.buyer?.name ?? '',
    ...(doc.buyer?.abn ? { buyerAbn: formatAbn(doc.buyer.abn) } : {}),
    ...(doc.buyer?.address ? { buyerAddress: doc.buyer.address } : {}),
    gst,
    lines,
    anyGstFree: lines.some((line) => line.gstFree),
    ...(doc.itemisation?.length
      ? {
          itemisation: doc.itemisation.map((item) => ({
            date: display(item.date),
            ...(item.by ? { by: item.by } : {}),
            description: item.description,
            hours: hoursText(item.hours),
            amount: money(item.amountExGstCents),
          })),
        }
      : {}),
    subtotal: money(doc.subtotalCents),
    gstTotal: money(doc.gstCents),
    total: money(doc.totalCents),
    ...(gst ? { gstStatement: `Total includes GST of ${money(doc.gstCents)}.` } : {}),
    ...(doc.notes?.trim() ? { notes: doc.notes.trim() } : {}),
    ...(terms ? { terms } : {}),
    ...(!credit && doc.trustNotice?.text ? { trustNotice: doc.trustNotice.text } : {}),
    ...(credit ? { creditOf: credit.invoiceNumber, reason: credit.reason } : {}),
  };
}

/** The PDF's file name in the matter's documents. */
export function invoicePdfName(kind: 'invoice' | 'credit_note', number: string, gstRegistered: boolean): string {
  if (kind === 'credit_note') return `${gstRegistered ? 'Adjustment note' : 'Credit note'} ${number}`;
  return `${gstRegistered ? 'Tax invoice' : 'Invoice'} ${number}`;
}

// ---------- callables ----------

export const INVOICE_CALLABLES = {
  saveDraft: 'billing-saveDraft',
  deleteDraft: 'billing-deleteDraft',
  issue: 'billing-issueInvoice',
  send: 'billing-sendInvoice',
  void: 'billing-voidInvoice',
  createCreditNote: 'billing-createCreditNote',
  retryPdf: 'billing-retryPdf',
  setPaidFromTrust: 'billing-setPaidFromTrust',
} as const;

/**
 * `billing-saveDraft` (`billing.issue`, flag `billing.invoicing`, idempotent): creates a matter's
 * pre-bill (no `invoiceId`) or saves an existing draft's choices; the server builds the lines from
 * the matter's time and disbursements as they are now. Payment terms default to the org's.
 */
export const SaveInvoiceDraftInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema.optional(),
  matterId: DocIdSchema,
  fields: z
    .object({
      from: DateOnlySchema.optional(),
      to: DateOnlySchema.optional(),
      grouping: z.enum(['itemised', 'summary']).optional(),
      excludedTimeEntryIds: z.array(DocIdSchema).max(2000).optional(),
      excludedDisbursementIds: z.array(DocIdSchema).max(2000).optional(),
      extraLines: z.array(InvoiceExtraLineSchema).max(INVOICE_EXTRA_LINES_MAX).optional(),
      notes: z.string().max(INVOICE_NOTES_MAX).optional(),
      paymentTermsDays: z.number().int().min(0).max(365).optional(),
      paidFromTrust: z.boolean().optional(),
    })
    .default({}),
});
export type SaveInvoiceDraftInput = z.input<typeof SaveInvoiceDraftInput>;

export interface SaveInvoiceDraftResult {
  invoiceId: string;
  totalCents: number;
  warnings: InvoiceWarning[];
}

/** `billing-deleteDraft` (`billing.issue`): deletes a pre-bill. Issued invoices are never deleted. */
export const DeleteInvoiceDraftInput = /* @__PURE__ */ z.object({ requestId: z.uuid(), invoiceId: DocIdSchema });
export type DeleteInvoiceDraftInput = z.input<typeof DeleteInvoiceDraftInput>;

/**
 * `billing-issueInvoice` (`billing.issue`: lawyers and above, idempotent): numbers and freezes a
 * pre-bill in one transaction, marks its time and disbursements billed, then starts the PDF.
 */
export const IssueInvoiceInput = /* @__PURE__ */ z.object({ requestId: z.uuid(), invoiceId: DocIdSchema });
export type IssueInvoiceInput = z.input<typeof IssueInvoiceInput>;

export interface IssueInvoiceResult {
  invoiceId: string;
  number: string;
  totalCents: number;
}

/** `billing-sendInvoice` (`billing.issue`, idempotent): emails the PDF to the addresses given. */
export const SendInvoiceInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema,
  to: z
    .array(z.email().transform((value) => value.toLowerCase()))
    .min(1, { message: 'Add an email address' })
    .max(INVOICE_SEND_MAX_RECIPIENTS),
  message: z.string().max(INVOICE_MESSAGE_MAX).default(''),
});
export type SendInvoiceInput = z.input<typeof SendInvoiceInput>;

export interface SendInvoiceResult {
  sent: number;
}

/** `billing-voidInvoice` (`billing.void`, idempotent): voids an unpaid invoice; its time and disbursements are unbilled again. */
export const VoidInvoiceInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema,
  reason: z.string().trim().min(1, { message: 'Say why it’s being voided' }).max(500),
});
export type VoidInvoiceInput = z.input<typeof VoidInvoiceInput>;

export interface VoidInvoiceResult {
  invoiceId: string;
  /** Time entries and disbursements returned to work in progress. */
  released: number;
}

/** `billing-createCreditNote` (`billing.void`, idempotent): credits all or part of an issued invoice. */
export const CreateCreditNoteInput = /* @__PURE__ */ z
  .object({
    requestId: z.uuid(),
    invoiceId: DocIdSchema,
    reason: z.string().trim().min(1, { message: 'Say why you’re crediting it' }).max(500),
    full: z.boolean().default(false),
    lines: z.array(CreditLineInputSchema).max(500).default([]),
  })
  .refine((input) => input.full || input.lines.length > 0, {
    message: 'Choose what to credit',
    path: ['lines'],
  });
export type CreateCreditNoteInput = z.input<typeof CreateCreditNoteInput>;

export interface CreateCreditNoteResult {
  creditNoteId: string;
  number: string;
  totalCents: number;
}

/** `billing-retryPdf` (`billing.issue`, idempotent): renders an invoice's or credit note's PDF again after a failure. */
export const RetryInvoicePdfInput = /* @__PURE__ */ z
  .object({
    requestId: z.uuid(),
    invoiceId: DocIdSchema.optional(),
    creditNoteId: DocIdSchema.optional(),
  })
  .refine((input) => Boolean(input.invoiceId) !== Boolean(input.creditNoteId), {
    message: 'Name an invoice or a credit note',
  });
export type RetryInvoicePdfInput = z.input<typeof RetryInvoicePdfInput>;

export interface RetryInvoicePdfResult {
  jobId: string;
}

/**
 * `billing-setPaidFromTrust` (BILL-12; `billing.issue`, flag `billing.invoicing`, idempotent):
 * marks a pre-bill or issued invoice "To be paid from trust", or clears it. Only the intention is
 * recorded: nothing is withdrawn, scheduled or authorised. On an issued invoice with
 * `billing.trustNotice` on, the PDF is rendered again with (or without) the r 42(3) notice.
 */
export const SetPaidFromTrustInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema,
  paidFromTrust: z.boolean(),
});
export type SetPaidFromTrustInput = z.input<typeof SetPaidFromTrustInput>;

export interface SetPaidFromTrustResult {
  paidFromTrust: boolean;
  /** Whether the PDF is being rendered again for the notice. */
  pdfRendering: boolean;
}

// ---------- display ----------

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Pre-bill',
  issued: 'Issued',
  part_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};
