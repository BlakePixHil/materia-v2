import * as z from 'zod';

import { fyLabel, fyStartYear } from './org-settings';
import { DocIdSchema } from './schemas/common';
import { MatterTypeSchema, TimeEntryStatusSchema, type MatterStatus, type MatterType } from './schemas/enums';
import {
  TIME_STATUS_BATCH_MAX,
  type SetTimeEntryStatusResult,
  TimeExpectedUpdatedAtSchema,
  timeAmountCents,
} from './time-entries';
import { addDays, addMonths, dateOnly, DateOnlySchema, daysBetween, weekday, type DateOnly } from './values/date-only';
import { cents, type Cents } from './values/money';

/**
 * The Time and billing screen (BILL-03): financial years and weeks, the FY budget card, day
 * targets, unbilled WIP by matter, write-downs, rejections and the time CSV. Pure and in integers,
 * so the screen, the `time-*` and `billing-*` callables and the tests share one set of rules.
 */

// ---------- financial years and weeks ----------

/** One financial year: the year it starts (`budgets[startYear]`), its first and last days and its label. */
export interface FyWindow {
  startYear: number;
  start: DateOnly;
  end: DateOnly;
  label: string;
}

/** The financial year `date` falls in (July to June by default): 2026-06-30 is FY2025–26, 2026-07-01 FY2026–27. */
export function fyWindow(date: DateOnly, startMonth = 7): FyWindow {
  const startYear = fyStartYear(date, startMonth);
  const start = dateOnly(`${startYear}-${String(startMonth).padStart(2, '0')}-01`);
  return { startYear, start, end: addDays(addMonths(start, 12), -1), label: fyLabel(startYear, startMonth) };
}

/** The Monday of `date`'s week. */
export function weekStartOf(date: DateOnly): DateOnly {
  return addDays(date, 1 - weekday(date));
}

/** The seven days (Monday to Sunday) of `date`'s week. */
export function weekDatesOf(date: DateOnly): DateOnly[] {
  const monday = weekStartOf(date);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The first day of a new financial year inside `dates` (a week from 30 June to 1 July), or `null`. */
export function fyBoundaryIn(dates: readonly DateOnly[], startMonth = 7): DateOnly | null {
  for (let i = 1; i < dates.length; i++) {
    const day = dates[i] as DateOnly;
    if (fyStartYear(day, startMonth) !== fyStartYear(dates[i - 1] as DateOnly, startMonth)) return day;
  }
  return null;
}

// ---------- totals ----------

/** The entry fields the screen's totals read (a `TimeEntryItem` fits). */
export interface BillingEntryLike {
  date: string;
  minutes: number;
  units: number;
  amountCents: number;
  billable: boolean;
  status: string;
  deletedAt?: unknown;
}

const live = (entry: BillingEntryLike) => !entry.deletedAt;

/** Statuses whose value counts as recorded: written-off time doesn't. */
const RECORDED_STATUSES = new Set(['draft', 'final', 'billed']);

/**
 * Minutes recorded and how many were billable (the stats row's "billable %"). `pct` is a whole
 * percentage, `null` with nothing recorded.
 */
export function billableShare(entries: readonly BillingEntryLike[]): {
  minutes: number;
  billableMinutes: number;
  pct: number | null;
} {
  let minutes = 0;
  let billableMinutes = 0;
  for (const entry of entries) {
    if (!live(entry)) continue;
    minutes += entry.minutes;
    if (entry.billable) billableMinutes += entry.minutes;
  }
  return { minutes, billableMinutes, pct: minutes ? Math.round((billableMinutes * 100) / minutes) : null };
}

/**
 * A person's totals for a financial year: `recordedCents` is the billable value of live entries
 * dated in it (draft, final or billed; written-off time doesn't count, and a write-down counts at
 * its reduced value), `billedCents` the part already billed.
 */
export function fyTotals(
  entries: readonly BillingEntryLike[],
  window: Pick<FyWindow, 'start' | 'end'>,
): { recordedCents: Cents; billedCents: Cents } {
  let recorded = 0;
  let billed = 0;
  for (const entry of entries) {
    if (!live(entry) || !entry.billable || entry.date < window.start || entry.date > window.end) continue;
    if (!RECORDED_STATUSES.has(entry.status)) continue;
    recorded += entry.amountCents;
    if (entry.status === 'billed') billed += entry.amountCents;
  }
  return { recordedCents: cents(recorded), billedCents: cents(billed) };
}

export type FyBudgetStatus = 'no_budget' | 'on_track' | 'behind';

/** The FY budget card (BILL-03): a member's `budgets[startYear]` against what they've recorded and billed. */
export interface FyBudgetSummary {
  window: FyWindow;
  budgetCents: Cents | null;
  recordedCents: Cents;
  billedCents: Cents;
  /** Whole percentages of the budget; `null` without one. */
  recordedPct: number | null;
  billedPct: number | null;
  /** How far through the year `today` is, as a whole percentage (the Meter's target tick). */
  elapsedPct: number;
  /** The budget pro rata to today; `null` without one. */
  expectedCents: Cents | null;
  status: FyBudgetStatus;
}

/** Behind when recorded is under this share of the pro-rata budget. */
const BEHIND_SHARE = 0.9;

/**
 * The FY budget card for the year `today` falls in. Entries outside the year are ignored, so a
 * week that crosses 1 July can be passed whole. A budget of zero or none shows no meter.
 */
export function fyBudgetSummary(input: {
  budgets: Readonly<Record<string, number>> | null | undefined;
  entries: readonly BillingEntryLike[];
  today: DateOnly;
  startMonth?: number | undefined;
}): FyBudgetSummary {
  const window = fyWindow(input.today, input.startMonth ?? 7);
  const { recordedCents, billedCents } = fyTotals(input.entries, window);
  const raw = input.budgets?.[String(window.startYear)];
  const budgetCents = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? cents(raw) : null;
  const days = daysBetween(window.start, window.end) + 1;
  const elapsedDays = Math.min(days, Math.max(0, daysBetween(window.start, input.today) + 1));
  const elapsedPct = Math.round((elapsedDays * 100) / days);
  const pct = (value: number) => (budgetCents === null ? null : Math.round((value * 100) / budgetCents));
  const expectedCents = budgetCents === null ? null : cents(Math.round((budgetCents * elapsedDays) / days));
  const status: FyBudgetStatus =
    budgetCents === null || expectedCents === null
      ? 'no_budget'
      : recordedCents < expectedCents * BEHIND_SHARE
        ? 'behind'
        : 'on_track';
  return {
    window,
    budgetCents,
    recordedCents,
    billedCents,
    recordedPct: pct(recordedCents),
    billedPct: pct(billedCents),
    elapsedPct,
    expectedCents,
    status,
  };
}

// ---------- day targets ----------

/** The org's daily time target when it hasn't set one (`org.billing.dailyTargetMinutes`): 6 hours. */
export const DEFAULT_DAILY_TARGET_MINUTES = 360;

export interface DayTotal {
  date: DateOnly;
  minutes: number;
  billableMinutes: number;
  drafts: number;
  /** The day's target: the org's on weekdays, nothing at weekends. */
  targetMinutes: number;
  /** Recorded against the target, as a whole percentage; `null` on a day with no target. */
  pct: number | null;
}

/** Each of `dates` with what was recorded on it (live entries) against the daily target. */
export function dayTotals(
  entries: readonly BillingEntryLike[],
  dates: readonly DateOnly[],
  targetMinutes: number = DEFAULT_DAILY_TARGET_MINUTES,
): DayTotal[] {
  return dates.map((date) => {
    const day = entries.filter((entry) => live(entry) && entry.date === date);
    const minutes = day.reduce((sum, entry) => sum + entry.minutes, 0);
    const target = weekday(date) <= 5 ? Math.max(0, targetMinutes) : 0;
    return {
      date,
      minutes,
      billableMinutes: day.reduce((sum, entry) => sum + (entry.billable ? entry.minutes : 0), 0),
      drafts: day.filter((entry) => entry.status === 'draft').length,
      targetMinutes: target,
      pct: target ? Math.round((minutes * 100) / target) : null,
    };
  });
}

// ---------- approvals ----------

/** Why an approver sent a draft back (`timeEntries.rejection`, server-owned, set by `time-reject`). */
export interface TimeRejection {
  note: string;
  by: string;
  at: Date;
}

/**
 * Whether a draft waits for its approver: a draft not sent back, or edited by its author since it
 * was (`updatedAt` after `rejection.at`).
 */
export function awaitingApproval(entry: {
  status: string;
  deletedAt?: unknown;
  rejection?: { at?: Date | null | undefined } | null | undefined;
  updatedAt?: Date | null | undefined;
}): boolean {
  if (entry.status !== 'draft' || entry.deletedAt) return false;
  const rejectedAt = entry.rejection?.at;
  if (!rejectedAt) return true;
  return !!entry.updatedAt && entry.updatedAt.getTime() > rejectedAt.getTime();
}

/** Whether a draft was sent back and not edited since (shown to its author with the note). */
export function sentBack(entry: Parameters<typeof awaitingApproval>[0]): boolean {
  return entry.status === 'draft' && !entry.deletedAt && !!entry.rejection?.at && !awaitingApproval(entry);
}

// ---------- WIP ----------

/** The entry fields the WIP aggregation reads. */
export interface WipEntryLike {
  matterId: string;
  date: string;
  amountCents: number;
  billable: boolean;
  status: string;
  invoiceId?: string | null | undefined;
  deletedAt?: unknown;
}

/**
 * Whether an entry is unbilled WIP on the WIP tab: final, billable, live and on no invoice.
 * (A matter's `wipCents` also counts drafts; the WIP tab counts approved time only.)
 */
export function isUnbilledWip(entry: WipEntryLike): boolean {
  return entry.status === 'final' && entry.billable === true && !entry.deletedAt && !entry.invoiceId;
}

/** One matter's unbilled time. */
export interface MatterWip {
  matterId: string;
  timeCents: Cents;
  entries: number;
  /** The date of the oldest unbilled entry. */
  oldestDate: DateOnly;
}

/** Unbilled time per matter (`isUnbilledWip` entries only), most first. */
export function wipByMatter(entries: readonly WipEntryLike[]): MatterWip[] {
  const byMatter = new Map<string, { timeCents: number; entries: number; oldestDate: string }>();
  for (const entry of entries) {
    if (!isUnbilledWip(entry) || !Number.isSafeInteger(entry.amountCents)) continue;
    const current = byMatter.get(entry.matterId);
    if (!current) byMatter.set(entry.matterId, { timeCents: entry.amountCents, entries: 1, oldestDate: entry.date });
    else {
      current.timeCents += entry.amountCents;
      current.entries += 1;
      if (entry.date < current.oldestDate) current.oldestDate = entry.date;
    }
  }
  return [...byMatter.entries()]
    .map(([matterId, wip]) => ({
      matterId,
      timeCents: cents(wip.timeCents),
      entries: wip.entries,
      oldestDate: wip.oldestDate as DateOnly,
    }))
    .sort((a, b) => b.timeCents - a.timeCents || a.matterId.localeCompare(b.matterId));
}

/** The matter fields a WIP row shows. */
export interface WipMatterLike {
  number: string;
  title: string;
  type: MatterType;
  status: MatterStatus;
  responsibleUid: string;
  privileged?: boolean | undefined;
  fee?:
    | {
        arrangement: string;
        amountCents?: number | undefined;
        capCents?: number | undefined;
        rateOverrideCents?: number | undefined;
      }
    | undefined;
  /** BILL-05: `pct` is a whole percentage of the estimate used; absent without an estimate. */
  budget?: { pct?: number | undefined } | null | undefined;
  /** BILL-04: unbilled disbursements, ex GST, kept by its trigger. */
  disbursementWipCents?: number | undefined;
  /** BILL-07: the date of the matter's last invoice. */
  lastInvoicedOn?: string | undefined;
  deletedAt?: unknown;
}

/** One row of the WIP tab, as `billing-wip` returns it. */
export interface WipRow {
  matterId: string;
  number: string;
  title: string;
  type: MatterType;
  status: MatterStatus;
  responsibleUid: string;
  privileged: boolean;
  fee: {
    arrangement: string;
    amountCents: number | null;
    capCents: number | null;
    rateOverrideCents: number | null;
  };
  timeCents: Cents;
  disbursementCents: Cents;
  totalCents: Cents;
  entries: number;
  /** The oldest unbilled entry's date and age in days; `null` with disbursements only. */
  oldestDate: DateOnly | null;
  ageDays: number | null;
  budgetPct: number | null;
  lastInvoicedOn: DateOnly | null;
  /** Closed or archived since the time was recorded: flagged on the row. */
  closed: boolean;
}

/** Statuses a WIP row is flagged for: the matter is closed but still has WIP. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['closed', 'archived']);

/**
 * The WIP tab's rows: each matter with unbilled time (`wip`) or disbursements, with its fee,
 * budget and age. Matters missing from `matters` (deleted, or not visible) are left out. Sorted
 * by total WIP, most first.
 */
export function wipRows(
  wip: readonly MatterWip[],
  matters: ReadonlyMap<string, WipMatterLike>,
  today: DateOnly,
): WipRow[] {
  const time = new Map(wip.map((row) => [row.matterId, row]));
  const ids = new Set([...time.keys(), ...matters.keys()]);
  const rows: WipRow[] = [];
  for (const matterId of ids) {
    const matter = matters.get(matterId);
    if (!matter || matter.deletedAt) continue;
    const own = time.get(matterId);
    const disbursements = Number.isSafeInteger(matter.disbursementWipCents) ? Number(matter.disbursementWipCents) : 0;
    const timeCents = own?.timeCents ?? 0;
    if (timeCents <= 0 && disbursements <= 0) continue;
    const pct = matter.budget?.pct;
    rows.push({
      matterId,
      number: matter.number,
      title: matter.title,
      type: matter.type,
      status: matter.status,
      responsibleUid: matter.responsibleUid,
      privileged: matter.privileged === true,
      fee: {
        arrangement: matter.fee?.arrangement ?? 'hourly',
        amountCents: matter.fee?.amountCents ?? null,
        capCents: matter.fee?.capCents ?? null,
        rateOverrideCents: matter.fee?.rateOverrideCents ?? null,
      },
      timeCents: cents(timeCents),
      disbursementCents: cents(disbursements),
      totalCents: cents(timeCents + disbursements),
      entries: own?.entries ?? 0,
      oldestDate: own?.oldestDate ?? null,
      ageDays: own ? Math.max(0, daysBetween(own.oldestDate, today)) : null,
      budgetPct: typeof pct === 'number' && Number.isFinite(pct) ? Math.round(pct) : null,
      lastInvoicedOn: (matter.lastInvoicedOn as DateOnly | undefined) ?? null,
      closed: CLOSED_STATUSES.has(matter.status),
    });
  }
  return rows.sort((a, b) => b.totalCents - a.totalCents || a.number.localeCompare(b.number));
}

/** Unbilled WIP this old (days since the oldest entry) is flagged on its row. */
export const WIP_AGE_WARN_DAYS = 45;

// ---------- write-downs ----------

export const WRITE_DOWN_REASON_MAX = 500;
export const REJECTION_NOTE_MAX = 500;

/** How an entry is reduced: to a number of units, by a percentage, or written off entirely. */
export type WriteDownChange = { newUnits: number } | { percent: number } | { writeOff: true };

export interface WriteDownPlan {
  status: 'final' | 'written_off';
  units: number;
  amountCents: Cents;
  writeDown: { originalUnits: number; originalAmountCents: Cents; by: string; reason: string };
}

export type WriteDownProblem = 'status' | 'not_lower';

/**
 * What `time-writeDown` writes on one entry. A write-down approves the entry at the reduced value
 * (`final`: a draft's value would otherwise be recomputed from its minutes); a write-off sets
 * `written_off` and keeps the value for the record. The minutes worked never change. The first
 * write-down's originals are kept through later ones. Only draft and final entries can be reduced,
 * and a write-down must lower the value.
 */
export function planWriteDown(
  entry: {
    status: string;
    units: number;
    amountCents: number;
    rateCents: number;
    writeDown?: { originalUnits: number; originalAmountCents: number } | null | undefined;
  },
  change: WriteDownChange,
  context: { by: string; reason: string; unitMinutes: number },
): { plan: WriteDownPlan; problem: null } | { plan: null; problem: WriteDownProblem } {
  if (entry.status !== 'draft' && entry.status !== 'final') return { plan: null, problem: 'status' };
  const writeDown = {
    originalUnits: entry.writeDown?.originalUnits ?? entry.units,
    originalAmountCents: cents(entry.writeDown?.originalAmountCents ?? entry.amountCents),
    by: context.by,
    reason: context.reason,
  };
  if ('writeOff' in change) {
    return {
      plan: { status: 'written_off', units: entry.units, amountCents: cents(entry.amountCents), writeDown },
      problem: null,
    };
  }
  let units: number;
  let amount: number;
  if ('newUnits' in change) {
    units = change.newUnits;
    amount = timeAmountCents(units, entry.rateCents, context.unitMinutes);
  } else {
    const keep = 100 - change.percent;
    units = Math.floor((entry.units * keep * 2 + 100) / 200);
    amount = Math.floor((entry.amountCents * keep * 2 + 100) / 200);
  }
  if (units < 0 || amount >= entry.amountCents) return { plan: null, problem: 'not_lower' };
  return { plan: { status: 'final', units, amountCents: cents(amount), writeDown }, problem: null };
}

export const WRITE_DOWN_PROBLEM_COPY: Record<WriteDownProblem, string> = {
  status: 'Only draft and final time can be written down',
  not_lower: 'A write-down must lower the entry’s value',
};

// ---------- callables ----------

/**
 * `time-writeDown` (`time.approve`, idempotent): writes down a matter's draft or final entries to
 * `newUnits` (one entry), by `percent`, or writes them off (`writeOff`), with a reason. Keeps the
 * original values in `writeDown` and records `time.written_down` or `time.written_off`.
 */
export const TimeWriteDownInput = /* @__PURE__ */ z
  .object({
    requestId: z.uuid(),
    matterId: DocIdSchema,
    entryIds: z.array(DocIdSchema).min(1).max(TIME_STATUS_BATCH_MAX),
    newUnits: z.number().int().min(0).optional(),
    percent: z.number().int().min(1).max(100).optional(),
    writeOff: z.literal(true).optional(),
    reason: z.string().trim().min(1, { message: 'Say why' }).max(WRITE_DOWN_REASON_MAX),
    expectedUpdatedAt: TimeExpectedUpdatedAtSchema,
  })
  .refine(
    (input) =>
      [input.newUnits !== undefined, input.percent !== undefined, input.writeOff === true].filter(Boolean).length === 1,
    { message: 'Give new units, a percentage or a write-off', path: ['newUnits'] },
  )
  .refine((input) => input.newUnits === undefined || input.entryIds.length === 1, {
    message: 'New units apply to one entry at a time',
    path: ['newUnits'],
  });
export type TimeWriteDownInput = z.input<typeof TimeWriteDownInput>;

/** `time-reject` (`time.approve`, idempotent): sends a matter's drafts back to their authors with a note. */
export const RejectTimeEntriesInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  matterId: DocIdSchema,
  entryIds: z.array(DocIdSchema).min(1).max(TIME_STATUS_BATCH_MAX),
  note: z.string().trim().min(1, { message: 'Add a note for the author' }).max(REJECTION_NOTE_MAX),
  expectedUpdatedAt: TimeExpectedUpdatedAtSchema,
});
export type RejectTimeEntriesInput = z.input<typeof RejectTimeEntriesInput>;

/** What a review callable did: entries changed, skipped (missing, wrong status) and changed since the caller saw them. */
export type TimeReviewResult = SetTimeEntryStatusResult;

/** `billing-wip` (`billing.view`): the WIP tab's rows, server-aggregated. */
export const BillingWipInput = /* @__PURE__ */ z.object({ requestId: z.uuid().optional() });
export type BillingWipInput = z.input<typeof BillingWipInput>;

export interface BillingWipResult {
  rows: WipRow[];
  totalCents: Cents;
  /** The entry scan stopped at its cap: totals are a lower bound (narrow by INS-01 rollups later). */
  truncated: boolean;
}

/** Final entries `billing-wip` reads at most. */
export const BILLING_WIP_MAX_ENTRIES = 20_000;

/** `time-exportCsv` (`time.approve`): entries dated `from`–`to` as CSV, filtered, up to TIME_EXPORT_MAX_ROWS. */
export const TimeExportInput = /* @__PURE__ */ z
  .object({
    requestId: z.uuid().optional(),
    from: DateOnlySchema,
    to: DateOnlySchema,
    uid: DocIdSchema.optional(),
    status: TimeEntryStatusSchema.optional(),
    /** Unbilled WIP only (final, billable, not invoiced). */
    unbilledOnly: z.boolean().optional(),
    responsibleUid: DocIdSchema.optional(),
    matterType: MatterTypeSchema.optional(),
  })
  .refine((input) => input.from <= input.to, { message: 'The start is after the end', path: ['to'] });
export type TimeExportInput = z.input<typeof TimeExportInput>;

export const TIME_EXPORT_MAX_ROWS = 5000;

export const BILLING_CALLABLES = {
  wip: 'billing-wip',
} as const;

// ---------- CSV ----------

export const TIME_CSV_COLUMNS = [
  'Date',
  'Matter',
  'Matter title',
  'Person',
  'Narrative',
  'Minutes',
  'Units',
  'Hours',
  'Rate',
  'Amount',
  'Billable',
  'Status',
  'Written down from',
  'Write-down reason',
] as const;

export interface TimeCsvRow {
  date: string;
  matterNumber: string;
  matterTitle: string;
  person: string;
  narrative: string;
  minutes: number;
  units: number;
  unitMinutes: number;
  rateCents: number;
  amountCents: number;
  billable: boolean;
  status: string;
  originalAmountCents?: number | undefined;
  writeDownReason?: string | undefined;
}

/** One CSV cell: quoted when needed, and never starting a formula (`=`, `+`, `-`, `@`). */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Cents as plain dollars for a spreadsheet: 13200 → `132.00`. */
export function centsToDecimal(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** One time entry's cells, in TIME_CSV_COLUMNS order (unescaped). */
export function timeCsvCells(row: TimeCsvRow): (string | number)[] {
  return [
    row.date,
    row.matterNumber,
    row.matterTitle,
    row.person,
    row.narrative,
    row.minutes,
    row.units,
    ((row.units * row.unitMinutes) / 60).toFixed(2),
    centsToDecimal(row.rateCents),
    centsToDecimal(row.amountCents),
    row.billable ? 'Yes' : 'No',
    row.status,
    row.originalAmountCents === undefined ? '' : centsToDecimal(row.originalAmountCents),
    row.writeDownReason ?? '',
  ];
}

/** Time entries as CSV (CRLF lines, a header row), for the time export. */
export function timeEntriesCsv(rows: readonly TimeCsvRow[]): string {
  const lines = rows.map((row) => timeCsvCells(row).map(csvCell).join(','));
  return [TIME_CSV_COLUMNS.join(','), ...lines].join('\r\n');
}
