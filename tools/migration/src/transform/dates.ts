import type { DateOnly } from '@materia/domain';

import { domain } from '../domain.ts';
import type { TransformContext } from './context.ts';
import { isPlainObject, str } from '../legacy/snapshot.ts';

const { fromIsoInstant, isDateOnly } = domain;

/**
 * Legacy dates (Legacy migration plan, Hazards): instants are ISO strings (a few are Firestore
 * Timestamps, which the export tags `{ "$timestamp": … }`), legal dates were stored as the UTC
 * instant of local midnight, and `billable.billingDate` is already `YYYY-MM-DD`. V8 parses
 * impossible days (`2025-02-30`) as real ones, so every reader checks the day exists.
 */

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An instant from an ISO string or a tagged Timestamp; undefined when it isn't a real one. */
export function readInstant(value: unknown): Date | undefined {
  const text = typeof value === 'string' ? value : isPlainObject(value) ? str(value['$timestamp']) : undefined;
  if (!text) return undefined;
  const match = ISO_INSTANT.exec(text.trim());
  if (!match || !isDateOnly(match[1])) return undefined;
  // Firestore writes nanoseconds; Date keeps milliseconds.
  const date = new Date(text.trim().replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * An instant field that should always be there (`createdOn`, a comment's `date`): the export
 * time, with `MIG_W_DATE_INVALID`, when it is missing or invalid.
 */
export function instantOr(ctx: TransformContext, value: unknown, legacyPath: string): Date {
  const date = readInstant(value);
  if (date) return date;
  ctx.warnings.add('MIG_W_DATE_INVALID', legacyPath);
  return ctx.asOf;
}

/**
 * A record's created and updated instants. An invalid `createdOn` takes the `updatedOn` when that
 * is real (else the export time); a missing or invalid `updatedOn` takes the created time. One
 * updated "before" it was created (it happens in legacy) keeps its created time for both, so v2
 * never sees time run backwards.
 */
export function createdAndUpdated(
  ctx: TransformContext,
  data: Record<string, unknown>,
  legacyPath: string,
): { createdAt: Date; updatedAt: Date } {
  const created = readInstant(data['createdOn']);
  const updatedRaw = data['updatedOn'];
  const updated = readInstant(updatedRaw);
  if (!created || (updatedRaw !== undefined && updatedRaw !== null && !updated)) {
    ctx.warnings.add('MIG_W_DATE_INVALID', legacyPath);
  }
  const createdAt = created ?? updated ?? ctx.asOf;
  const updatedAt = updated ?? createdAt;
  if (updatedAt.getTime() < createdAt.getTime()) {
    ctx.warnings.add('MIG_W_UPDATED_BEFORE_CREATED', legacyPath);
    return { createdAt, updatedAt: createdAt };
  }
  return { createdAt, updatedAt };
}

/** An optional instant (`doneOnDate`): undefined when empty, and when invalid (with a warning). */
export function optionalInstant(ctx: TransformContext, value: unknown, legacyPath: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = readInstant(value);
  if (!date) ctx.warnings.add('MIG_W_DATE_INVALID', legacyPath);
  return date;
}

/**
 * A legacy due date (an ISO instant of local midnight) as the calendar day in the org's time zone:
 * `2025-03-13T13:00:00.000Z` is 14 March in Melbourne. Empty is no due date; an invalid one is
 * dropped with `MIG_W_DATE_INVALID` rather than invent a deadline.
 */
export function dueDate(ctx: TransformContext, value: unknown, legacyPath: string): DateOnly | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? value.trim() : isPlainObject(value) ? str(value['$timestamp']) : undefined;
  if (text && isDateOnly(text)) return text as DateOnly;
  try {
    if (text) return fromIsoInstant(text.replace(/(\.\d{3})\d+/, '$1'), ctx.timeZone);
  } catch {
    // Falls through to the warning.
  }
  ctx.warnings.add('MIG_W_DATE_INVALID', legacyPath);
  return undefined;
}

/** A legacy `YYYY-MM-DD` (`billable.billingDate`), kept as it is when it is a real day. */
export function legacyDateOnly(ctx: TransformContext, value: unknown, legacyPath: string): DateOnly | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && isDateOnly(value.trim())) return value.trim() as DateOnly;
  ctx.warnings.add('MIG_W_DATE_INVALID', legacyPath);
  return undefined;
}

/**
 * The financial year an instant falls in, as its start year (`budgets[fyStartYear]`): with July
 * starts, 1 August 2026 is in the year starting 2026. Read in the org's time zone.
 */
export function fyStartYear(instant: Date, timeZone: string, startMonth = 7): number {
  return domain.fyStartYear(domain.dateOnlyAt(instant, timeZone), startMonth);
}
