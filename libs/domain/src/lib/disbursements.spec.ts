import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISBURSEMENT_PRESETS,
  disbursementAmountProblem,
  disbursementAmounts,
  disbursementGst,
  disbursementInvoiceLine,
  disbursementTotals,
  disbursementWipContribution,
  DisbursementCreateInput,
  DisbursementPresetsSchema,
  exGstFromInclusive,
  presetId,
  presetsOrDefault,
  SetDisbursementStatusInput,
} from './disbursements';
import { DisbursementSchema } from './schemas/aliases';

describe('GST derivation (BILL-04)', () => {
  // [entered, ex or inc, treatment, expected ex GST, expected GST]
  const cases: [string, 'ex' | 'inc', number, 'taxable' | 'gst_free' | 'input_taxed', number, number][] = [
    ['taxable ex $100.00', 'ex', 10_000, 'taxable', 10_000, 1_000],
    ['taxable ex $0.01 (GST rounds to 0)', 'ex', 1, 'taxable', 1, 0],
    ['taxable ex $0.04', 'ex', 4, 'taxable', 4, 0],
    ['taxable ex $0.05 (half up to 1c)', 'ex', 5, 'taxable', 5, 1],
    ['taxable ex $0.15 (half up to 2c)', 'ex', 15, 'taxable', 15, 2],
    ['taxable ex $12.34', 'ex', 1_234, 'taxable', 1_234, 123],
    ['taxable ex $12.35 (half up)', 'ex', 1_235, 'taxable', 1_235, 124],
    ['taxable ex $999,999.99', 'ex', 99_999_999, 'taxable', 99_999_999, 10_000_000],
    ['GST-free ex $345.60 (court fee)', 'ex', 34_560, 'gst_free', 34_560, 0],
    ['input-taxed ex $50.00', 'ex', 5_000, 'input_taxed', 5_000, 0],
    ['taxable inc $110.00', 'inc', 11_000, 'taxable', 10_000, 1_000],
    ['taxable inc $0.01', 'inc', 1, 'taxable', 1, 0],
    ['taxable inc $0.06 (5.45c rounds to 5c)', 'inc', 6, 'taxable', 5, 1],
    ['taxable inc $0.11', 'inc', 11, 'taxable', 10, 1],
    ['taxable inc $11.05 (1c remainder sits in the GST)', 'inc', 1_105, 'taxable', 1_005, 100],
    ['taxable inc $11.01', 'inc', 1_101, 'taxable', 1_001, 100],
    ['taxable inc $55.55', 'inc', 5_555, 'taxable', 5_050, 505],
    ['taxable inc $0.17 (15.45c rounds down)', 'inc', 17, 'taxable', 15, 2],
    ['taxable inc $1.65 (exactly 150c)', 'inc', 165, 'taxable', 150, 15],
    ['GST-free inc $42.00', 'inc', 4_200, 'gst_free', 4_200, 0],
    ['input-taxed inc $19.99', 'inc', 1_999, 'input_taxed', 1_999, 0],
    ['taxable inc $1,100,000.00', 'inc', 110_000_000, 'taxable', 100_000_000, 10_000_000],
  ];

  it.each(cases)('%s', (_label, entered, cents, gstTreatment, ex, gst) => {
    const amounts = disbursementAmounts(
      entered === 'ex' ? { amountExGstCents: cents, gstTreatment } : { amountIncGstCents: cents, gstTreatment },
    );
    expect(amounts).toEqual({ amountExGstCents: ex, gstCents: gst });
    if (entered === 'inc') expect(amounts.amountExGstCents + amounts.gstCents).toBe(cents);
    expect(Number.isInteger(amounts.amountExGstCents) && Number.isInteger(amounts.gstCents)).toBe(true);
  });

  it('every inclusive amount up to $20 splits into integers that add back to what was paid', () => {
    for (let inc = 0; inc <= 2_000; inc++) {
      const { amountExGstCents, gstCents } = disbursementAmounts({ amountIncGstCents: inc, gstTreatment: 'taxable' });
      expect(amountExGstCents + gstCents).toBe(inc);
      expect(amountExGstCents).toBe(Math.round((inc / 11) * 10));
      // The remainder is at most a cent away from 10% of the ex-GST part.
      expect(Math.abs(gstCents - disbursementGst(amountExGstCents, 'taxable'))).toBeLessThanOrEqual(1);
    }
  });

  it('exGstFromInclusive leaves GST-free and input-taxed amounts whole', () => {
    expect(exGstFromInclusive(1_234, 'gst_free')).toBe(1_234);
    expect(exGstFromInclusive(1_234, 'input_taxed')).toBe(1_234);
  });

  it('a null inclusive amount means entered excluding GST', () => {
    expect(disbursementAmounts({ amountExGstCents: 2_000, amountIncGstCents: null, gstTreatment: 'taxable' })).toEqual({
      amountExGstCents: 2_000,
      gstCents: 200,
    });
  });

  it('checks entered amounts', () => {
    expect(disbursementAmountProblem(null)).toMatch(/Enter the amount/);
    expect(disbursementAmountProblem(-1)).toMatch(/dollars/);
    expect(disbursementAmountProblem(0)).toMatch(/more than/);
    expect(disbursementAmountProblem(100_000_001)).toMatch(/1,000,000/);
    expect(disbursementAmountProblem(4_250)).toBeNull();
  });
});

describe('WIP and invoices', () => {
  const row = (status: string, ex: number, gst: number, deletedAt?: unknown) => ({
    status,
    amountExGstCents: ex,
    gstCents: gst,
    ...(deletedAt ? { deletedAt } : {}),
  });

  it('unbilled, live disbursements count ex GST; written-off, billed and deleted ones don’t', () => {
    expect(disbursementWipContribution(row('unbilled', 1_000, 100))).toBe(1_000);
    expect(disbursementWipContribution(row('written_off', 1_000, 100))).toBe(0);
    expect(disbursementWipContribution(row('billed', 1_000, 100))).toBe(0);
    expect(disbursementWipContribution(row('unbilled', 1_000, 100, new Date()))).toBe(0);
    expect(disbursementWipContribution({ status: 'unbilled', amountExGstCents: 1.5 })).toBe(0);
    expect(disbursementWipContribution(null)).toBe(0);
  });

  it('totals add the lines’ own GST, never GST on the total', () => {
    const totals = disbursementTotals([
      row('unbilled', 5, 1),
      row('unbilled', 5, 1),
      row('unbilled', 34_560, 0),
      row('written_off', 9_999, 1_000),
      row('unbilled', 1, 0, new Date()),
    ]);
    expect(totals).toEqual({ exGstCents: 34_570, gstCents: 2, incGstCents: 34_572, count: 3 });
  });

  it('builds the BILL-07 invoice line with the disbursement’s own GST', () => {
    expect(
      disbursementInvoiceLine({
        id: 'd-1',
        description: 'Title search',
        payee: 'LANDATA',
        amountExGstCents: 2_000,
        gstCents: 200,
      }),
    ).toEqual({
      kind: 'disbursement',
      refId: 'd-1',
      description: 'Title search (LANDATA)',
      quantity: 1,
      amountExGstCents: 2_000,
      gstCents: 200,
    });
    expect(
      disbursementInvoiceLine({ id: 'd-2', description: 'Courier', payee: '', amountExGstCents: 1, gstCents: 0 })
        .description,
    ).toBe('Courier');
  });
});

describe('presets', () => {
  it('the starting presets are valid, with blank amounts (fees change yearly)', () => {
    expect(DisbursementPresetsSchema.safeParse(DEFAULT_DISBURSEMENT_PRESETS).success).toBe(true);
    expect(DEFAULT_DISBURSEMENT_PRESETS.every((p) => p.defaultAmountCents === undefined)).toBe(true);
    expect(DEFAULT_DISBURSEMENT_PRESETS.find((p) => p.id === 'vsc-grant-filing')?.gstTreatment).toBe('gst_free');
  });

  it('falls back to the starting presets when none are saved or the document is malformed', () => {
    expect(presetsOrDefault(null)).toBe(DEFAULT_DISBURSEMENT_PRESETS);
    expect(presetsOrDefault({ presets: 'nope' })).toBe(DEFAULT_DISBURSEMENT_PRESETS);
    const own = [{ id: 'x', label: 'Photocopying', category: 'other', gstTreatment: 'taxable' }] as const;
    expect(presetsOrDefault({ presets: own })).toEqual(own);
    expect(presetsOrDefault({ presets: [] })).toEqual([]);
  });

  it('rejects duplicate ids and bad amounts', () => {
    const preset = { id: 'a', label: 'A', category: 'other', gstTreatment: 'taxable' };
    expect(DisbursementPresetsSchema.safeParse([preset, preset]).success).toBe(false);
    expect(DisbursementPresetsSchema.safeParse([{ ...preset, defaultAmountCents: 0 }]).success).toBe(false);
    expect(DisbursementPresetsSchema.safeParse([{ ...preset, defaultAmountCents: null }]).success).toBe(true);
  });

  it('makes unique ids from labels', () => {
    expect(presetId('Title search', [])).toBe('title-search');
    expect(presetId('Title search', ['title-search', 'title-search-2'])).toBe('title-search-3');
    expect(presetId('!!!', [])).toBe('preset');
  });
});

describe('schemas', () => {
  it('a client create is unbilled and not yet counted', () => {
    const parsed = DisbursementCreateInput.parse({
      orgId: 'org-1',
      matterId: 'm-1',
      date: '2026-10-01',
      description: 'Death certificate',
      payee: 'BDM',
      amountExGstCents: 3_000,
      gstCents: 0,
      gstTreatment: 'gst_free',
    });
    expect(parsed.status).toBe('unbilled');
    expect(parsed.wipCountedCents).toBe(0);
    expect(() => DisbursementCreateInput.parse({ ...parsed, status: 'billed' })).toThrow();
    expect(() => DisbursementCreateInput.parse({ ...parsed, invoiceId: 'inv-1' })).toThrow();
  });

  it('the stored shape takes the ticket’s statuses only', () => {
    expect(DisbursementSchema.shape.status.options).toEqual(['unbilled', 'billed', 'written_off']);
  });

  it('setStatus never bills', () => {
    const base = { requestId: crypto.randomUUID(), matterId: 'm-1', disbursementIds: ['d-1'] };
    expect(SetDisbursementStatusInput.safeParse({ ...base, status: 'written_off' }).success).toBe(true);
    expect(SetDisbursementStatusInput.safeParse({ ...base, status: 'billed' }).success).toBe(false);
  });
});
