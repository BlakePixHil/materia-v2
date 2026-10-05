import type { ReferralSource, ReferrerIndustry, MatterStatus } from './schemas/enums';
import { ReferrerIndustrySchema } from './schemas/enums';
import { addDays, type DateOnly } from './values/date-only';

/**
 * Referrers and referral tracking (CORE-18): contacts flagged `isReferrer` (with `referrerMeta`),
 * the matter's `referrerContactId` or, without one, its `referralSource`, the referrer's referral
 * history and the optional "Thank referrer" task when a referred matter opens.
 */

export const REFERRER_INDUSTRIES: readonly ReferrerIndustry[] = ReferrerIndustrySchema.options;

export const REFERRER_INDUSTRY_LABELS: Readonly<Record<ReferrerIndustry, string>> = {
  accountant: 'Accountant',
  financial_planner: 'Financial planner',
  funeral_director: 'Funeral director',
  law_firm: 'Law firm',
  aged_care: 'Aged care',
  bank: 'Bank',
  other: 'Other',
};

export const REFERRAL_SOURCE_LABELS: Readonly<Record<ReferralSource, string>> = {
  unknown: 'Unknown',
  website: 'Website',
  existing_client: 'Existing client',
  walk_in: 'Walk-in',
};

/** Words in free text (legacy `referrers.industry`) that name an industry, checked in this order. */
const INDUSTRY_WORDS: readonly [ReferrerIndustry, RegExp][] = [
  ['financial_planner', /financ|planner|adviser|advisor|wealth|super(annuation)?\b/],
  ['accountant', /account|\bcpa\b|\bca\b|tax|bookkeep/],
  ['funeral_director', /funeral|mortuar|cremat/],
  ['aged_care', /aged|nursing|retire|care home|residential care/],
  ['bank', /\bbank|credit union|lender|mortgage|broker/],
  ['law_firm', /\blaw|lawyer|legal|solicitor|barrister|attorney/],
];

/**
 * The industry free text names (the legacy app stored `industry` as typed): "Accountant",
 * "Financial Planner", "Funeral director"… An empty value is undefined; anything unrecognised is
 * `other`. MIG-03 maps legacy referrers with it.
 */
export function referrerIndustryFromText(text: string | null | undefined): ReferrerIndustry | undefined {
  const value = (text ?? '').trim().toLowerCase();
  if (!value) return undefined;
  const exact = ReferrerIndustrySchema.safeParse(value.replace(/[\s-]+/g, '_'));
  if (exact.success) return exact.data;
  return INDUSTRY_WORDS.find(([, words]) => words.test(value))?.[0] ?? 'other';
}

/** A referral as a matter records it: the referrer contact, else a source. */
export interface MatterReferral {
  referrerContactId?: string | null | undefined;
  referralSource?: ReferralSource | null | undefined;
}

/** "Referred by …" text for a matter: the referrer's name, the source's label, or null when unset. */
export function referralText(matter: MatterReferral, referrerName?: string | null): string | null {
  if (matter.referrerContactId) return referrerName || 'A referrer';
  if (matter.referralSource) return REFERRAL_SOURCE_LABELS[matter.referralSource];
  return null;
}

/**
 * The patch that sets a matter's referral (a client-direct update): a referrer contact clears the
 * source and a source clears the referrer, so a matter never has both; `null` clears both.
 * `remove` lists the fields to delete.
 */
export function referralPatch(choice: { contactId: string } | { source: ReferralSource } | null): {
  set: Partial<Record<'referrerContactId' | 'referralSource', string>>;
  remove: ('referrerContactId' | 'referralSource')[];
} {
  if (!choice) return { set: {}, remove: ['referrerContactId', 'referralSource'] };
  if ('contactId' in choice) return { set: { referrerContactId: choice.contactId }, remove: ['referralSource'] };
  return { set: { referralSource: choice.source }, remove: ['referrerContactId'] };
}

/** A referred matter as the referrer's history shows it. */
export interface ReferredMatterLike {
  status: MatterStatus;
  createdAt?: Date | undefined;
  deletedAt?: unknown;
}

/** The totals a referrer's "Referrals" section shows (billed fees join once BILL-07 exists). */
export interface ReferralTotals {
  count: number;
  /** Matters still being worked (lead, open, on hold). */
  active: number;
  /** When the latest referred matter was created; null without any. */
  lastReferredAt: Date | null;
}

export function referralTotals(matters: readonly ReferredMatterLike[]): ReferralTotals {
  const live = matters.filter((m) => m.deletedAt === undefined || m.deletedAt === null);
  const times = live.map((m) => m.createdAt?.getTime()).filter((t): t is number => t !== undefined);
  return {
    count: live.length,
    active: live.filter((m) => m.status === 'lead' || m.status === 'open' || m.status === 'on_hold').length,
    lastReferredAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

// ---------- the "Thank referrer" task ----------

/** The task's document id on the matter: one per matter, so reopening or a retry never adds another. */
export const REFERRER_THANK_YOU_TASK_ID = 'referrer-thank-you';
/** Due this many days after the matter opens. */
export const REFERRER_THANK_YOU_DUE_DAYS = 7;

/** Whether the org asked for the task (`settings.referrals.thankYouTask`, off by default). */
export function referrerThankYouEnabled(org: Record<string, unknown> | undefined): boolean {
  const settings = org?.['settings'] as { referrals?: { thankYouTask?: unknown } } | undefined;
  return settings?.referrals?.thankYouTask === true;
}

/** "Thank Lighthouse Financial Advisers for the referral" (the generic title without a name). */
export function referrerThankYouTitle(referrerName: string | null | undefined): string {
  const name = referrerName?.trim();
  return name ? `Thank ${name} for the referral` : 'Thank referrer';
}

/** When the task is due: a week after the matter opens (the org's today). */
export function referrerThankYouDue(openedOn: DateOnly): DateOnly {
  return addDays(openedOn, REFERRER_THANK_YOU_DUE_DAYS);
}
