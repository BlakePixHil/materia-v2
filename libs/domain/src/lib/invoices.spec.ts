import {
  buildInvoice,
  creditNoteLines,
  draftChanges,
  formatCreditNoteNumber,
  formatInvoiceNumber,
  invoiceBalanceCents,
  invoiceBuyer,
  invoiceClientEmails,
  invoiceDueDate,
  invoicePdfData,
  invoicePdfName,
  invoiceTotals,
  CreateCreditNoteInput,
  InvoiceDraftFieldsSchema,
  RetryInvoicePdfInput,
  SendInvoiceInput,
  unitsToHours,
  type InvoiceDisbursementLike,
  type InvoiceEntryLike,
  type InvoiceSources,
} from './invoices';
import { InvoiceLineSchema, type InvoiceLine } from './schemas/org-records';
import { dateOnly } from './values/date-only';

/** Fictional time and disbursements (BILL-07). */
const entry = (id: string, o: Partial<InvoiceEntryLike> = {}): InvoiceEntryLike => ({
  id,
  uid: 'u-lawyer',
  date: '2026-09-01',
  units: 10,
  rateCents: 44_000,
  amountCents: 44_000,
  narrative: `Work ${id}`,
  billable: true,
  status: 'final',
  ...o,
});
const disbursement = (id: string, o: Partial<InvoiceDisbursementLike> = {}): InvoiceDisbursementLike => ({
  id,
  date: '2026-09-02',
  description: 'Probate filing fee',
  payee: 'Supreme Court of Victoria',
  amountExGstCents: 33_310,
  gstCents: 0,
  gstTreatment: 'gst_free',
  status: 'unbilled',
  ...o,
});
const sources = (o: Partial<InvoiceSources> = {}): InvoiceSources => ({
  gstRegistered: true,
  unitMinutes: 6,
  entries: [entry('t1'), entry('t2', { date: '2026-09-05', units: 3, amountCents: 13_200, narrative: '' })],
  disbursements: [
    disbursement('d1'),
    disbursement('d2', { gstTreatment: 'taxable', amountExGstCents: 1_005, gstCents: 101 }),
  ],
  people: { 'u-lawyer': 'Pat Lawyer' },
  ...o,
});
const fields = { paymentTermsDays: 14 };

describe('invoice numbers', () => {
  it('pads to six digits after the org prefix, and credit notes have their own CN- sequence', () => {
    expect(formatInvoiceNumber('INV-', 123)).toBe('INV-000123');
    expect(formatInvoiceNumber('', 7)).toBe('000007');
    expect(formatInvoiceNumber('HA', 1_234_567)).toBe('HA1234567');
    expect(formatCreditNoteNumber(4)).toBe('CN-000004');
  });
});

describe('buildInvoice', () => {
  it('itemises final billable time and unbilled disbursements with GST per line', () => {
    const build = buildInvoice(fields, sources());
    expect(build.lines.map((l) => [l.kind, l.refId, l.amountExGstCents, l.gstCents])).toEqual([
      ['time', 't1', 44_000, 4_400],
      ['time', 't2', 13_200, 1_320],
      ['disbursement', 'd1', 33_310, 0],
      ['disbursement', 'd2', 1_005, 101],
    ]);
    expect(build.lines[0]).toMatchObject({ quantity: 1, unitPriceCents: 44_000, by: 'Pat Lawyer', date: '2026-09-01' });
    expect(build.lines[1]).toMatchObject({ quantity: 0.3, description: 'Professional services' });
    expect(build.lines[2]).toMatchObject({
      gstFree: true,
      description: 'Probate filing fee (Supreme Court of Victoria)',
    });
    expect(build.subtotalCents).toBe(91_515);
    expect(build.gstCents).toBe(5_821);
    expect(build.totalCents).toBe(97_336);
    expect(build.timeEntryIds).toEqual(['t1', 't2']);
    expect(build.disbursementIds).toEqual(['d1', 'd2']);
    expect(build.problem).toBeNull();
    for (const line of build.lines) expect(InvoiceLineSchema.safeParse(line).success).toBe(true);
  });

  it('rounds GST on each line and sums it (the line method), not GST on the subtotal', () => {
    // Three lines of $0.05: 0.5c of GST each rounds up to 1c, so 3c, where 10% of 15c is 2c (rounded).
    const build = buildInvoice(fields, {
      gstRegistered: true,
      entries: [],
      disbursements: [],
    } as InvoiceSources);
    expect(build.lines).toEqual([]);
    const lines = buildInvoice(
      {
        ...fields,
        extraLines: [1, 2, 3].map((n) => ({
          kind: 'fixed_fee' as const,
          description: `Item ${n}`,
          amountExGstCents: 5,
        })),
      },
      { gstRegistered: true, entries: [], disbursements: [] },
    );
    expect(lines.gstCents).toBe(3);
    expect(lines.totalCents).toBe(18);
  });

  it('leaves out drafts, non-billable, billed, deleted and out-of-range items, and what was excluded', () => {
    const build = buildInvoice(
      {
        ...fields,
        from: dateOnly('2026-09-01'),
        to: dateOnly('2026-09-30'),
        excludedTimeEntryIds: ['t2'],
        excludedDisbursementIds: ['d2'],
      },
      sources({
        entries: [
          entry('t1'),
          entry('t2'),
          entry('draft', { status: 'draft' }),
          entry('nb', { billable: false }),
          entry('billed', { status: 'billed', invoiceId: 'inv-0' }),
          entry('gone', { deletedAt: new Date() }),
          entry('old', { date: '2026-08-31' }),
        ],
        disbursements: [disbursement('d1'), disbursement('d2'), disbursement('off', { status: 'written_off' })],
      }),
    );
    expect(build.timeEntryIds).toEqual(['t1']);
    expect(build.disbursementIds).toEqual(['d1']);
    expect(build.available.entries.map((e) => e.id)).toEqual(['t1', 't2']);
    expect(build.available.disbursements.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(build.unapprovedEntries).toBe(1);
    expect(build.warnings).toContain('unapproved_time');
  });

  it('groups time into one "Professional fees" line with an itemisation', () => {
    const build = buildInvoice({ ...fields, grouping: 'summary' }, sources({ disbursements: [] }));
    expect(build.lines).toEqual([
      {
        kind: 'time',
        description: 'Professional fees (itemised in the schedule)',
        quantity: 1.3,
        amountExGstCents: 57_200,
        gstCents: 5_720,
      },
    ]);
    expect(build.itemisation?.map((i) => [i.refId, i.hours, i.amountExGstCents, i.by])).toEqual([
      ['t1', 1, 44_000, 'Pat Lawyer'],
      ['t2', 0.3, 13_200, 'Pat Lawyer'],
    ]);
  });

  it('adds fixed fees and discounts (negative adjustments) with their own GST', () => {
    const build = buildInvoice(
      {
        ...fields,
        extraLines: [
          { kind: 'fixed_fee', description: 'Grant of probate (fixed fee)', amountExGstCents: 250_000 },
          { kind: 'adjustment', description: 'Courtesy discount', amountExGstCents: -10_005 },
        ],
      },
      sources({ entries: [], disbursements: [] }),
    );
    expect(build.lines.map((l) => [l.kind, l.amountExGstCents, l.gstCents])).toEqual([
      ['fixed_fee', 250_000, 25_000],
      ['adjustment', -10_005, -1_001],
    ]);
    expect(build.totalCents).toBe(250_000 + 25_000 - 10_005 - 1_001);
  });

  it('caps a capped matter’s fees across its invoices, leaving disbursements at cost', () => {
    const build = buildInvoice(
      fields,
      sources({ fee: { arrangement: 'capped', capCents: 50_000 }, billedFeesCents: 20_000 }),
    );
    const cap = build.lines.find((l) => l.cap);
    // Fees of $572 against $300 left under the cap: a $272 adjustment.
    expect(cap).toMatchObject({ kind: 'adjustment', amountExGstCents: -27_200, gstCents: -2_720 });
    expect(cap?.description).toBe('Fee cap: fees capped at $500.00');
    expect(build.capAdjustmentCents).toBe(-27_200);
    expect(build.warnings).toContain('cap_applied');
    const fees = build.lines.filter((l) => l.kind !== 'disbursement').reduce((s, l) => s + l.amountExGstCents, 0);
    expect(fees).toBe(30_000);
    // Under the cap: no adjustment.
    expect(
      buildInvoice(fields, sources({ fee: { arrangement: 'capped', capCents: 100_000 } })).capAdjustmentCents,
    ).toBe(0);
    // Not capped: no adjustment.
    expect(buildInvoice(fields, sources({ fee: { arrangement: 'hourly' } })).lines.some((l) => l.cap)).toBe(false);
  });

  it('charges no GST when the firm isn’t registered, passing disbursements on at what was paid', () => {
    const build = buildInvoice(fields, sources({ gstRegistered: false }));
    expect(build.gstCents).toBe(0);
    expect(build.lines.find((l) => l.refId === 'd2')).toMatchObject({ amountExGstCents: 1_106, gstCents: 0 });
    expect(build.totalCents).toBe(44_000 + 13_200 + 33_310 + 1_106);
  });

  it('warns on a zero total and refuses an empty or negative one', () => {
    const zero = buildInvoice(
      {
        ...fields,
        extraLines: [
          { kind: 'fixed_fee', description: 'Fee', amountExGstCents: 1_000 },
          { kind: 'adjustment', description: 'Waived', amountExGstCents: -1_000 },
        ],
      },
      sources({ entries: [], disbursements: [] }),
    );
    expect(zero.totalCents).toBe(0);
    expect(zero.warnings).toContain('zero_total');
    expect(zero.problem).toBeNull();
    expect(buildInvoice(fields, sources({ entries: [], disbursements: [] })).problem).toMatch(/nothing to bill/);
    expect(
      buildInvoice(
        { ...fields, extraLines: [{ kind: 'adjustment', description: 'Too much', amountExGstCents: -1 }] },
        sources({ entries: [], disbursements: [] }),
      ).problem,
    ).toMatch(/negative/);
  });

  it('refuses more items than one invoice holds', () => {
    const many = Array.from({ length: 401 }, (_, i) => entry(`t${i}`));
    const build = buildInvoice(fields, sources({ entries: many, disbursements: [] }));
    expect(build.warnings).toContain('too_many_items');
    expect(build.problem).toMatch(/up to 400/);
  });

  it('leaves the rate off a written-down line (hours × rate is no longer the price)', () => {
    const build = buildInvoice(fields, sources({ entries: [entry('w', { amountCents: 30_000 })], disbursements: [] }));
    expect(build.lines[0]?.unitPriceCents).toBeUndefined();
    expect(build.lines[0]?.amountExGstCents).toBe(30_000);
  });

  it('validates the choices', () => {
    expect(InvoiceDraftFieldsSchema.safeParse({ ...fields, from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
    expect(
      InvoiceDraftFieldsSchema.safeParse({
        ...fields,
        extraLines: [{ kind: 'fixed_fee', description: 'x', amountExGstCents: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe('invoiceTotals and units', () => {
  it('sums lines and converts units to hours', () => {
    expect(invoiceTotals([{ amountExGstCents: 100, gstCents: 10 } as InvoiceLine])).toEqual({
      subtotalCents: 100,
      gstCents: 10,
      totalCents: 110,
    });
    expect(unitsToHours(3)).toBe(0.3);
    expect(unitsToHours(1, 15)).toBe(0.25);
  });
});

describe('draftChanges', () => {
  it('flags items edited, removed or added since the pre-bill was saved', () => {
    const saved = buildInvoice(fields, sources());
    expect(draftChanges(saved, buildInvoice(fields, sources()))).toEqual({ changed: [], added: [], stale: false });

    const now = buildInvoice(
      fields,
      sources({
        entries: [entry('t1', { amountCents: 40_000, narrative: 'Edited' }), entry('t3')],
        disbursements: [disbursement('d1')],
      }),
    );
    const changes = draftChanges(saved, now);
    expect(changes.changed.sort()).toEqual(['d2', 't1', 't2']);
    expect(changes.added).toEqual(['t3']);
    expect(changes.stale).toBe(true);
  });

  it('sees edits behind a summary line', () => {
    const summary = { ...fields, grouping: 'summary' as const };
    const saved = buildInvoice(summary, sources());
    const now = buildInvoice(
      summary,
      sources({ entries: [entry('t1', { narrative: 'Reworded' }), sources().entries[1] as InvoiceEntryLike] }),
    );
    expect(draftChanges(saved, now)).toMatchObject({ changed: ['t1'], stale: true });
  });
});

describe('parties and dates', () => {
  it('names joint clients, takes the first ABN and a postal address, and lists their emails', () => {
    const buyer = invoiceBuyer([
      {
        kind: 'person',
        givenNames: 'Lan',
        familyName: 'Nguyễn',
        emails: [{ address: 'lan@example.com' }],
        addresses: [
          { type: 'residential', line1: '1 Fictional St', suburb: 'Geelong', state: 'VIC', postcode: '3220' },
          { type: 'postal', line1: 'PO Box 9', suburb: 'Geelong', state: 'VIC', postcode: '3220' },
        ],
      },
      {
        kind: 'organisation',
        orgName: 'Wren Trustees Pty Ltd',
        abn: '12345678901',
        emails: [{ address: 'lan@example.com' }],
      },
      { kind: 'person', givenNames: 'Hương', familyName: 'Trần' },
    ]);
    expect(buyer).toEqual({
      name: 'Lan Nguyễn, Wren Trustees Pty Ltd and Hương Trần',
      abn: '12345678901',
      address: 'PO Box 9, Geelong VIC 3220',
    });
    expect(invoiceBuyer([])).toEqual({ name: 'Client' });
    expect(
      invoiceClientEmails([{ emails: [{ address: 'a@example.com' }] }, { emails: [{ address: 'a@example.com' }] }]),
    ).toEqual(['a@example.com']);
  });

  it('adds the payment terms to the issue date', () => {
    expect(invoiceDueDate(dateOnly('2026-12-20'), 14)).toBe('2027-01-03');
  });
});

describe('credit notes', () => {
  const invoice = {
    gstRegistered: true,
    lines: buildInvoice(fields, sources()).lines,
  };

  it('credits every line in full, mirroring the invoice', () => {
    const { lines, problem } = creditNoteLines(invoice, [], { full: true });
    expect(problem).toBeNull();
    expect(lines.map((l) => [l.invoiceLine, l.amountExGstCents, l.gstCents])).toEqual(
      invoice.lines.map((l, i) => [i, l.amountExGstCents, l.gstCents]),
    );
    expect(invoiceTotals(lines)).toEqual(invoiceTotals(invoice.lines));
    // Nothing left after that.
    expect(creditNoteLines(invoice, [{ lines }], { full: true }).problem).toMatch(/Nothing is left/);
  });

  it('credits part of a line with GST on that part, and never more than is left', () => {
    const first = creditNoteLines(invoice, [], { lines: [{ line: 0, amountExGstCents: 10_005 }] });
    expect(first.lines).toEqual([
      expect.objectContaining({ invoiceLine: 0, amountExGstCents: 10_005, gstCents: 1_001, quantity: 1 }),
    ]);
    const rest = creditNoteLines(invoice, [{ lines: first.lines }], { lines: [{ line: 0 }] });
    // The rest of the line, and the rest of its GST: the two notes add up to the line exactly.
    expect(rest.lines[0]).toMatchObject({ amountExGstCents: 33_995, gstCents: 3_399 });
    expect(
      creditNoteLines(invoice, [{ lines: first.lines }], { lines: [{ line: 0, amountExGstCents: 34_000 }] }).problem,
    ).toMatch(/\$339\.95 left/);
    expect(creditNoteLines(invoice, [], { lines: [{ line: 9 }] }).problem).toMatch(/isn’t on this invoice/);
    expect(creditNoteLines(invoice, [], { lines: [{ line: 0 }, { line: 0 }] }).problem).toMatch(/once/);
  });

  it('keeps GST-free lines GST-free', () => {
    const { lines } = creditNoteLines(invoice, [], { lines: [{ line: 2, amountExGstCents: 100 }] });
    expect(lines[0]).toMatchObject({ gstCents: 0, gstFree: true });
  });

  it('works out the balance after credits and payments', () => {
    expect(invoiceBalanceCents({ totalCents: 10_000, creditedCents: 2_500, payments: [{ amountCents: 1_000 }] })).toBe(
      6_500,
    );
  });
});

describe('invoicePdfData', () => {
  const build = buildInvoice(fields, sources());
  const doc = {
    number: 'INV-000042',
    issueDate: '2026-10-06',
    dueDate: '2026-10-20',
    ...build,
    gstRegistered: true,
    supplier: { name: 'Harbour & Vine Legal', abn: '12345678901' },
    buyer: { name: 'Lan Nguyễn', address: '1 Fictional St, Geelong VIC 3220' },
    notes: 'Thank you.',
    paymentTermsDays: 14,
    matterNumber: 'M-2026-0042',
    matterTitle: 'Estate of the late Wren (fictional)',
  };

  it('carries every tax invoice element', () => {
    const data = invoicePdfData(doc);
    expect(data).toMatchObject({
      title: 'Tax invoice',
      number: 'INV-000042',
      issueDate: '6 Oct 2026',
      dueDate: '20 Oct 2026',
      supplierName: 'Harbour & Vine Legal',
      supplierAbn: '12 345 678 901',
      buyerName: 'Lan Nguyễn',
      gst: true,
      anyGstFree: true,
      subtotal: '$915.15',
      gstTotal: '$58.21',
      total: '$973.36',
      gstStatement: 'Total includes GST of $58.21.',
      terms: 'Payment is due within 14 days, by 20 Oct 2026.',
      reference: 'M-2026-0042 · Estate of the late Wren (fictional)',
    });
    expect(data.lines[0]).toEqual({
      date: '1 Sept 2026',
      description: 'Work t1',
      by: 'Pat Lawyer',
      quantity: '1.00 h',
      unitPrice: '$440.00/h',
      amount: '$440.00',
      gst: '$44.00',
      gstFree: false,
    });
    expect(data.lines[2]).toMatchObject({ gst: 'GST-free', gstFree: true, quantity: '1' });
  });

  it('reads "Invoice" without GST for an unregistered firm, and titles credit notes', () => {
    const plain = invoicePdfData({ ...doc, gstRegistered: false });
    expect(plain.title).toBe('Invoice');
    expect(plain.gst).toBe(false);
    expect(plain.gstStatement).toBeUndefined();
    expect(plain.anyGstFree).toBe(false);
    const credit = invoicePdfData(
      { ...doc, number: 'CN-000001' },
      { invoiceNumber: 'INV-000042', reason: 'Overcharged' },
    );
    expect(credit).toMatchObject({ title: 'Adjustment note', creditOf: 'INV-000042', reason: 'Overcharged' });
    expect(credit.terms).toBeUndefined();
    expect(invoicePdfData({ ...doc, paymentTermsDays: 0 }).terms).toBe('Payment is due on receipt.');
    expect(invoicePdfName('invoice', 'INV-000042', true)).toBe('Tax invoice INV-000042');
    expect(invoicePdfName('invoice', 'INV-000042', false)).toBe('Invoice INV-000042');
    expect(invoicePdfName('credit_note', 'CN-000001', false)).toBe('Credit note CN-000001');
  });

  it('includes a summary invoice’s itemisation', () => {
    const summary = buildInvoice({ ...fields, grouping: 'summary' }, sources());
    const data = invoicePdfData({ ...doc, ...summary });
    expect(data.itemisation).toHaveLength(2);
    expect(data.itemisation?.[1]).toMatchObject({ hours: '0.30', amount: '$132.00' });
  });
});

describe('callable inputs', () => {
  const requestId = '00000000-0000-4000-8000-000000000000';
  it('send needs an address and lower-cases them', () => {
    expect(SendInvoiceInput.safeParse({ requestId, invoiceId: 'i', to: [] }).success).toBe(false);
    expect(SendInvoiceInput.parse({ requestId, invoiceId: 'i', to: ['A@Example.com'] }).to).toEqual(['a@example.com']);
  });
  it('a credit note says what it credits', () => {
    expect(CreateCreditNoteInput.safeParse({ requestId, invoiceId: 'i', reason: 'x' }).success).toBe(false);
    expect(CreateCreditNoteInput.safeParse({ requestId, invoiceId: 'i', reason: 'x', full: true }).success).toBe(true);
  });
  it('a PDF retry names one document', () => {
    expect(RetryInvoicePdfInput.safeParse({ requestId }).success).toBe(false);
    expect(RetryInvoicePdfInput.safeParse({ requestId, invoiceId: 'i', creditNoteId: 'c' }).success).toBe(false);
    expect(RetryInvoicePdfInput.safeParse({ requestId, creditNoteId: 'c' }).success).toBe(true);
  });
});
