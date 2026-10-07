import { formatUsdCents } from './clerk-settings';
import type { IngestSkipReason } from './schemas/matter-records';
import type { MigrationEnrichment, MigrationEnrichmentEstimate } from './schemas/org-records';
import { isDateOnly, type DateOnly } from './values/date-only';

/**
 * Clerk reading a migration run's documents and estate matters after the load (MIG-09, D-21):
 * what the server and Settings → Clerk and AI share.
 */

/**
 * The review code (MIG-08's queue, `needsReview` on the document) of a migrated document Clerk
 * couldn't read: encrypted, damaged, a kind it doesn't read, or failed. `ingest.reason` or
 * `ingest.error` says why.
 */
export const MIG_W_DOCUMENT_UNREADABLE = 'MIG_W_DOCUMENT_UNREADABLE';

/** Skip reasons that make a migrated document unreadable for review. An empty one has nothing to read. */
export const UNREADABLE_SKIP_REASONS: ReadonlySet<IngestSkipReason> = new Set([
  'encrypted',
  'unsupported',
  'damaged',
  'ocr_unavailable',
]);

/** The smallest and largest allowance an approval may set (US cents). */
export const ENRICHMENT_ALLOWANCE_MIN_CENTS = 100;
export const ENRICHMENT_ALLOWANCE_MAX_CENTS = 100_000;

/** The allowance offered: the estimate plus half again, in whole dollars, at least US$5. */
export function suggestedAllowanceCents(costCents: number): number {
  const withHeadroom = Math.ceil((Math.max(0, costCents) * 1.5) / 100) * 100;
  return Math.min(ENRICHMENT_ALLOWANCE_MAX_CENTS, Math.max(500, withHeadroom));
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-AU')} ${count === 1 ? one : many}`;

/** "71 documents (about 1,040 pages, 220 of them scanned) and 30 estate matters: about US$6.20". */
export function enrichmentEstimateText(estimate: MigrationEnrichmentEstimate): string {
  const pages = estimate.pages
    ? ` (about ${plural(estimate.pages, 'page')}${estimate.ocrPages ? `, ${estimate.ocrPages.toLocaleString('en-AU')} of them scanned` : ''})`
    : '';
  const matters = estimate.matters ? ` and ${plural(estimate.matters, 'estate matter')}` : '';
  return `${plural(estimate.documents, 'document')}${pages}${matters}: about ${formatUsdCents(estimate.costCents)}`;
}

/** Whether an owner or admin can approve it now (first time, after declining, or to resume). */
export function canApproveEnrichment(enrichment: Pick<MigrationEnrichment, 'status'>): boolean {
  return ['awaiting_approval', 'declined', 'paused'].includes(enrichment.status);
}

/** Documents done (read, passed over or failed) out of those to read, and matters read out of those to read. */
export function enrichmentProgress(enrichment: Pick<MigrationEnrichment, 'documents' | 'matters' | 'progress'>): {
  documentsDone: number;
  documents: number;
  mattersDone: number;
  matters: number;
} {
  const { read, skipped, failed, mattersRead } = enrichment.progress;
  return {
    documentsDone: Math.min(enrichment.documents.length, read + skipped + failed),
    documents: enrichment.documents.length,
    mattersDone: Math.min(enrichment.matters.length, mattersRead),
    matters: enrichment.matters.length,
  };
}

/**
 * Whether a migrated document still waits for the enrichment (never read by Clerk): the ingest
 * backfills leave it alone, so nothing that costs money reads it before an owner or admin approves
 * the estimate. Once the enrichment has read it (or tried), it is an ordinary document.
 */
export function awaitsMigrationEnrichment(doc: Record<string, unknown> | undefined): boolean {
  const runId = (doc?.['migration'] as { runId?: unknown } | undefined)?.runId;
  if (typeof runId !== 'string' || !runId) return false;
  const ingest = doc?.['ingest'] as { status?: unknown; version?: unknown } | undefined;
  return !ingest || (ingest.status === 'pending' && ingest.version === undefined);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
const ORDINAL = '(?:st|nd|rd|th)?';
const DATE_PATTERNS: { re: RegExp; ymd: (m: RegExpExecArray) => [string, string, string] }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, ymd: (m) => [m[1] ?? '', m[2] ?? '', m[3] ?? ''] },
  // Day first, as Australian files write it: 12/03/2024, 12.3.24, 12-03-2024.
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g, ymd: (m) => [m[3] ?? '', m[2] ?? '', m[1] ?? ''] },
  // 12 March 2024, 12th of March, 2024, the 12th day of March 2024.
  {
    re: new RegExp(`\\b(\\d{1,2})${ORDINAL}(?:\\s+day)?(?:\\s+of)?\\s+${MONTH},?\\s+(\\d{4})\\b`, 'gi'),
    ymd: (m) => [m[3] ?? '', m[2] ?? '', m[1] ?? ''],
  },
  // March 12, 2024.
  {
    re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORDINAL},?\\s+(\\d{4})\\b`, 'gi'),
    ymd: (m) => [m[3] ?? '', m[1] ?? '', m[2] ?? ''],
  },
];

function toDateOnly(year: string, month: string, day: string): DateOnly | null {
  let y = Number(year);
  if (year.length === 2) y += y < 70 ? 2000 : 1900;
  const named = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  const m = /^\d+$/.test(month) ? Number(month) : named + 1;
  const value = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  return m >= 1 && isDateOnly(value) ? value : null;
}

/**
 * The full dates a text states (day, month and year), as `YYYY-MM-DD`: ISO dates, day-first
 * numeric dates (12/03/2024, 12.3.24) and dates with the month's name (12 March 2024, the 12th day
 * of March 2024, March 12, 2024). A date without its year, or an impossible one, isn't one.
 */
export function datesInText(text: string): DateOnly[] {
  const found = new Set<DateOnly>();
  for (const { re, ymd } of DATE_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const date = toDateOnly(...ymd(match as RegExpExecArray));
      if (date) found.add(date);
    }
  }
  return [...found];
}

/** Whether a quote states this date (in any of the forms `datesInText` reads). */
export function quoteStatesDate(quote: string, date: string): boolean {
  return datesInText(quote).includes(date as DateOnly);
}
