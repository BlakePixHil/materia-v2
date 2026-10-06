import * as z from 'zod';

import { GST_RATE } from '../constants';
import { DomainValueError } from './errors';

/** Integer AUD cents (ADR-008). Never a float, never dollars. */
export type Cents = number & { readonly __brand: 'Cents' };

export const CentsSchema = z
  .number()
  .int({ message: 'Expected integer cents' })
  .transform((value) => value as Cents);

/** Integer cents that can't be negative: amounts, values and payments as entered (CORE-16). */
export const NonNegativeCentsSchema = z
  .number()
  .int({ message: 'Expected integer cents' })
  .min(0, { message: 'Expected an amount of 0 or more' })
  .transform((value) => value as Cents);

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new DomainValueError('Cents', value, `Invalid cents: ${value}`);
  return value as Cents;
}

const DOLLARS_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a dollar amount exactly, by string: `fromDollars('0.1') + fromDollars('0.2') === 30`.
 * More than two decimal places round half away from zero. Rejects exponents, commas and symbols.
 */
export function fromDollars(value: string | number): Cents {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = DOLLARS_RE.exec(text);
  if (!match) throw new DomainValueError('Cents', value, `Invalid dollar amount: ${JSON.stringify(value)}`);
  const negative = match[1] === '-';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(3, '0');
  let result = Number(whole) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) result += 1;
  const signed = negative ? -result : result;
  return cents(signed === 0 ? 0 : signed);
}

export function addCents(...values: Cents[]): Cents {
  return cents(values.reduce<number>((sum, v) => sum + v, 0));
}

/** Integer division of `numerator / denominator`, rounding half away from zero. */
function divRoundHalfAway(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator) || 1;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const remainder = abs - quotient * denominator;
  const rounded = remainder * 2 >= denominator ? quotient + 1 : quotient;
  return rounded === 0 ? 0 : sign * rounded;
}

/** `pct` percent of an amount (e.g. 80 for an 80% budget alert), rounded half away from zero. */
export function percentOf(amount: Cents, pct: number): Cents {
  const basisPoints = Math.round(pct * 100);
  return cents(divRoundHalfAway(amount * basisPoints, 10_000));
}

/**
 * GST on one ex-GST line, rounded half-up per line (half away from zero, so a credit line mirrors
 * the original invoice line). The Domain doc's rounding rule: round each line, then sum.
 */
export function gstOf(exGst: Cents, rate: number = GST_RATE): Cents {
  const basisPoints = Math.round(rate * 10_000);
  return cents(divRoundHalfAway(exGst * basisPoints, 10_000));
}

const audFormatter = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

/** Display form, e.g. `$1,234.56` or `-$1.00`. Formatting only, never stored. */
export function formatCents(amount: Cents): string {
  return audFormatter.format(amount / 100);
}
