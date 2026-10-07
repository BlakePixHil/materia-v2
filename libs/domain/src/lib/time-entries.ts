import * as z from 'zod';

import { BILLING_UNIT_MINUTES } from './constants';
import { DocIdSchema } from './schemas/common';
import { TIME_ENTRY_MAX_MINUTES, TIME_NARRATIVE_MAX, TimeEntry } from './schemas/matter-records';
import { compareDates, type DateOnly } from './values/date-only';
import { toUnits, type RoundingMode } from './values/minutes';
import { cents, type Cents } from './values/money';

/**
 * Time entries (BILL-01): the duration parser, 6-minute units, the rate in force on a date and the
 * amount, all in integers. `time-onWrite` runs the same functions the client previews with, and its
 * values win.
 */

// ---------- duration ----------

/** Over this on one day (one person), entry asks for confirmation. */
export const TIME_DAY_WARN_MINUTES = 24 * 60;

const HOURS = '(?:h|hr|hrs|hour|hours)';
const MINS = '(?:m|min|mins|minute|minutes)';
const DECIMAL = '(\\d{0,3})(?:\\.(\\d{1,4}))?';
const COLON_RE = /^(\d{1,3}):([0-5]\d)$/;
const DECIMAL_HOURS_RE = new RegExp(`^${DECIMAL}\\s*${HOURS}?$`);
const MINUTES_RE = new RegExp(`^(\\d{1,5})\\s*${MINS}$`);
const HOURS_MINUTES_RE = new RegExp(`^${DECIMAL}\\s*${HOURS}\\s*(\\d{1,4})\\s*${MINS}?$`);

/** Decimal hours as whole minutes, exactly: `0.25` → 15, `0.33` → 20 (half up). */
function hoursToMinutes(whole: string | undefined, fraction: string | undefined): number | null {
  if (!whole && !fraction) return null;
  const digits = fraction ?? '';
  const scale = 10 ** digits.length;
  const scaled = Number(whole || '0') * scale + Number(digits || '0');
  return Math.floor((scaled * 60 * 2 + scale) / (scale * 2));
}

/**
 * Parses what a person types in a duration field into minutes: decimal hours (`0.3`, `1.5h`, a
 * bare number is hours), minutes (`18m`, `45 min`), hours and minutes (`1h 12m`, `1h12`) or `1:12`.
 * `null` when it isn't a duration. Zero parses (as 0) so the caller can say why it's refused.
 */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value) return null;
  const colon = COLON_RE.exec(value);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const mins = MINUTES_RE.exec(value);
  if (mins) return Number(mins[1]);
  const hm = HOURS_MINUTES_RE.exec(value);
  if (hm) {
    const hours = hoursToMinutes(hm[1], hm[2]);
    return hours === null ? null : hours + Number(hm[3]);
  }
  const decimal = DECIMAL_HOURS_RE.exec(value);
  if (decimal) return hoursToMinutes(decimal[1], decimal[2]);
  return null;
}

export type DurationProblem = 'invalid' | 'zero' | 'too_long';

/** Why a typed duration can't be saved, or `null` when it can (`minutes` set). */
export function checkDuration(
  text: string,
): { minutes: number; problem: null } | { minutes: null; problem: DurationProblem } {
  const parsed = parseDuration(text);
  if (parsed === null) return { minutes: null, problem: 'invalid' };
  if (parsed <= 0) return { minutes: null, problem: 'zero' };
  if (parsed > TIME_ENTRY_MAX_MINUTES) return { minutes: null, problem: 'too_long' };
  return { minutes: parsed, problem: null };
}

export const DURATION_PROBLEM_COPY: Record<DurationProblem, string> = {
  invalid: 'Enter a duration such as 0.3, 18m, 1h 12m or 1:12',
  zero: 'Enter a duration of at least a minute',
  too_long: 'One entry can be at most 100 hours',
};

// ---------- units and amounts ----------

/** The org's billing unit and rounding (`org.billing`). */
export interface UnitSettings {
  unitMinutes?: number | undefined;
  rounding: RoundingMode;
}

/** Billing units for a duration: `ceil` when rounding is `up`, half up when `nearest`. */
export function timeUnits(minutes: number, settings: UnitSettings): number {
  return toUnits(minutes, settings.unitMinutes ?? BILLING_UNIT_MINUTES, settings.rounding);
}

/**
 * `units × unitMinutes / 60 × rateCents`, rounded half up to the cent, in integers: 3 units of 6
 * minutes at $440/h is 3 × 6 × 44000 / 60 = 13 200 cents.
 */
export function timeAmountCents(units: number, rateCents: number, unitMinutes: number = BILLING_UNIT_MINUTES): Cents {
  const numerator = units * unitMinutes * rateCents;
  if (!Number.isSafeInteger(numerator)) throw new RangeError('Time amount out of range');
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const rounded = Math.floor((abs * 2 + 60) / 120);
  return cents(rounded === 0 ? 0 : sign * rounded);
}

// ---------- rates ----------

export interface RateHistoryEntry {
  effectiveFrom: string;
  rateCents: number;
}

/** The member fields a rate is resolved from (`members/{uid}`). */
export interface RateMember {
  defaultRateCents?: number | undefined;
  rates?: readonly RateHistoryEntry[] | undefined;
}

/** The matter fields a rate is resolved from. */
export interface RateMatter {
  fee?: { arrangement?: string | undefined; rateOverrideCents?: number | undefined } | undefined;
}

/** The org fields a rate and units are resolved from. */
export interface RateOrg {
  billing: UnitSettings & { defaultRateCents: number };
}

export type RateSource = 'matter' | 'member' | 'org';

/**
 * The member's hourly rate on `date`: the latest `rates[]` entry effective on or before it. A date
 * before every entry takes the earliest (the rate history starts when rates were first recorded),
 * and a member with no history has their single `defaultRateCents` (the pre-history rate, migrated
 * here rather than in the data). `null` when the member has no rate at all.
 */
export function memberRateOn(member: RateMember | null | undefined, date: DateOnly | string): number | null {
  const history = [...(member?.rates ?? [])].sort((a, b) =>
    compareDates(a.effectiveFrom as DateOnly, b.effectiveFrom as DateOnly),
  );
  const effective = history.filter((rate) => rate.effectiveFrom <= date).pop() ?? history[0];
  if (effective) return effective.rateCents;
  const single = member?.defaultRateCents;
  return typeof single === 'number' && single > 0 ? single : null;
}

/**
 * The rate for an entry, in precedence order: the matter's `fee.rateOverrideCents`, the member's
 * rate in force on the entry's date, then the org's `billing.defaultRateCents`. Non-billable entries
 * resolve a rate too (for reporting).
 */
export function resolveRate(input: {
  member: RateMember | null | undefined;
  matter: RateMatter | null | undefined;
  date: DateOnly | string;
  org: RateOrg;
}): { rateCents: Cents; source: RateSource } {
  const override = input.matter?.fee?.rateOverrideCents;
  if (typeof override === 'number') return { rateCents: cents(override), source: 'matter' };
  const member = memberRateOn(input.member, input.date);
  if (member !== null) return { rateCents: cents(member), source: 'member' };
  return { rateCents: cents(input.org.billing.defaultRateCents), source: 'org' };
}

/**
 * A member's rate history after setting `rateCents` from `effectiveFrom` (Settings → Team). The first
 * change keeps the rate it replaces (from `RATE_HISTORY_START`), so entries dated before the change
 * still find it; a second change on the same day replaces the first.
 */
export const RATE_HISTORY_START = '2000-01-01';
export function withRateChange(member: RateMember, rateCents: number, effectiveFrom: string): RateHistoryEntry[] {
  const history = [...(member.rates ?? [])];
  const previous = member.defaultRateCents;
  if (!history.length && typeof previous === 'number' && previous > 0 && effectiveFrom > RATE_HISTORY_START)
    history.push({ effectiveFrom: RATE_HISTORY_START, rateCents: previous });
  return [...history.filter((rate) => rate.effectiveFrom !== effectiveFrom), { effectiveFrom, rateCents }].sort(
    (a, b) => compareDates(a.effectiveFrom as DateOnly, b.effectiveFrom as DateOnly),
  );
}

/** The values `time-onWrite` snapshots onto an entry. */
export interface TimeEntryValues {
  units: number;
  rateCents: Cents;
  amountCents: Cents;
  rateSource: RateSource;
}

/** Units, rate and amount for an entry of `minutes` on `date` by `member` on `matter`. */
export function computeTimeEntry(input: {
  minutes: number;
  date: DateOnly | string;
  member: RateMember | null | undefined;
  matter: RateMatter | null | undefined;
  org: RateOrg;
}): TimeEntryValues {
  const unitMinutes = input.org.billing.unitMinutes ?? BILLING_UNIT_MINUTES;
  const units = timeUnits(input.minutes, input.org.billing);
  const rate = resolveRate(input);
  return {
    units,
    rateCents: rate.rateCents,
    amountCents: timeAmountCents(units, rate.rateCents, unitMinutes),
    rateSource: rate.source,
  };
}

// ---------- fixed fees and WIP ----------

/** Time on these arrangements is recorded but not billable by default ("recorded against fixed fee"). */
const NOT_BILLABLE_BY_DEFAULT = new Set(['fixed', 'pro_bono']);

/** Whether a new entry on this matter starts billable. */
export function defaultBillable(matter: RateMatter | null | undefined): boolean {
  return !NOT_BILLABLE_BY_DEFAULT.has(matter?.fee?.arrangement ?? 'hourly');
}

/** Whether the matter is on a fixed fee (entries show "Fixed fee" instead of a value). */
export function isFixedFee(matter: RateMatter | null | undefined): boolean {
  return matter?.fee?.arrangement === 'fixed';
}

/** Statuses that count as work in progress: recorded and not yet billed or written off. */
export const WIP_STATUSES = ['draft', 'final'] as const;

/** What an entry adds to its matter's `wipCents`: its amount while billable, unbilled and live. */
export function wipContribution(
  entry:
    | {
        billable?: unknown;
        status?: unknown;
        amountCents?: unknown;
        deletedAt?: unknown;
      }
    | null
    | undefined,
): number {
  if (!entry || entry.deletedAt) return 0;
  if (entry.billable !== true) return 0;
  if (!(WIP_STATUSES as readonly unknown[]).includes(entry.status)) return 0;
  return typeof entry.amountCents === 'number' && Number.isSafeInteger(entry.amountCents) ? entry.amountCents : 0;
}

// ---------- day totals and grouping ----------

export interface TimeRowLike {
  uid: string;
  date: string;
  minutes: number;
  units: number;
  amountCents: number;
  billable: boolean;
  deletedAt?: Date | null | undefined;
}

/** Minutes `uid` has on `date` across `entries` (live ones), leaving out `exceptId` (the one being edited). */
export function dayMinutes(
  entries: readonly (TimeRowLike & { id?: string })[],
  uid: string,
  date: string,
  exceptId?: string,
): number {
  return entries
    .filter((entry) => !entry.deletedAt && entry.uid === uid && entry.date === date && entry.id !== exceptId)
    .reduce((sum, entry) => sum + entry.minutes, 0);
}

export interface TimeDay<T extends TimeRowLike> {
  date: string;
  entries: T[];
  minutes: number;
  units: number;
  /** Billable amount (non-billable entries add units, not value). */
  amountCents: number;
}

/** Entries grouped by date, newest day first, each day in the order given, with day totals. */
export function timeByDay<T extends TimeRowLike>(entries: readonly T[]): TimeDay<T>[] {
  const days = new Map<string, TimeDay<T>>();
  for (const entry of entries) {
    const day = days.get(entry.date) ?? { date: entry.date, entries: [], minutes: 0, units: 0, amountCents: 0 };
    day.entries.push(entry);
    day.minutes += entry.minutes;
    day.units += entry.units;
    if (entry.billable) day.amountCents += entry.amountCents;
    days.set(entry.date, day);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Totals across entries: minutes, units, billable amount and non-billable units. */
export function timeTotals(entries: readonly TimeRowLike[]): {
  minutes: number;
  units: number;
  amountCents: number;
  nonBillableUnits: number;
} {
  return entries.reduce(
    (sum, entry) => ({
      minutes: sum.minutes + entry.minutes,
      units: sum.units + entry.units,
      amountCents: sum.amountCents + (entry.billable ? entry.amountCents : 0),
      nonBillableUnits: sum.nonBillableUnits + (entry.billable ? 0 : entry.units),
    }),
    { minutes: 0, units: 0, amountCents: 0, nonBillableUnits: 0 },
  );
}

// ---------- narrative phrases ----------

/**
 * The built-in narrative phrases, inserted with `/` in a narrative (BILL-01). Wills and estates
 * wording; a per-org library is a follow-up.
 */
export const DEFAULT_NARRATIVE_PHRASES: readonly string[] = [
  'Perusing and considering ',
  'Attendance on client ',
  'Attendance on executor ',
  'Telephone attendance on ',
  'Conference with ',
  'Letter to ',
  'Email to ',
  'Correspondence with beneficiaries ',
  'Drafting ',
  'Preparing application for grant of probate',
  'Preparing inventory of assets and liabilities',
  'Preparing executor’s accounts',
  'Reviewing ',
  'Attendance at court ',
  'File review',
];

/** Phrases whose words start with what's typed after `/` (all of them for an empty query). */
export function matchPhrases(
  query: string,
  phrases: readonly string[] = DEFAULT_NARRATIVE_PHRASES,
  limit = 8,
): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = phrases.filter((phrase) => {
    const tokens = phrase.toLowerCase().split(/[\s’']+/);
    return words.every((word) => tokens.some((token) => token.startsWith(word)));
  });
  return matches.slice(0, limit);
}

/**
 * The `/` phrase query at the caret: the text after a `/` that starts the narrative or follows a
 * space, up to the caret, with where it starts. `null` when the caret isn't in one.
 */
export function phraseQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const slash = before.lastIndexOf('/');
  if (slash < 0) return null;
  if (slash > 0 && !/\s/.test(before.charAt(slash - 1))) return null;
  const query = before.slice(slash + 1);
  if (/\s{2}|\n/.test(query) || query.length > 40) return null;
  return { start: slash, query };
}

// ---------- writes ----------

/**
 * A client-created draft (`matters/{matterId}/timeEntries`): the rules require the caller as `uid`,
 * `status: 'draft'`, `source: 'manual'` and `wipCountedCents: 0`; `time-onWrite` then sets the real
 * units, rate and amount and counts it into the matter's WIP.
 */
export const TimeEntryCreateInput = /* @__PURE__ */ TimeEntry.create.extend({
  orgId: DocIdSchema,
  matterId: DocIdSchema,
  minutes: z.number().int().min(1).max(TIME_ENTRY_MAX_MINUTES),
  narrative: z.string().max(TIME_NARRATIVE_MAX),
  status: z.literal('draft').default('draft'),
  source: z.literal('manual').default('manual'),
  wipCountedCents: z.literal(0).default(0),
});
export type TimeEntryCreateInput = z.input<typeof TimeEntryCreateInput>;

export const TIME_CALLABLES = {
  setStatus: 'time-setStatus',
  writeDown: 'time-writeDown',
  reject: 'time-reject',
  exportCsv: 'time-exportCsv',
} as const;

/**
 * The billing screen's WIP callable (BILL-03). Here rather than in `billing.ts` so the time data
 * layer, which Today loads, doesn't pull in the billing rules and what they import (MOB-02b).
 */
export const BILLING_CALLABLES = {
  wip: 'billing-wip',
} as const;

/** Entries one `time-setStatus` call changes at most. */
export const TIME_STATUS_BATCH_MAX = 100;

/**
 * Each entry's `updatedAt` (ms since the epoch) as the caller last saw it (BILL-03): an entry
 * changed since then is left alone and reported as a conflict (optimistic concurrency).
 */
export const TimeExpectedUpdatedAtSchema = /* @__PURE__ */ z.record(DocIdSchema, z.number().int().min(0)).optional();

/**
 * `time-setStatus` (`time.approve`, idempotent): marks a matter's draft entries final (approval,
 * which snapshots the rate in force on each entry's date one last time) or returns final entries to
 * draft. Billed and written-off entries are never changed; entries already in the target status are
 * skipped, and entries changed since `expectedUpdatedAt` are conflicts. Audited as
 * `time.finalised` or `time.returned_to_draft` (BILL-03).
 */
export const SetTimeEntryStatusInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  matterId: DocIdSchema,
  entryIds: z.array(DocIdSchema).min(1).max(TIME_STATUS_BATCH_MAX),
  status: z.enum(['draft', 'final']),
  expectedUpdatedAt: TimeExpectedUpdatedAtSchema,
});
export type SetTimeEntryStatusInput = z.input<typeof SetTimeEntryStatusInput>;

export interface SetTimeEntryStatusResult {
  updated: string[];
  skipped: string[];
  /** Entries changed since the caller saw them (`expectedUpdatedAt`): reload and review again. */
  conflicts: string[];
}
