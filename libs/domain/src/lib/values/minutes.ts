import { z } from 'zod';

import { BILLING_UNIT_MINUTES } from '../constants';
import { DomainValueError } from './errors';

/** Integer minutes (ADR-008). Billed in units of `unit` minutes (6 by default, i.e. 0.1 h). */
export type Minutes = number & { readonly __brand: 'Minutes' };

export const MinutesSchema = z
  .number()
  .int({ message: 'Expected integer minutes' })
  .min(0, { message: 'Minutes cannot be negative' })
  .transform((value) => value as Minutes);

export type RoundingMode = 'up' | 'nearest';

export function minutes(value: number): Minutes {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DomainValueError('Minutes', value, `Invalid minutes: ${value}`);
  return value as Minutes;
}

/**
 * Billing units for a duration. `up`: any part of a unit counts (1 minute → 1 unit).
 * `nearest`: half a unit or more rounds up (3 of 6 minutes → 1 unit), but never below 1 unit for
 * a non-zero duration, so recorded work is never billed as nothing.
 */
export function toUnits(
  duration: Minutes | number,
  unit: number = BILLING_UNIT_MINUTES,
  mode: RoundingMode = 'up',
): number {
  const value = minutes(duration);
  if (!Number.isSafeInteger(unit) || unit <= 0) throw new DomainValueError('Minutes', unit, `Invalid unit: ${unit}`);
  if (value === 0) return 0;
  if (mode === 'up') return Math.ceil(value / unit);
  return Math.max(1, Math.floor((value + unit / 2) / unit));
}

/** Units as decimal hours, e.g. 15 units of 6 minutes → `1.5`. */
export function formatUnits(units: number, unit: number = BILLING_UNIT_MINUTES): string {
  const hours = (units * unit) / 60;
  return Number.isInteger(hours * 10) ? hours.toFixed(1) : hours.toFixed(2);
}

/** `1h 05m`, `45m`, `0m`. */
export function formatHm(duration: Minutes | number): string {
  const value = minutes(duration);
  const h = Math.floor(value / 60);
  const m = value % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
