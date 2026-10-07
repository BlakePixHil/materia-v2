import type { LegalDocumentMeta } from '@materia/domain';

const LONG_DATE = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

/** `2026-10-07` → `7 October 2026`. */
export function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return LONG_DATE.format(new Date(Date.UTC(year, month - 1, day)));
}

/** `Version 0.1 · Effective 7 October 2026`. */
export function versionLine(doc: Pick<LegalDocumentMeta, 'version' | 'effectiveDate'>): string {
  return `Version ${doc.version} · Effective ${longDate(doc.effectiveDate)}`;
}

/** What every draft says until a lawyer has reviewed it (SEC-01a). */
export const DRAFT_NOTICE_TEXT =
  'This document hasn’t been reviewed by a lawyer yet and isn’t in its final form. Text in square brackets is still to be completed.';
