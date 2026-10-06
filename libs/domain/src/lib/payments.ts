import * as z from 'zod';

import { centsToDecimal, csvCell } from './billing';
import { DocIdSchema } from './schemas/common';
import {
  AGED_BUCKETS,
  PaymentMethodSchema,
  REMINDER_THRESHOLDS,
  type AgedAmounts,
  type AgedBucket,
  type DebtorRow,
  type PaymentMethod,
  type ReminderThreshold,
} from './schemas/org-records';
import { DateOnlySchema, daysBetween, toDisplay, type DateOnly } from './values/date-only';
import { cents, formatCents, type Cents } from './values/money';

/**
 * Payments, aged debtors and payment reminders (BILL-08, ADR-046). Pure and in integer cents (AUD
 * only, inc GST), shared by the `billing-*` callables, the nightly job, the screens and the tests.
 *
 * What an invoice owes is its total, less its credit notes, less what was paid (payments less
 * refunds). Reversed payments and refunds stay on the invoice for the record but count for
 * nothing. The status follows: `issued` until something is paid, then `part_paid`, then `paid`
 * once nothing is owing.
 */

// ---------- payments ----------

/** A payment or refund as the rules read it (`invoices/{id}.payments[]`). */
export interface PaymentLike {
  id?: string;
  kind?: 'payment' | 'refund' | undefined;
  amountCents: number;
  reversedAt?: unknown;
}

/** What an invoice's money is worked out from. */
export interface InvoiceMoneyLike {
  totalCents: number;
  creditedCents?: number | undefined;
  payments?: readonly PaymentLike[] | undefined;
}

/** A payment or refund that still counts: not reversed. */
export const isLivePayment = (payment: PaymentLike): boolean => !payment.reversedAt;

/** What was paid and not reversed, less refunds. */
export function paidCents(payments: readonly PaymentLike[] | undefined): Cents {
  let total = 0;
  for (const payment of payments ?? []) {
    if (!isLivePayment(payment)) continue;
    total += payment.kind === 'refund' ? -payment.amountCents : payment.amountCents;
  }
  return cents(total);
}

/** What is still owed: the total less credits and what was paid. Negative is credit held for the client. */
export function owingCents(invoice: InvoiceMoneyLike): Cents {
  return cents(invoice.totalCents - (invoice.creditedCents ?? 0) - paidCents(invoice.payments));
}

export type PaidStatus = 'issued' | 'part_paid' | 'paid';

/** An issued invoice's status from its money: nothing paid, part paid, or nothing left owing. */
export function paymentStatus(invoice: InvoiceMoneyLike): PaidStatus {
  if (paidCents(invoice.payments) <= 0) return 'issued';
  return owingCents(invoice) <= 0 ? 'paid' : 'part_paid';
}

/** Statuses that take payments, credit notes and reminders: issued and not void. */
export const PAYABLE_STATUSES: ReadonlySet<string> = new Set(['issued', 'part_paid', 'paid']);

/** Whether an invoice has a payment that still counts (voiding is then refused). */
export const hasLivePayments = (payments: readonly PaymentLike[] | undefined): boolean =>
  (payments ?? []).some((payment) => isLivePayment(payment) && payment.kind !== 'refund');

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  eft: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  trust_transfer: 'From trust',
  other: 'Other',
};

/** The largest single payment or refund: $10,000,000. */
export const PAYMENT_MAX_CENTS = 1_000_000_000;

export type PaymentWarning = 'before_issue';

export const PAYMENT_WARNING_COPY: Record<PaymentWarning, string> = {
  before_issue: 'This payment is dated before the invoice was issued.',
};

/** The invoice fields a payment is checked against. */
export interface PayableInvoiceLike extends InvoiceMoneyLike {
  status: string;
  issueDate?: string | undefined;
}

/** A payment or refund being recorded. */
export interface NewPayment {
  kind: 'payment' | 'refund';
  date: DateOnly;
  amountCents: number;
  /** Lets a payment exceed what's owing; the extra is held as credit. */
  credit?: boolean | undefined;
}

export interface PaymentCheck {
  /** Why it can't be recorded, in words for the person; null when it can. */
  problem: string | null;
  warnings: PaymentWarning[];
  /** What would be owing afterwards (negative is credit held). */
  owingAfterCents: Cents;
  statusAfter: PaidStatus;
}

/**
 * Whether a payment or refund can be recorded against an invoice today. A payment over what's
 * owing is refused unless it's marked as a credit. A refund only returns credit the client holds
 * (paid beyond what's owed, say after a credit note). A payment dated before the invoice is
 * allowed with a warning; one dated after today isn't.
 */
export function checkPayment(invoice: PayableInvoiceLike, payment: NewPayment, todayDate: DateOnly): PaymentCheck {
  const owing = owingCents(invoice);
  const after = [...(invoice.payments ?? []), { kind: payment.kind, amountCents: payment.amountCents }];
  const result = (problem: string | null): PaymentCheck => ({
    problem,
    warnings: invoice.issueDate && payment.date < invoice.issueDate ? ['before_issue'] : [],
    owingAfterCents: problem ? owing : owingCents({ ...invoice, payments: after }),
    statusAfter: problem ? paymentStatus(invoice) : paymentStatus({ ...invoice, payments: after }),
  });
  if (!PAYABLE_STATUSES.has(invoice.status)) return result('Only an issued invoice takes payments');
  if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0) return result('Enter an amount');
  if (payment.date > todayDate) return result('A payment can’t be dated in the future');
  if (payment.kind === 'refund') {
    const held = -owing;
    if (held <= 0) return result('There’s no credit on this invoice to refund');
    if (payment.amountCents > held) return result(`Only ${formatCents(cents(held))} is held in credit to refund`);
    return result(null);
  }
  if (payment.amountCents > owing && !payment.credit) {
    return result(
      owing > 0
        ? `That’s more than the ${formatCents(owing)} owing. Change the amount or keep the extra as a credit.`
        : 'Nothing is owing on this invoice. Keep the payment as a credit, or record it elsewhere.',
    );
  }
  return result(null);
}

/**
 * Whether a payment or refund can be reversed (null when it can; reversing one already reversed is
 * a no-op). Reversing a payment can't leave a refund paying back credit that's no longer there:
 * reverse the refund first.
 */
export function checkReversal(invoice: InvoiceMoneyLike, paymentId: string): string | null {
  const payments = invoice.payments ?? [];
  const target = payments.find((payment) => payment.id === paymentId);
  if (!target) return 'That payment isn’t on this invoice';
  if (!isLivePayment(target) || target.kind === 'refund') return null;
  const after = payments.filter((payment) => payment.id !== paymentId);
  const refunds = after
    .filter((payment) => isLivePayment(payment) && payment.kind === 'refund')
    .reduce((sum, payment) => sum + payment.amountCents, 0);
  if (refunds > 0 && owingCents({ ...invoice, payments: after }) > 0) {
    return 'A refund was made from this money. Reverse the refund first.';
  }
  return null;
}

// ---------- aged debtors ----------

export const AGED_BUCKET_LABELS: Record<AgedBucket, string> = {
  current: 'Not yet due',
  d1_30: '1–30 days',
  d31_60: '31–60 days',
  d61_90: '61–90 days',
  d90_plus: 'Over 90 days',
};

/** Whole days an invoice is past its due date on `asOf` (0 or less is not yet overdue). */
export const daysOverdue = (dueDate: DateOnly, asOf: DateOnly): number => daysBetween(dueDate, asOf);

/** Which bucket an amount due on `dueDate` falls in on `asOf`: due today is not yet overdue. */
export function agedBucket(dueDate: DateOnly, asOf: DateOnly): AgedBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

export function emptyAged(): AgedAmounts {
  return {
    current: cents(0),
    d1_30: cents(0),
    d31_60: cents(0),
    d61_90: cents(0),
    d90_plus: cents(0),
  };
}

/** An issued invoice as the aged-debtors report reads it. */
export interface DebtorInvoiceLike extends PayableInvoiceLike {
  id: string;
  matterId: string;
  matterNumber?: string | undefined;
  matterTitle?: string | undefined;
  buyer?: { name?: string | undefined } | undefined;
  dueDate?: string | undefined;
}

export interface DebtorsReport {
  asOf: DateOnly;
  rows: DebtorRow[];
  totals: AgedAmounts & { totalCents: Cents };
  /** Invoices with something owing. */
  invoices: number;
  /** More matters than `limit`: the rows stop there; the totals count them all. */
  truncated: boolean;
}

/** The most matters one report document holds (`metrics/debtors-{date}` stays well under 1 MB). */
export const DEBTORS_ROWS_MAX = 2000;

/**
 * The aged-debtors report on `asOf`: every live invoice with something owing, by matter, its
 * outstanding amount bucketed by days past due. Rows are sorted by client then matter number;
 * `lawyers` names each matter's responsible lawyer (for "my debtors").
 */
export function debtorsReport(
  invoices: readonly DebtorInvoiceLike[],
  asOf: DateOnly,
  options: { lawyers?: Record<string, string>; limit?: number } = {},
): DebtorsReport {
  const byMatter = new Map<string, DebtorRow>();
  const totals = emptyAged();
  let count = 0;
  for (const invoice of invoices) {
    if (!PAYABLE_STATUSES.has(invoice.status)) continue;
    const owing = owingCents(invoice);
    if (owing <= 0) continue;
    count++;
    const due = (invoice.dueDate ?? invoice.issueDate ?? asOf) as DateOnly;
    const bucket = agedBucket(due, asOf);
    let row = byMatter.get(invoice.matterId);
    if (!row) {
      const lawyerUid = options.lawyers?.[invoice.matterId];
      row = {
        matterId: invoice.matterId,
        matterNumber: invoice.matterNumber ?? '',
        matterTitle: invoice.matterTitle ?? '',
        clientName: invoice.buyer?.name ?? '',
        ...(lawyerUid ? { lawyerUid } : {}),
        invoices: 0,
        buckets: emptyAged(),
        totalCents: cents(0),
      };
      byMatter.set(invoice.matterId, row);
    }
    row.invoices++;
    row.buckets[bucket] = cents(row.buckets[bucket] + owing);
    row.totalCents = cents(row.totalCents + owing);
    if (!row.oldestDueDate || due < row.oldestDueDate) row.oldestDueDate = due;
    totals[bucket] = cents(totals[bucket] + owing);
  }
  const rows = [...byMatter.values()].sort(
    (a, b) => a.clientName.localeCompare(b.clientName, 'en-AU') || a.matterNumber.localeCompare(b.matterNumber),
  );
  const limit = options.limit ?? DEBTORS_ROWS_MAX;
  const totalCents = cents(AGED_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0));
  return {
    asOf,
    rows: rows.slice(0, limit),
    totals: { ...totals, totalCents },
    invoices: count,
    truncated: rows.length > limit,
  };
}

/** The `values` of `metrics/debtors-{date}`: the bucket totals, the total, and how many invoices and matters. */
export function debtorsValues(report: DebtorsReport): Record<string, number> {
  return {
    ...Object.fromEntries(AGED_BUCKETS.map((bucket) => [bucket, report.totals[bucket]])),
    total: report.totals.totalCents,
    invoices: report.invoices,
    matters: report.rows.length,
  };
}

/** The report's period id: `debtors-2026-10-06`. */
export const debtorsPeriod = (asOf: DateOnly): string => `debtors-${asOf}`;

/** Clients with their matters, for the report's "by client" view: each client's rows and subtotal. */
export function debtorsByClient(
  rows: readonly DebtorRow[],
): { clientName: string; rows: DebtorRow[]; buckets: AgedAmounts; totalCents: Cents }[] {
  const groups = new Map<string, { clientName: string; rows: DebtorRow[]; buckets: AgedAmounts; totalCents: Cents }>();
  for (const row of rows) {
    const key = row.clientName || '—';
    let group = groups.get(key);
    if (!group) {
      group = { clientName: row.clientName, rows: [], buckets: emptyAged(), totalCents: cents(0) };
      groups.set(key, group);
    }
    group.rows.push(row);
    for (const bucket of AGED_BUCKETS) group.buckets[bucket] = cents(group.buckets[bucket] + row.buckets[bucket]);
    group.totalCents = cents(group.totalCents + row.totalCents);
  }
  return [...groups.values()];
}

export const DEBTORS_CSV_COLUMNS = [
  'Client',
  'Matter',
  'Matter title',
  'Invoices',
  ...AGED_BUCKETS.map((bucket) => AGED_BUCKET_LABELS[bucket]),
  'Total owing',
  'Oldest due date',
] as const;

/** The report as CSV (CRLF lines, a header row, a totals row), dollars as plain decimals. */
export function debtorsCsv(report: Pick<DebtorsReport, 'rows' | 'totals' | 'asOf'>): string {
  const line = (cells: unknown[]) => cells.map(csvCell).join(',');
  const rows = report.rows.map((row) =>
    line([
      row.clientName,
      row.matterNumber,
      row.matterTitle,
      row.invoices,
      ...AGED_BUCKETS.map((bucket) => centsToDecimal(row.buckets[bucket])),
      centsToDecimal(row.totalCents),
      row.oldestDueDate ?? '',
    ]),
  );
  const total = line([
    `Total as of ${report.asOf}`,
    '',
    '',
    report.rows.reduce((sum, row) => sum + row.invoices, 0),
    ...AGED_BUCKETS.map((bucket) => centsToDecimal(report.totals[bucket])),
    centsToDecimal(report.totals.totalCents),
    '',
  ]);
  return [DEBTORS_CSV_COLUMNS.join(','), ...rows, total].join('\r\n');
}

// ---------- reminders ----------

/** The highest reminder threshold an invoice due on `dueDate` has reached by `asOf`, or null. */
export function reminderThreshold(dueDate: DateOnly, asOf: DateOnly): ReminderThreshold | null {
  const days = daysOverdue(dueDate, asOf);
  let reached: ReminderThreshold | null = null;
  for (const threshold of REMINDER_THRESHOLDS) if (days >= threshold) reached = threshold;
  return reached;
}

/** `invoiceReminders/{invoiceId}-{threshold}`: one reminder per invoice per threshold, so the job never repeats one. */
export const reminderId = (invoiceId: string, threshold: number): string => `${invoiceId}-${threshold}`;

export const REMINDER_STATUS_LABELS: Record<string, string> = {
  pending: 'To send',
  sent: 'Sent',
  dismissed: 'Dismissed',
  cancelled: 'No longer needed',
};

/** What a reminder's default message is drafted from. */
export interface ReminderDraftInput {
  clientName?: string | undefined;
  invoiceNumber: string;
  balanceCents: number;
  dueDate: DateOnly;
  threshold: number;
  lawyerName?: string | undefined;
  firmName?: string | undefined;
}

/**
 * The reminder's default message, which the lawyer reviews and edits before sending. Polite and
 * plain: it states what is owing and since when, and asks the client to pay or get in touch.
 */
export function reminderMessage(input: ReminderDraftInput): string {
  const greeting = input.clientName ? `Dear ${input.clientName},` : 'Hello,';
  const amount = formatCents(cents(input.balanceCents));
  const due = toDisplay(input.dueDate);
  const body =
    input.threshold >= 60
      ? `Our records show that ${amount} on invoice ${input.invoiceNumber}, due ${due}, is now more than 60 days overdue. Please arrange payment, or contact us so we can talk about how to settle it.`
      : input.threshold >= 30
        ? `Our records show that ${amount} on invoice ${input.invoiceNumber}, due ${due}, is now more than 30 days overdue. Please arrange payment at your earliest convenience, or contact us if you have any questions about the invoice.`
        : `Our records show that ${amount} on invoice ${input.invoiceNumber}, due ${due}, is still unpaid. If you’ve already paid, thank you, and please disregard this reminder. Otherwise we’d be grateful if you could arrange payment, or contact us if you have any questions.`;
  const signOff = ['Kind regards,', input.lawyerName, input.firmName].filter(Boolean).join('\n');
  return `${greeting}\n\n${body}\n\n${signOff}`;
}

// ---------- callables ----------

export const PAYMENT_CALLABLES = {
  record: 'billing-recordPayment',
  reverse: 'billing-reversePayment',
  refreshDebtors: 'billing-refreshDebtors',
  sendReminder: 'billing-sendReminder',
  dismissReminder: 'billing-dismissReminder',
} as const;

/**
 * `billing-recordPayment` (`billing.issue`; refunds `billing.void`; flag `billing.invoicing`;
 * idempotent): records a payment received, or a refund of credit held, against an issued invoice.
 */
export const RecordPaymentInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema,
  kind: z.enum(['payment', 'refund']).default('payment'),
  date: DateOnlySchema,
  amountCents: z
    .number()
    .int({ message: 'Enter the amount in dollars and cents' })
    .min(1, { message: 'Enter an amount' })
    .max(PAYMENT_MAX_CENTS, { message: 'Up to $10,000,000 at a time' }),
  method: PaymentMethodSchema,
  reference: z.string().trim().max(100).optional(),
  payer: z.string().trim().max(200).optional(),
  credit: z.boolean().default(false),
});
export type RecordPaymentInput = z.input<typeof RecordPaymentInput>;

export interface RecordPaymentResult {
  paymentId: string;
  status: PaidStatus;
  owingCents: number;
  warnings: PaymentWarning[];
}

/** `billing-reversePayment` (`billing.void`, idempotent): reverses a payment or refund, with why. */
export const ReversePaymentInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  invoiceId: DocIdSchema,
  paymentId: z.string().min(1).max(64),
  reason: z.string().trim().min(1, { message: 'Say why it’s being reversed' }).max(500),
});
export type ReversePaymentInput = z.input<typeof ReversePaymentInput>;

export interface ReversePaymentResult {
  reversed: boolean;
  status: PaidStatus;
  owingCents: number;
}

/** `billing-refreshDebtors` (`billing.view`): works out the aged-debtors report now and saves it as today's. */
export const RefreshDebtorsInput = /* @__PURE__ */ z.object({ requestId: z.uuid() });
export type RefreshDebtorsInput = z.input<typeof RefreshDebtorsInput>;

export interface RefreshDebtorsResult {
  asOf: string;
  invoices: number;
  totalCents: number;
}

/** `billing-sendReminder` (`billing.issue`; lawyers only their own; idempotent): emails a queued reminder as edited. */
export const SendReminderInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  reminderId: DocIdSchema,
  to: z
    .array(z.email().transform((value) => value.toLowerCase()))
    .min(1, { message: 'Add an email address' })
    .max(5),
  message: z.string().trim().min(1, { message: 'Write the message' }).max(4000),
});
export type SendReminderInput = z.input<typeof SendReminderInput>;

export interface SendReminderResult {
  sent: number;
}

/** `billing-dismissReminder` (`billing.issue`; lawyers only their own): drops a queued reminder unsent. */
export const DismissReminderInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  reminderId: DocIdSchema,
  reason: z.string().trim().max(500).optional(),
});
export type DismissReminderInput = z.input<typeof DismissReminderInput>;
