import {
  agedBucket,
  checkPayment,
  checkReversal,
  debtorsByClient,
  debtorsCsv,
  debtorsReport,
  debtorsValues,
  hasLivePayments,
  hasTrustPayments,
  owingCents,
  paidCents,
  paymentStatus,
  reminderMessage,
  reminderThreshold,
  RecordPaymentInput,
  TRUST_REFERENCE_PROBLEM,
  type DebtorInvoiceLike,
  type PaymentLike,
} from './payments';
import { dateOnly, type DateOnly } from './values/date-only';

/** BILL-08: payments, aged debtors and reminders. Every client, matter and amount is fictional. */

const d = (value: string): DateOnly => dateOnly(value);
const TODAY = d('2026-10-06');

const invoice = (payments: PaymentLike[] = [], extra: Record<string, unknown> = {}) => ({
  status: 'issued',
  issueDate: '2026-09-01',
  totalCents: 110_000,
  creditedCents: 0,
  payments,
  ...extra,
});
const pay = (id: string, amountCents: number, extra: Partial<PaymentLike> = {}): PaymentLike => ({
  id,
  kind: 'payment',
  amountCents,
  ...extra,
});

describe('payments and status', () => {
  it('moves issued → part paid → paid as payments come in', () => {
    expect(paymentStatus(invoice())).toBe('issued');
    expect(paymentStatus(invoice([pay('p1', 50_000)]))).toBe('part_paid');
    expect(paymentStatus(invoice([pay('p1', 50_000), pay('p2', 60_000)]))).toBe('paid');
    expect(owingCents(invoice([pay('p1', 50_000)]))).toBe(60_000);
  });

  it('ignores reversed payments and counts refunds against what was paid', () => {
    const bounced = invoice([pay('p1', 110_000, { reversedAt: new Date() })]);
    expect(paymentStatus(bounced)).toBe('issued');
    expect(owingCents(bounced)).toBe(110_000);
    expect(hasLivePayments(bounced.payments)).toBe(false);
    const refunded = invoice([pay('p1', 110_000), pay('r1', 20_000, { kind: 'refund' })], { creditedCents: 20_000 });
    expect(paidCents(refunded.payments)).toBe(90_000);
    expect(owingCents(refunded)).toBe(0);
    expect(paymentStatus(refunded)).toBe('paid');
  });

  it('counts credit notes: paid once the rest is credited', () => {
    expect(paymentStatus(invoice([pay('p1', 60_000)], { creditedCents: 50_000 }))).toBe('paid');
    // Fully credited with nothing paid stays issued, owing nothing.
    expect(paymentStatus(invoice([], { creditedCents: 110_000 }))).toBe('issued');
  });
});

describe('checkPayment', () => {
  const payment = (amountCents: number, extra: Record<string, unknown> = {}) => ({
    kind: 'payment' as const,
    date: d('2026-09-20'),
    amountCents,
    ...extra,
  });

  it('allows a part payment and says what is left', () => {
    expect(checkPayment(invoice(), payment(40_000), TODAY)).toEqual({
      problem: null,
      warnings: [],
      owingAfterCents: 70_000,
      statusAfter: 'part_paid',
    });
  });

  it('refuses an overpayment unless it is kept as credit', () => {
    expect(checkPayment(invoice(), payment(120_000), TODAY).problem).toBe(
      'That’s more than the $1,100.00 owing. Change the amount or keep the extra as a credit.',
    );
    const credit = checkPayment(invoice(), payment(120_000, { credit: true }), TODAY);
    expect(credit).toMatchObject({ problem: null, owingAfterCents: -10_000, statusAfter: 'paid' });
    expect(checkPayment(invoice([pay('p1', 110_000)]), payment(1), TODAY).problem).toMatch(/^Nothing is owing/);
  });

  it('warns about a payment dated before the invoice, and refuses one in the future', () => {
    expect(checkPayment(invoice(), payment(100, { date: d('2026-08-31') }), TODAY)).toMatchObject({
      problem: null,
      warnings: ['before_issue'],
    });
    expect(checkPayment(invoice(), payment(100, { date: d('2026-10-07') }), TODAY).problem).toBe(
      'A payment can’t be dated in the future',
    );
  });

  it('refuses drafts and void invoices', () => {
    expect(checkPayment(invoice([], { status: 'void' }), payment(100), TODAY).problem).toBe(
      'Only an issued invoice takes payments',
    );
    expect(checkPayment(invoice([], { status: 'draft' }), payment(100), TODAY).problem).not.toBeNull();
  });

  it('refunds only credit held: after a credit note on a paid invoice', () => {
    const paid = invoice([pay('p1', 110_000)]);
    expect(checkPayment(paid, payment(100, { kind: 'refund' }), TODAY).problem).toBe(
      'There’s no credit on this invoice to refund',
    );
    const credited = { ...paid, creditedCents: 30_000 };
    expect(checkPayment(credited, payment(40_000, { kind: 'refund' }), TODAY).problem).toBe(
      'Only $300.00 is held in credit to refund',
    );
    expect(checkPayment(credited, payment(30_000, { kind: 'refund' }), TODAY)).toMatchObject({
      problem: null,
      owingAfterCents: 0,
      statusAfter: 'paid',
    });
  });
});

describe('checkReversal', () => {
  it('reverses a payment, and is a no-op on one already reversed', () => {
    expect(checkReversal(invoice([pay('p1', 50_000)]), 'p1')).toBeNull();
    expect(checkReversal(invoice([pay('p1', 50_000, { reversedAt: new Date() })]), 'p1')).toBeNull();
    expect(checkReversal(invoice([pay('p1', 50_000)]), 'nope')).toBe('That payment isn’t on this invoice');
  });

  it('asks for the refund to be reversed before the payment it came from', () => {
    const refunded = invoice([pay('p1', 110_000), pay('r1', 30_000, { kind: 'refund' })], { creditedCents: 30_000 });
    expect(checkReversal(refunded, 'p1')).toBe('A refund was made from this money. Reverse the refund first.');
    expect(checkReversal(refunded, 'r1')).toBeNull();
  });
});

describe('aged buckets at the boundaries', () => {
  it.each([
    ['2026-10-07', 'current'],
    ['2026-10-06', 'current'],
    ['2026-10-05', 'd1_30'],
    ['2026-09-06', 'd1_30'],
    ['2026-09-05', 'd31_60'],
    ['2026-08-07', 'd31_60'],
    ['2026-08-06', 'd61_90'],
    ['2026-07-08', 'd61_90'],
    ['2026-07-07', 'd90_plus'],
  ])('due %s is %s on 6 Oct 2026', (due, bucket) => {
    expect(agedBucket(d(due), TODAY)).toBe(bucket);
  });
});

describe('debtorsReport', () => {
  const inv = (id: string, matterId: string, dueDate: string, extra: Partial<DebtorInvoiceLike> = {}) =>
    ({
      id,
      matterId,
      matterNumber: `M-2026-00${matterId.slice(-1)}`,
      matterTitle: `Estate of the late ${matterId === 'm1' ? 'Wren' : 'Finch'}`,
      buyer: { name: matterId === 'm1' ? 'Lan Nguyễn' : 'Ada Finch' },
      status: 'issued',
      issueDate: '2026-06-01',
      dueDate,
      totalCents: 10_000,
      creditedCents: 0,
      payments: [],
      ...extra,
    }) as DebtorInvoiceLike;

  const report = debtorsReport(
    [
      inv('i1', 'm1', '2026-10-10'),
      inv('i2', 'm1', '2026-09-01', { payments: [pay('p1', 4_000)], status: 'part_paid' }),
      inv('i3', 'm2', '2026-06-15'),
      inv('i4', 'm2', '2026-06-15', { status: 'paid', payments: [pay('p2', 10_000)] }),
      inv('i5', 'm2', '2026-06-15', { status: 'void' }),
      inv('i6', 'm2', '2026-06-15', { creditedCents: 10_000 }),
    ],
    TODAY,
    { lawyers: { m1: 'user-lawyer' } },
  );

  it('buckets what is owing by matter, leaving out paid, void and credited invoices', () => {
    expect(report.invoices).toBe(3);
    expect(report.rows).toEqual([
      {
        matterId: 'm2',
        matterNumber: 'M-2026-002',
        matterTitle: 'Estate of the late Finch',
        clientName: 'Ada Finch',
        invoices: 1,
        buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 10_000 },
        totalCents: 10_000,
        oldestDueDate: '2026-06-15',
      },
      {
        matterId: 'm1',
        matterNumber: 'M-2026-001',
        matterTitle: 'Estate of the late Wren',
        clientName: 'Lan Nguyễn',
        lawyerUid: 'user-lawyer',
        invoices: 2,
        buckets: { current: 10_000, d1_30: 0, d31_60: 6_000, d61_90: 0, d90_plus: 0 },
        totalCents: 16_000,
        oldestDueDate: '2026-09-01',
      },
    ]);
    expect(report.totals).toEqual({
      current: 10_000,
      d1_30: 0,
      d31_60: 6_000,
      d61_90: 0,
      d90_plus: 10_000,
      totalCents: 26_000,
    });
    expect(debtorsValues(report)).toEqual({
      current: 10_000,
      d1_30: 0,
      d31_60: 6_000,
      d61_90: 0,
      d90_plus: 10_000,
      total: 26_000,
      invoices: 3,
      matters: 2,
    });
  });

  it('groups by client and caps the rows, keeping the totals whole', () => {
    expect(debtorsByClient(report.rows).map((group) => [group.clientName, group.totalCents])).toEqual([
      ['Ada Finch', 10_000],
      ['Lan Nguyễn', 16_000],
    ]);
    const capped = debtorsReport([inv('i1', 'm1', '2026-10-10'), inv('i3', 'm2', '2026-06-15')], TODAY, { limit: 1 });
    expect(capped).toMatchObject({ truncated: true, totals: { totalCents: 20_000 } });
    expect(capped.rows).toHaveLength(1);
  });

  it('exports CSV with a totals row, defusing formulas', () => {
    const [first] = report.rows;
    if (!first) throw new Error('expected a row');
    const csv = debtorsCsv({ ...report, rows: [{ ...first, clientName: '=HYPERLINK("x")' }] }).split('\r\n');
    expect(csv[0]).toBe(
      'Client,Matter,Matter title,Invoices,Not yet due,1–30 days,31–60 days,61–90 days,Over 90 days,Total owing,Oldest due date',
    );
    expect(csv[1]).toBe(
      `"'=HYPERLINK(""x"")",M-2026-002,Estate of the late Finch,1,0.00,0.00,0.00,0.00,100.00,100.00,2026-06-15`,
    );
    expect(csv[2]).toBe('Total as of 2026-10-06,,,1,100.00,0.00,60.00,0.00,100.00,260.00,');
  });
});

describe('reminders', () => {
  it.each([
    ['2026-09-30', null],
    ['2026-09-29', 7],
    ['2026-09-07', 7],
    ['2026-09-06', 30],
    ['2026-08-08', 30],
    ['2026-08-07', 60],
    ['2026-01-01', 60],
  ])('due %s has reached the %s-day reminder on 6 Oct 2026', (due, threshold) => {
    expect(reminderThreshold(d(due), TODAY)).toBe(threshold);
  });

  it('drafts a plain message the lawyer can edit', () => {
    const text = reminderMessage({
      clientName: 'Lan Nguyễn',
      invoiceNumber: 'INV-000042',
      balanceCents: 60_000,
      dueDate: d('2026-09-01'),
      threshold: 30,
      lawyerName: 'Pat Lawyer',
      firmName: 'Harbour & Vine Legal',
    });
    expect(text).toContain('Dear Lan Nguyễn,');
    expect(text).toContain('$600.00 on invoice INV-000042, due 1 Sept 2026, is now more than 30 days overdue');
    expect(text.endsWith('Kind regards,\nPat Lawyer\nHarbour & Vine Legal')).toBe(true);
    expect(
      reminderMessage({ invoiceNumber: 'INV-1', balanceCents: 1, dueDate: d('2026-09-01'), threshold: 7 }),
    ).toMatch(/^Hello,\n\nOur records show that \$0\.01 on invoice INV-1, due 1 Sept 2026, is still unpaid\./);
  });
});

describe('RecordPaymentInput', () => {
  it('needs a positive whole number of cents and a method', () => {
    const base = { requestId: crypto.randomUUID(), invoiceId: 'i1', date: '2026-10-01', method: 'eft' };
    expect(RecordPaymentInput.safeParse({ ...base, amountCents: 0 }).success).toBe(false);
    expect(RecordPaymentInput.safeParse({ ...base, amountCents: 10.5 }).success).toBe(false);
    expect(RecordPaymentInput.parse({ ...base, amountCents: 100 })).toMatchObject({ kind: 'payment', credit: false });
    expect(RecordPaymentInput.safeParse({ ...base, amountCents: 100, method: 'bitcoin' }).success).toBe(false);
  });

  it('needs the trust system’s reference for a payment from trust (BILL-12)', () => {
    const base = { requestId: crypto.randomUUID(), invoiceId: 'i1', date: '2026-10-01', amountCents: 100 };
    const missing = RecordPaymentInput.safeParse({ ...base, method: 'trust_transfer', reference: '  ' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]).toMatchObject({ message: TRUST_REFERENCE_PROBLEM, path: ['reference'] });
    expect(RecordPaymentInput.parse({ ...base, method: 'trust_transfer', reference: 'TR-0042' })).toMatchObject({
      method: 'trust_transfer',
      reference: 'TR-0042',
    });
  });
});

describe('payments from trust (BILL-12)', () => {
  it('are refused without a reference, and part-paid from trust and part by EFT is two payments', () => {
    const fromTrust = {
      kind: 'payment' as const,
      date: d('2026-10-01'),
      amountCents: 60_000,
      method: 'trust_transfer' as const,
    };
    expect(checkPayment(invoice(), fromTrust, TODAY).problem).toBe(TRUST_REFERENCE_PROBLEM);
    expect(checkPayment(invoice(), { ...fromTrust, reference: 'TR-0042' }, TODAY)).toMatchObject({
      problem: null,
      statusAfter: 'part_paid',
      owingAfterCents: 50_000,
    });
    const rest = { kind: 'payment' as const, date: d('2026-10-02'), amountCents: 50_000, method: 'eft' as const };
    const afterTrust = invoice([pay('p1', 60_000, { method: 'trust_transfer' } as Partial<PaymentLike>)]);
    expect(checkPayment(afterTrust, rest, TODAY)).toMatchObject({ problem: null, statusAfter: 'paid' });
  });

  it('marks an invoice whose trust records may need correcting, even once reversed', () => {
    expect(hasTrustPayments([{ method: 'eft' }])).toBe(false);
    expect(hasTrustPayments([{ method: 'trust_transfer' }])).toBe(true);
    expect(hasTrustPayments(undefined)).toBe(false);
  });
});
