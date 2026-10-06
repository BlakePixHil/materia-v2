import type { InvoiceLine } from '@materia/domain';

import { sameDocument, xeroCreditNoteInput, xeroInvoiceInput, xeroLines } from './mapping';
import { SETTINGS } from './testing';

/** How Materia's invoice lines become Xero lines (BILL-09). Fictional amounts. */

const line = (fields: Partial<InvoiceLine>): InvoiceLine =>
  ({ kind: 'time', description: 'Work', quantity: 1, amountExGstCents: 0, gstCents: 0, ...fields }) as InvoiceLine;

describe('Xero line mapping', () => {
  it('keeps hours at a rate when they multiply out exactly, else bills one unit of the amount', () => {
    const lines = xeroLines(
      [
        line({
          quantity: 1.5,
          unitPriceCents: 44000 as never,
          amountExGstCents: 66000 as never,
          gstCents: 6600 as never,
        }),
        // 0.1 h at $333.33 is $33.333: Materia rounded the line, so Xero gets the rounded amount.
        line({
          quantity: 0.1,
          unitPriceCents: 33333 as never,
          amountExGstCents: 3333 as never,
          gstCents: 333 as never,
        }),
        // More decimal places than Xero takes.
        line({
          quantity: 0.33333,
          unitPriceCents: 30000 as never,
          amountExGstCents: 10000 as never,
          gstCents: 1000 as never,
        }),
        line({ kind: 'fixed_fee', quantity: 1, amountExGstCents: 150000 as never, gstCents: 15000 as never }),
        line({ kind: 'adjustment', quantity: 1, amountExGstCents: -5000 as never, gstCents: -500 as never }),
        line({ kind: 'disbursement', quantity: 1, amountExGstCents: 33310 as never, gstFree: true }),
      ],
      { gstRegistered: true, settings: SETTINGS },
    );
    expect(lines.map((l) => [l.quantity, l.unitAmountCents, l.accountCode, l.taxType, l.taxAmountCents])).toEqual([
      [1.5, 44000, '200', 'OUTPUT', 6600],
      [1, 3333, '200', 'OUTPUT', 333],
      [1, 10000, '200', 'OUTPUT', 1000],
      [1, 150000, '200', 'OUTPUT', 15000],
      [1, -5000, '200', 'OUTPUT', -500],
      [1, 33310, '840', 'EXEMPTOUTPUT', 0],
    ]);
  });

  it('carries no tax for a firm not registered for GST', () => {
    const [mapped] = xeroLines([line({ amountExGstCents: 1000 as never })], {
      gstRegistered: false,
      settings: SETTINGS,
    });
    expect(mapped).toEqual({ description: 'Work', quantity: 1, unitAmountCents: 1000, accountCode: '200' });
  });

  it('references an invoice by its matter number and a credit note by its invoice', () => {
    const invoice = {
      number: 'INV-000007',
      issueDate: '2026-10-06',
      dueDate: '2026-10-20',
      matterNumber: 'M-2026-0042',
      gstRegistered: false,
      lines: [line({ amountExGstCents: 1000 as never })],
    };
    expect(xeroInvoiceInput(invoice, 'c1', SETTINGS)).toMatchObject({
      contactId: 'c1',
      number: 'INV-000007',
      date: '2026-10-06',
      dueDate: '2026-10-20',
      reference: 'M-2026-0042',
      lineAmountTypes: 'NoTax',
    });
    expect(
      xeroInvoiceInput({ ...invoice, matterNumber: undefined, dueDate: undefined }, 'c1', SETTINGS),
    ).not.toHaveProperty('reference');
    expect(
      xeroCreditNoteInput(
        { number: 'CN-000001', issueDate: '2026-10-07', invoiceNumber: 'INV-000007', lines: [] },
        'c1',
        SETTINGS,
      ),
    ).toMatchObject({ number: 'CN-000001', reference: 'INV-000007', lineAmountTypes: 'Exclusive' });
  });

  it('treats a document Xero holds under the number as this one only when kind, total and reference match', () => {
    const input = xeroInvoiceInput(
      { number: 'INV-1', issueDate: '2026-10-06', matterNumber: 'M-1', lines: [] },
      'c1',
      SETTINGS,
    );
    const found = { id: 'x', number: 'INV-1', type: 'ACCREC', status: 'AUTHORISED', reference: 'M-1', totalCents: 500 };
    expect(sameDocument(found, input, 500)).toBe(true);
    expect(sameDocument({ ...found, totalCents: 501 }, input, 500)).toBe(false);
    expect(sameDocument({ ...found, reference: 'Typed by hand' }, input, 500)).toBe(false);
    expect(sameDocument({ ...found, type: 'ACCPAY' }, input, 500)).toBe(false);
  });
});
