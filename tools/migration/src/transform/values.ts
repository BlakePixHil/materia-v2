import type { Cents, Priority } from '@materia/domain';

import { domain } from '../domain.ts';
import type { TransformContext } from './context.ts';

const { fromDollars } = domain;

/** Small value conversions the mappers share: priorities, money and names. */

const PRIORITIES: Readonly<Record<number, Priority>> = { 0: 'none', 1: 'high', 2: 'medium', 3: 'low' };

/**
 * A legacy priority (cards 0 to 3, checklist items 0 or 1): 0 none, 1 high, 2 medium, 3 low.
 * Missing reads as none; anything else is none with `MIG_W_PRIORITY_UNKNOWN`.
 */
export function priorityOf(ctx: TransformContext, value: unknown, legacyPath: string): Priority {
  if (value === undefined || value === null || value === '') return 'none';
  const priority = typeof value === 'number' ? PRIORITIES[value] : undefined;
  if (priority) return priority;
  ctx.warnings.add('MIG_W_PRIORITY_UNKNOWN', legacyPath);
  return 'none';
}

/**
 * A legacy amount as integer cents, by the profile's unit (D-06: dollars, possibly with cents,
 * so cents = round(value × 100) exactly). Undefined for anything that isn't a finite number.
 */
export function centsOf(ctx: TransformContext, value: unknown): Cents | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value.replace(/[$,\s]/g, '')) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
  if (ctx.profile.fees.unit === 'cents') return Math.round(number) as Cents;
  try {
    // fromDollars reads the decimal text exactly, so 5500.5 is 550050, never 550049.99…
    return fromDollars(String(number));
  } catch {
    return undefined; // 1e21 and the like
  }
}

/** "Jane Mary Smith" → given "Jane Mary", family "Smith"; a single word is a family name. */
export function splitName(name: string): { givenNames?: string; familyName?: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return {};
  if (words.length === 1) return { familyName: words[0] as string };
  return { givenNames: words.slice(0, -1).join(' '), familyName: words[words.length - 1] as string };
}

/** Legacy text with its whitespace tidied: trimmed, runs of spaces as one. */
export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
