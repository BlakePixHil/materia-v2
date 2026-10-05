import { fromDollars, type Cents } from '@materia/domain';

/** Cents as an editable dollar amount: 45000 → "450.00"; empty for none. */
export function dollarsText(amount: number | null | undefined): string {
  return amount === null || amount === undefined ? '' : (amount / 100).toFixed(2);
}

/**
 * A typed dollar amount as cents: "$1,250.5" → 125050. Empty is `null`; anything else that isn't a
 * non-negative amount is `undefined` (invalid).
 */
export function parseDollars(text: string): Cents | null | undefined {
  const trimmed = text.replace(/[$,\s]/g, '');
  if (!trimmed) return null;
  try {
    const value = fromDollars(trimmed);
    return value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
