import { XERO_TAX_TYPES, type InvoiceLine, type XeroSettings } from '@materia/domain';

import type { XeroDocumentInput, XeroDocumentRecord, XeroLineInput } from '../ports';

type Data = Record<string, unknown>;

/** Whether a number has at most four decimal places (Xero's limit on quantities). */
const fourPlaces = (value: number) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;

/**
 * Materia's lines as Xero lines (BILL-09). Disbursements go to the disbursements account,
 * everything else (time, fixed fees, adjustments) to the fees account. With GST, each line carries
 * its tax type and Materia's own GST amount, so Xero's GST and totals equal the tax invoice's.
 * Hours at a rate stay hours at a rate when they multiply out exactly; anything else is one unit.
 */
export function xeroLines(
  lines: readonly InvoiceLine[],
  options: { gstRegistered: boolean; settings: Pick<XeroSettings, 'feesAccountCode' | 'disbursementsAccountCode'> },
): XeroLineInput[] {
  return lines.map((line) => {
    const units =
      line.unitPriceCents !== undefined &&
      line.quantity > 0 &&
      fourPlaces(line.quantity) &&
      // Exactly, with no rounding: Xero rounds line amounts its own way, which could differ by a cent.
      Math.abs(line.quantity * line.unitPriceCents - line.amountExGstCents) < 1e-6;
    const accountCode =
      line.kind === 'disbursement' ? options.settings.disbursementsAccountCode : options.settings.feesAccountCode;
    return {
      description: line.description,
      quantity: units ? line.quantity : 1,
      unitAmountCents: units ? (line.unitPriceCents as number) : line.amountExGstCents,
      accountCode,
      ...(options.gstRegistered
        ? {
            taxType: line.gstFree || line.gstCents === 0 ? XERO_TAX_TYPES.gstFree : XERO_TAX_TYPES.gst,
            taxAmountCents: line.gstCents,
          }
        : {}),
    };
  });
}

/** Whether a document was issued with GST: each keeps the firm's registration when it was issued. */
export const issuedWithGst = (document: Data): boolean => document['gstRegistered'] !== false;

/** An issued invoice as a Xero ACCREC invoice, referenced by its matter number. */
export function xeroInvoiceInput(invoice: Data, contactId: string, settings: XeroSettings): XeroDocumentInput {
  const gstRegistered = issuedWithGst(invoice);
  const reference = typeof invoice['matterNumber'] === 'string' ? invoice['matterNumber'] : undefined;
  return {
    contactId,
    number: String(invoice['number']),
    date: String(invoice['issueDate']),
    ...(typeof invoice['dueDate'] === 'string' ? { dueDate: invoice['dueDate'] } : {}),
    ...(reference ? { reference } : {}),
    lineAmountTypes: gstRegistered ? 'Exclusive' : 'NoTax',
    lines: xeroLines((invoice['lines'] ?? []) as InvoiceLine[], { gstRegistered, settings }),
  };
}

/** A credit note as a Xero ACCRECCREDIT credit note, referenced by the invoice it credits. */
export function xeroCreditNoteInput(note: Data, contactId: string, settings: XeroSettings): XeroDocumentInput {
  const gstRegistered = issuedWithGst(note);
  return {
    contactId,
    number: String(note['number']),
    date: String(note['issueDate']),
    reference: String(note['invoiceNumber'] ?? ''),
    lineAmountTypes: gstRegistered ? 'Exclusive' : 'NoTax',
    lines: xeroLines((note['lines'] ?? []) as InvoiceLine[], { gstRegistered, settings }),
  };
}

/**
 * Whether a document Xero already holds under the same number is this one: an earlier send that
 * stopped before Materia recorded it. Same kind, same reference and same total; anything else
 * (someone typed the number in by hand) is left alone.
 */
export function sameDocument(found: XeroDocumentRecord, input: XeroDocumentInput, totalCents: number): boolean {
  const type = found.type === 'ACCREC' || found.type === 'ACCRECCREDIT';
  return type && found.totalCents === totalCents && (found.reference ?? '') === (input.reference ?? '');
}
