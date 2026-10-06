import type { Firestore } from 'firebase-admin/firestore';

import { addDays, dateOnlyAt, DEFAULT_OCR_DAILY_PAGES, DEFAULT_ORG_TIMEZONE, type DateOnly } from '@materia/domain';

/**
 * The per-org daily OCR page budget (AI-04 cost guard). OCR is a Claude call per scanned page, so
 * an org may OCR at most `settings.clerk.ocrDailyPages` pages a day (Melbourne days;
 * DEFAULT_OCR_DAILY_PAGES when unset; owners and admins set it in Settings → Clerk and AI). Pages are reserved in a transaction on `orgs/{orgId}/counters/ocr-pages-{day}`
 * before the calls; pages a run couldn't use are given back. Past the budget, ingestion is queued
 * until the next day ("Queued").
 */
const counterPath = (orgId: string, day: DateOnly) => `orgs/${orgId}/counters/ocr-pages-${day}`;

export const budgetDay = (at: Date): DateOnly => dateOnlyAt(at, DEFAULT_ORG_TIMEZONE);

/** Shortly after the next Melbourne midnight: when queued ingestion resumes. */
export function nextBudgetDay(at: Date): Date {
  const tomorrow = addDays(budgetDay(at), 1);
  // Melbourne is UTC+10 or +11: start before its midnight and step forward to the first instant of tomorrow.
  let t = Date.parse(`${tomorrow}T00:00:00Z`) - 11 * 60 * 60 * 1000;
  while (dateOnlyAt(new Date(t), DEFAULT_ORG_TIMEZONE) !== tomorrow) t += 15 * 60 * 1000;
  return new Date(t + 10 * 60 * 1000);
}

/** Reserves up to `wanted` pages from today's budget; resolves with how many were granted (maybe 0). */
export async function reserveOcrPages(db: Firestore, orgId: string, wanted: number, at: Date): Promise<number> {
  if (wanted <= 0) return 0;
  const day = budgetDay(at);
  const ref = db.doc(counterPath(orgId, day));
  return db.runTransaction(async (tx) => {
    const [org, counter] = await tx.getAll(db.doc(`orgs/${orgId}`), ref);
    const limit = org?.get('settings.clerk.ocrDailyPages');
    const budget = typeof limit === 'number' && limit >= 0 ? limit : DEFAULT_OCR_DAILY_PAGES;
    const used = Number(counter?.get('pages') ?? 0);
    const granted = Math.max(0, Math.min(wanted, budget - used));
    if (granted > 0) tx.set(ref, { pages: used + granted, day, updatedAt: at }, { merge: true });
    return granted;
  });
}

/** Gives back reserved pages a run didn't use (Clerk turned out to be off, or the run stopped early). */
export async function refundOcrPages(db: Firestore, orgId: string, pages: number, at: Date): Promise<void> {
  if (pages <= 0) return;
  const ref = db.doc(counterPath(orgId, budgetDay(at)));
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).get('pages') ?? 0);
    tx.set(ref, { pages: Math.max(0, used - pages), updatedAt: at }, { merge: true });
  });
}
