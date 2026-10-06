import {
  DISBURSEMENT_CATEGORY_LABELS,
  disbursementAmounts,
  GST_TREATMENT_LABELS,
  type DisbursementStatus,
  type GstTreatment,
} from '@materia/domain';
import { formatAud, type MtOption } from '@materia/ui';

/**
 * The Disbursements section's view logic (BILL-04): row text, the amount preview and the
 * remembered entry mode (GST-inclusive or exclusive). Pure apart from `localStorage`.
 */

export type AmountEntry = 'inc' | 'ex';

const ENTRY_KEY = 'materia.disbursements.amountEntry';

/** How the person last entered an amount; GST-inclusive (what a receipt shows) until they choose. */
export function storedAmountEntry(): AmountEntry {
  try {
    return localStorage.getItem(ENTRY_KEY) === 'ex' ? 'ex' : 'inc';
  } catch {
    return 'inc';
  }
}

export function rememberAmountEntry(entry: AmountEntry): void {
  try {
    localStorage.setItem(ENTRY_KEY, entry);
  } catch {
    // Not remembered (private window); the default stands next time.
  }
}

export const AMOUNT_ENTRY_OPTIONS: readonly MtOption<AmountEntry>[] = [
  { value: 'inc', label: 'Incl. GST' },
  { value: 'ex', label: 'Excl. GST' },
];

export const GST_TREATMENT_OPTIONS: readonly MtOption<GstTreatment>[] = (
  Object.keys(GST_TREATMENT_LABELS) as GstTreatment[]
).map((value) => ({ value, label: GST_TREATMENT_LABELS[value] }));

export const DISBURSEMENT_CATEGORY_OPTIONS = (
  Object.keys(DISBURSEMENT_CATEGORY_LABELS) as (keyof typeof DISBURSEMENT_CATEGORY_LABELS)[]
).map((value) => ({ value, label: DISBURSEMENT_CATEGORY_LABELS[value] }));

export const DISBURSEMENT_STATUS_LABELS: Record<DisbursementStatus, string> = {
  unbilled: 'Unbilled',
  billed: 'Billed',
  written_off: 'Written off',
};

/** The stored fields for an entered amount: the inclusive amount is kept only when entered so. */
export function enteredAmounts(
  cents: number,
  entry: AmountEntry,
  gstTreatment: GstTreatment,
): { amountExGstCents: number; gstCents: number; amountIncGstCents: number | null } {
  const amounts = disbursementAmounts(
    entry === 'inc' ? { amountIncGstCents: cents, gstTreatment } : { amountExGstCents: cents, gstTreatment },
  );
  return { ...amounts, amountIncGstCents: entry === 'inc' ? cents : null };
}

/** "$10.05 + $1.00 GST = $11.05", or "$42.00, no GST". */
export function amountPreview(amountExGstCents: number, gstCents: number, gstTreatment: GstTreatment): string {
  if (gstTreatment !== 'taxable') return `${formatAud(amountExGstCents)}, no GST`;
  return `${formatAud(amountExGstCents)} + ${formatAud(gstCents)} GST = ${formatAud(amountExGstCents + gstCents)}`;
}
