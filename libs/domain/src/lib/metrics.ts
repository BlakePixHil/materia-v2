import { DEFAULT_ORG_TIMEZONE } from './constants';
import { ROLES } from './permissions';
import type { MemberMetricsVisibility, Role } from './schemas/enums';
import {
  METRIC_SHARD_MEMBER_THRESHOLD,
  METRIC_SHARDS,
  type MetricsSourceKind,
  type StageVisit,
} from './schemas/metrics';
import {
  addDays,
  addMonths,
  dateOnly,
  dateOnlyAt,
  daysBetween,
  fyStartYear,
  isDateOnly,
  weekday,
  type DateOnly,
} from './values/date-only';

/**
 * The practice metrics rollups (INS-01, ADR-048), pure so that the sync triggers, the nightly
 * recompute, the backfill script and the tests share one definition of every number.
 *
 * Each record (matter, time entry, disbursement, deadline, invoice, credit note) has a
 * contribution: what it adds to the metrics, by day (`2026-10-06`) and, for member figures, by day
 * and member (`2026-10-06|{uid}`). The day decides the `day-`, `month-` and `fy-` documents; it is
 * always one of the record's own dates (the work date, the issue date, the due date), never the
 * write time. Rolling every contribution up gives the period documents; the sync applies the
 * difference between a record's contribution now and what its ledger says was counted.
 *
 * Snapshot figures (`wip.`, `active.`, `overdue.`, `debtors.`, and `clerk.` copied from Clerk's
 * metering) describe a moment, not a flow: only the nightly recompute and the backfill write them.
 */

type Data = Record<string, unknown>;

/** Flat counters by key. */
export type MetricValues = Record<string, number>;
/** What one record adds, by cell: `YYYY-MM-DD` (org figures) or `YYYY-MM-DD|{uid}` (member figures). */
export type MetricContribution = Record<string, MetricValues>;

// ---------- periods ----------

/** A rollup period id: `day-2026-10-06`, `month-2026-10` or `fy-2026` (the year the FY starts). */
export const METRIC_PERIOD_RE = /^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2}|fy-\d{4})$/;

/** The three periods a day rolls up into. */
export function metricPeriods(date: DateOnly, fyStartMonth = 7): { day: string; month: string; fy: string } {
  return { day: `day-${date}`, month: `month-${date.slice(0, 7)}`, fy: `fy-${fyStartYear(date, fyStartMonth)}` };
}

/** A period's first and last days, or null for anything else (`clerk-2026-10`). */
export function metricPeriodRange(period: string, fyStartMonth = 7): { start: DateOnly; end: DateOnly } | null {
  if (!METRIC_PERIOD_RE.test(period)) return null;
  const [kind, rest] = [period.slice(0, period.indexOf('-')), period.slice(period.indexOf('-') + 1)];
  if (kind === 'day') {
    const day = dateOnly(rest);
    return { start: day, end: day };
  }
  if (kind === 'month') {
    const start = dateOnly(`${rest}-01`);
    return { start, end: addDays(addMonths(start, 1), -1) };
  }
  const start = dateOnly(`${rest}-${String(fyStartMonth).padStart(2, '0')}-01`);
  return { start, end: addDays(addMonths(start, 12), -1) };
}

/** Every day, month and FY period touching `from`..`to` (inclusive), in order. */
export function metricPeriodsBetween(from: DateOnly, to: DateOnly, fyStartMonth = 7): string[] {
  const periods = new Set<string>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const { day: d, month, fy } = metricPeriods(day, fyStartMonth);
    periods.add(d).add(month).add(fy);
  }
  return [...periods];
}

// ---------- keys and cells ----------

/**
 * An id inside a metric key (a referrer, a stage, a matter type): letters, digits, `_` and `-`
 * only, so keys stay dot-separated and Clerk's metrics scope keeps them (`[A-Za-z0-9_.-]`).
 */
export function metricKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || '_';
}

/** Key prefixes of the snapshot figures, which the nightly recompute sets rather than counts. */
export const METRIC_SNAPSHOT_PREFIXES = ['wip.', 'active.', 'overdue.', 'debtors.', 'clerk.'] as const;
export const isSnapshotKey = (key: string) => METRIC_SNAPSHOT_PREFIXES.some((prefix) => key.startsWith(prefix));

export const metricCell = (date: DateOnly, uid?: string) => (uid ? `${date}|${uid}` : date);
export function parseMetricCell(cell: string): { date: DateOnly; uid?: string } | null {
  const [date, uid] = cell.split('|');
  if (!date || !isDateOnly(date)) return null;
  return uid ? { date, uid } : { date };
}

/** A member's document under a period, relative to `metrics/`: `month-2026-10/byMember/{uid}`. */
export const memberMetricsKey = (period: string, uid: string) => `${period}/byMember/${uid}`;
export function splitMetricsKey(key: string): { period: string; uid?: string } {
  const [period = '', , uid] = key.split('/');
  return uid ? { period, uid } : { period };
}

// ---------- values ----------

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;

/** An instant as Firestore or the app hands it over (Date, Timestamp, `{seconds}`, ISO string, millis). */
export function instantOf(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value && typeof value === 'object') {
    const record = value as { toDate?: () => Date; seconds?: number; _seconds?: number; nanoseconds?: number };
    if (typeof record.toDate === 'function') return instantOf(record.toDate());
    const seconds = record.seconds ?? record._seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000 + Math.floor((record.nanoseconds ?? 0) / 1e6));
  }
  return null;
}

/** The org-time-zone day of an instant, or null. */
export function dayOfInstant(value: unknown, timeZone: string = DEFAULT_ORG_TIMEZONE): DateOnly | null {
  const instant = instantOf(value);
  return instant ? dateOnlyAt(instant, timeZone) : null;
}

/** Adds `values` (times `sign`) into `target`, dropping keys that reach zero. */
export function addMetricValues(target: MetricValues, values: MetricValues, sign = 1): MetricValues {
  for (const [key, value] of Object.entries(values)) {
    const next = (target[key] ?? 0) + sign * value;
    if (next === 0) Reflect.deleteProperty(target, key);
    else target[key] = next;
  }
  return target;
}

/** `a − b`, keeping only the keys that differ. */
export function subtractMetricValues(a: MetricValues, b: MetricValues): MetricValues {
  return addMetricValues(addMetricValues({}, a), b, -1);
}

/** A period's figures: its document's `values` plus every shard's (ADR-048). */
export function sumMetricShards(main: Data | undefined, shards: readonly (Data | undefined)[] = []): MetricValues {
  const total: MetricValues = {};
  for (const values of [main, ...shards]) {
    for (const [key, value] of Object.entries(values ?? {}))
      if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

// ---------- contributions ----------

class Contribution {
  readonly cells: MetricContribution = {};
  add(date: DateOnly | null | undefined, key: string, value: number, uid?: string): this {
    if (!date || !value) return this;
    const cell = (this.cells[metricCell(date, uid)] ??= {});
    cell[key] = (cell[key] ?? 0) + value;
    return this;
  }
}

/** Statuses whose billable value counts as recorded (BILL-03's FY card): written-off time doesn't. */
const RECORDED = new Set(['draft', 'final', 'billed']);

/**
 * A time entry's figures on its work date, for the org (`time.*`, `time.type.{type}.*`, write-offs
 * and write-downs) and for its author (`time.*`). Value is the entry's amount at its rate, whatever
 * its status; `recordedCents` and `billedCents` follow BILL-03's FY budget card.
 */
export function timeEntryMetrics(entry: Data | undefined, matter?: { type?: unknown }): MetricContribution {
  if (!entry || isDeleted(entry) || !isDateOnly(entry['date'])) return {};
  const date = entry['date'];
  const uid = str(entry['uid']);
  const minutes = num(entry['minutes']);
  const amount = num(entry['amountCents']);
  const status = String(entry['status'] ?? '');
  const billable = entry['billable'] === true;
  const recorded = billable && RECORDED.has(status) ? amount : 0;
  const billed = billable && status === 'billed' ? amount : 0;
  const out = new Contribution();
  for (const who of uid ? [undefined, uid] : [undefined]) {
    out
      .add(date, 'time.entries', 1, who)
      .add(date, 'time.minutes', minutes, who)
      .add(date, 'time.valueCents', amount, who)
      .add(date, billable ? 'time.billable.minutes' : 'time.nonBillable.minutes', minutes, who)
      .add(date, billable ? 'time.billable.valueCents' : 'time.nonBillable.valueCents', amount, who)
      .add(date, 'time.recordedCents', recorded, who)
      .add(date, 'time.billedCents', billed, who);
  }
  const type = str(matter?.type);
  if (type) {
    out.add(date, `time.type.${metricKeyPart(type)}.minutes`, minutes);
    out.add(date, `time.type.${metricKeyPart(type)}.valueCents`, amount);
  }
  const original = num((entry['writeDown'] as Data | undefined)?.['originalAmountCents']);
  if (status === 'written_off') out.add(date, 'billing.writtenOff.timeCents', original || amount);
  else if (original > amount) out.add(date, 'billing.writtenDown.timeCents', original - amount);
  return out.cells;
}

/** A disbursement's figures on its date: recorded ex GST, and written off. */
export function disbursementMetrics(disbursement: Data | undefined): MetricContribution {
  if (!disbursement || isDeleted(disbursement) || !isDateOnly(disbursement['date'])) return {};
  const date = disbursement['date'];
  const amount = num(disbursement['amountExGstCents']);
  const out = new Contribution().add(date, 'disbursements.count', 1).add(date, 'disbursements.exGstCents', amount);
  if (disbursement['status'] === 'written_off') out.add(date, 'billing.writtenOff.disbursementsCents', amount);
  return out.cells;
}

/** Who referred a matter, for the referral figures: the referrer contact and its industry. */
export interface MetricsReferral {
  referrerId?: string | undefined;
  industry?: string | undefined;
}

/** The referral a matter carries, given its referrer contact (CORE-18). */
export function metricsReferralOf(matter: Data | undefined, referrer?: Data | null): MetricsReferral {
  const referrerId = str(matter?.['referrerContactId']);
  if (!referrerId) return {};
  const industry = str((referrer?.['referrerMeta'] as Data | undefined)?.['industry']);
  return { referrerId, industry: industry ?? 'unknown' };
}

/** A document's lines split into fees and disbursements (ex GST). */
function feesOf(doc: Data): { subtotal: number; gst: number; fees: number; disbursements: number } {
  const subtotal = num(doc['subtotalCents']);
  const lines = Array.isArray(doc['lines']) ? (doc['lines'] as Data[]) : [];
  const disbursements = lines
    .filter((line) => line?.['kind'] === 'disbursement')
    .reduce((sum, line) => sum + num(line['amountExGstCents']), 0);
  return { subtotal, gst: num(doc['gstCents']), fees: subtotal - disbursements, disbursements };
}

function addReferral(out: Contribution, date: DateOnly, referral: MetricsReferral, what: string, cents: number) {
  if (!referral.referrerId) return;
  out.add(date, `referrals.${what}`, cents);
  out.add(date, `referrals.referrer.${metricKeyPart(referral.referrerId)}.${what}`, cents);
  out.add(date, `referrals.industry.${metricKeyPart(referral.industry ?? 'unknown')}.${what}`, cents);
}

/**
 * An invoice's figures: what it billed on its issue date (ex GST; a voided invoice adds nothing),
 * the referred matter's fees, and each payment on its date (BILL-08: a refund counts against
 * collected, a reversed payment not at all). Drafts add nothing.
 */
export function invoiceMetrics(invoice: Data | undefined, referral: MetricsReferral = {}): MetricContribution {
  if (!invoice || invoice['status'] === 'draft') return {};
  const out = new Contribution();
  const issueDate = invoice['issueDate'];
  if (invoice['status'] !== 'void' && isDateOnly(issueDate)) {
    const { subtotal, gst, fees, disbursements } = feesOf(invoice);
    out
      .add(issueDate, 'billing.invoices', 1)
      .add(issueDate, 'billing.invoicedCents', subtotal)
      .add(issueDate, 'billing.invoicedGstCents', gst)
      .add(issueDate, 'billing.invoicedFeesCents', fees)
      .add(issueDate, 'billing.invoicedDisbursementsCents', disbursements);
    addReferral(out, issueDate, referral, 'billedCents', fees);
  }
  for (const payment of Array.isArray(invoice['payments']) ? (invoice['payments'] as Data[]) : []) {
    if (!payment || payment['reversedAt'] || !isDateOnly(payment['date'])) continue;
    const refund = payment['kind'] === 'refund';
    out.add(payment['date'], 'billing.collectedCents', (refund ? -1 : 1) * num(payment['amountCents']));
    out.add(payment['date'], refund ? 'billing.refunds' : 'billing.payments', 1);
  }
  return out.cells;
}

/** A credit note's figures on its issue date (ex GST), and the referred matter's fees credited. */
export function creditNoteMetrics(creditNote: Data | undefined, referral: MetricsReferral = {}): MetricContribution {
  if (!creditNote || !isDateOnly(creditNote['issueDate'])) return {};
  const date = creditNote['issueDate'];
  const { subtotal, gst, fees } = feesOf(creditNote);
  const out = new Contribution()
    .add(date, 'billing.creditNotes', 1)
    .add(date, 'billing.creditedCents', subtotal)
    .add(date, 'billing.creditedGstCents', gst)
    .add(date, 'billing.creditedFeesCents', fees);
  addReferral(out, date, referral, 'creditedCents', fees);
  return out.cells;
}

/** The longest stay a histogram key records (`d3650`): ten years. */
export const METRIC_DAYS_MAX = 3650;
const daysKey = (prefix: string, days: number) => `${prefix}.d${Math.min(Math.max(days, 0), METRIC_DAYS_MAX)}`;

/**
 * Imported legacy billing (MIG): `legacyBilling.billingTotal` in dollars (or `billingTotalCents`),
 * as integer cents; 0 when absent or not positive.
 */
export function legacyBilledCents(legacyBilling: unknown): number {
  const billing = (legacyBilling ?? {}) as Data;
  if (typeof billing['billingTotalCents'] === 'number') return Math.max(0, Math.round(billing['billingTotalCents']));
  const total = billing['billingTotal'];
  const dollars =
    typeof total === 'number' ? total : typeof total === 'string' ? Number(total.replace(/[$,\s]/g, '')) : NaN;
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
}

export interface MatterMetricsContext {
  timeZone?: string;
  /** The referrer contact's industry (CORE-18), when the matter has a referrer. */
  referrerIndustry?: string | undefined;
  /** The matter's stage history, from its ledger (finished stays become stage durations). */
  stages?: readonly StageVisit[] | undefined;
}

/**
 * A matter's figures. Opened is its creation day (org time zone; a lead is not opened until it
 * opens, and then counts on its creation day too), closed its `closedAt` day. Cycle times are
 * histograms of days (`d{n}`), medians on read: instructions → grant on the grant date, and grant
 * → distribution (closed with the final distribution recorded) on the closing day. Finished stage
 * stays count on the day they ended. Imported legacy billing counts on its billing date.
 */
export function matterMetrics(matter: Data | undefined, ctx: MatterMetricsContext = {}): MetricContribution {
  if (!matter || isDeleted(matter) || matter['destroyedAt']) return {};
  const timeZone = ctx.timeZone ?? DEFAULT_ORG_TIMEZONE;
  const out = new Contribution();
  const type = metricKeyPart(str(matter['type']) ?? 'unknown');
  const status = String(matter['status'] ?? '');
  const openedOn = status && status !== 'lead' ? dayOfInstant(matter['createdAt'], timeZone) : null;
  const closedOn = status === 'closed' || status === 'archived' ? dayOfInstant(matter['closedAt'], timeZone) : null;
  const referral = metricsReferralOf(matter, { referrerMeta: { industry: ctx.referrerIndustry } });
  const referrer = referral.referrerId ? metricKeyPart(referral.referrerId) : null;

  if (openedOn) {
    out.add(openedOn, 'matters.opened', 1).add(openedOn, `matters.opened.type.${type}`, 1);
    if (referrer) {
      out
        .add(openedOn, 'matters.opened.referred', 1)
        .add(openedOn, `matters.opened.referrer.${referrer}`, 1)
        .add(openedOn, `matters.opened.industry.${metricKeyPart(referral.industry ?? 'unknown')}`, 1);
    } else {
      out.add(openedOn, `matters.opened.source.${metricKeyPart(str(matter['referralSource']) ?? 'none')}`, 1);
    }
  }
  if (closedOn) {
    out.add(closedOn, 'matters.closed', 1).add(closedOn, `matters.closed.type.${type}`, 1);
    if (referrer) out.add(closedOn, `matters.closed.referrer.${referrer}`, 1);
  }

  const grantDate = (matter['estate'] as Data | undefined)?.['grantDate'];
  if (isDateOnly(grantDate)) {
    if (openedOn && grantDate >= openedOn)
      out.add(grantDate, daysKey(`cycle.${type}.instructionsToGrant`, daysBetween(openedOn, grantDate)), 1);
    const distributed = (matter['closing'] as Data | undefined)?.['finalDistributionRecorded'] === true;
    if (closedOn && distributed && closedOn >= grantDate)
      out.add(closedOn, daysKey(`cycle.${type}.grantToDistribution`, daysBetween(grantDate, closedOn)), 1);
  }

  for (const visit of ctx.stages ?? []) {
    if (!visit.leftOn) continue;
    const prefix = `stage.${type}.${metricKeyPart(visit.stageId)}`;
    out.add(visit.leftOn, daysKey(prefix, daysBetween(visit.enteredOn, visit.leftOn)), 1);
  }

  const legacy = matter['legacyBilling'] as Data | undefined;
  const billingDate = legacy?.['billingDate'];
  const legacyCents = legacyBilledCents(legacy);
  if (isDateOnly(billingDate) && legacyCents)
    out.add(billingDate, 'legacy.billed', 1).add(billingDate, 'legacy.billedCents', legacyCents);
  return out.cells;
}

const DEADLINE_COUNTED = new Set(['upcoming', 'done', 'missed', 'waived']);

/**
 * A deadline's figures on its due date (the date in force): due, met on time or late (by the day
 * `deadlines-complete` recorded), missed, waived and overridden, with the critical ones again.
 * Superseded and blocked (dateless) deadlines add nothing.
 */
export function deadlineMetrics(deadline: Data | undefined): MetricContribution {
  if (!deadline || isDeleted(deadline)) return {};
  const status = String(deadline['status'] ?? '');
  const due = deadline['dueDate'];
  if (!DEADLINE_COUNTED.has(status) || !isDateOnly(due)) return {};
  const critical = deadline['critical'] === true;
  const out = new Contribution();
  const add = (what: string, both = true) => {
    out.add(due, `deadlines.${what}`, 1);
    if (critical && both) out.add(due, `deadlines.critical.${what}`, 1);
  };
  add('due');
  if (status === 'done') {
    const on = (deadline['resolution'] as Data | undefined)?.['on'];
    add(isDateOnly(on) && on > due ? 'metLate' : 'metOnTime');
  }
  if (status === 'missed') add('missed');
  if (status === 'waived') add('waived', false);
  if (deadline['override']) add('overridden', false);
  return out.cells;
}

/** What a record's figures read besides the record itself. */
export interface MetricsLookups {
  /** The record's matter: its type labels time, its referrer the billing figures. */
  matter?: Data | undefined;
  /** The matter's referrer contact (CORE-18), for the industry. */
  referrer?: Data | null | undefined;
  timeZone?: string;
  /** The matter's stage history, for a matter (from its ledger). */
  stages?: readonly StageVisit[] | undefined;
}

/** Any record's figures, by kind: what the sync, the nightly recompute and the backfill all count. */
export function metricsContribution(
  kind: MetricsSourceKind,
  record: Data | undefined,
  lookups: MetricsLookups = {},
): MetricContribution {
  switch (kind) {
    case 'matter':
      return matterMetrics(record, {
        ...(lookups.timeZone ? { timeZone: lookups.timeZone } : {}),
        referrerIndustry: metricsReferralOf(record, lookups.referrer).industry,
        stages: lookups.stages,
      });
    case 'time':
      return timeEntryMetrics(record, lookups.matter);
    case 'disbursement':
      return disbursementMetrics(record);
    case 'deadline':
      return deadlineMetrics(record);
    case 'invoice':
      return invoiceMetrics(record, metricsReferralOf(lookups.matter, lookups.referrer));
    case 'creditNote':
      return creditNoteMetrics(record, metricsReferralOf(lookups.matter, lookups.referrer));
  }
}

/** The cells of a contribution whose day passes `keep` (the backfill restates from a date on). */
export function filterContribution(
  contribution: MetricContribution,
  keep: (date: DateOnly) => boolean,
): MetricContribution {
  const out: MetricContribution = {};
  for (const [cell, values] of Object.entries(contribution)) {
    const parsed = parseMetricCell(cell);
    if (parsed && keep(parsed.date)) out[cell] = { ...values };
  }
  return out;
}

// ---------- stage history ----------

/** Whether two stage histories are the same stays. */
export function sameStages(a: readonly StageVisit[] | undefined, b: readonly StageVisit[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every(
      (visit, i) =>
        visit.stageId === right[i]?.stageId &&
        visit.enteredOn === right[i]?.enteredOn &&
        (visit.leftOn ?? null) === (right[i]?.leftOn ?? null),
    )
  );
}

/** The most stage stays a matter's ledger keeps. */
export const STAGE_HISTORY_MAX = 100;

/**
 * The matter's stage history after a write: when its stage changed, the open stay ends on the day
 * the new stage was entered (`stageEnteredOn`, else `today`) and a new one opens. An unchanged
 * stage changes nothing, so the history only grows on real moves.
 */
export function nextStageHistory(
  history: readonly StageVisit[] | undefined,
  matter: Data | undefined,
  today: DateOnly,
): StageVisit[] {
  const visits = [...(history ?? [])];
  if (!matter || isDeleted(matter)) return visits;
  const stageId = str(matter['stageId']);
  const enteredOn = isDateOnly(matter['stageEnteredOn']) ? matter['stageEnteredOn'] : today;
  const open = visits.at(-1);
  if (open && !open.leftOn) {
    if (open.stageId === stageId) return visits;
    const leftOn = stageId ? enteredOn : today;
    visits[visits.length - 1] = { ...open, leftOn: leftOn < open.enteredOn ? open.enteredOn : leftOn };
  }
  if (stageId) visits.push({ stageId, enteredOn });
  return visits.slice(-STAGE_HISTORY_MAX);
}

// ---------- comparing and rolling up ----------

/** `next − previous`, by cell, keeping only what changed. */
export function diffContributions(next: MetricContribution, previous: MetricContribution): MetricContribution {
  const delta: MetricContribution = {};
  for (const cell of new Set([...Object.keys(next), ...Object.keys(previous)])) {
    const values = subtractMetricValues(next[cell] ?? {}, previous[cell] ?? {});
    if (Object.keys(values).length) delta[cell] = values;
  }
  return delta;
}

export const isEmptyContribution = (contribution: MetricContribution) =>
  Object.values(contribution).every((values) => Object.keys(values).length === 0);

/**
 * Rolls contributions up into period documents, keyed relative to `metrics/` (`day-2026-10-06`,
 * `month-2026-10/byMember/{uid}`). `keep` limits which periods are produced; a document whose
 * figures cancel out is left out (an empty `values` map written with `merge` would clear it).
 */
export function rollupMetrics(
  contributions: Iterable<MetricContribution>,
  fyStartMonth = 7,
  keep: (period: string) => boolean = () => true,
): Map<string, MetricValues> {
  const docs = new Map<string, MetricValues>();
  for (const contribution of contributions) {
    for (const [cell, values] of Object.entries(contribution)) {
      const parsed = parseMetricCell(cell);
      if (!parsed) continue;
      for (const period of Object.values(metricPeriods(parsed.date, fyStartMonth))) {
        if (!keep(period)) continue;
        const key = parsed.uid ? memberMetricsKey(period, parsed.uid) : period;
        const doc = docs.get(key) ?? {};
        addMetricValues(doc, values);
        docs.set(key, doc);
      }
    }
  }
  // Figures that cancel out (a record moved within a period) leave nothing to write.
  for (const [key, doc] of docs) if (!Object.keys(doc).length) docs.delete(key);
  return docs;
}

// ---------- snapshots ----------

/**
 * Matter snapshot figures at the end of `asOf`: matters open (opened on or before it and not yet
 * closed), by type, and, with `wip`, the current WIP (time and disbursements ex GST).
 */
export function matterSnapshotMetrics(
  matters: Iterable<Data>,
  asOf: DateOnly,
  options: { timeZone?: string; wip?: boolean } = {},
): MetricValues {
  const timeZone = options.timeZone ?? DEFAULT_ORG_TIMEZONE;
  const values: MetricValues = options.wip ? { 'wip.timeCents': 0, 'wip.disbursementsCents': 0 } : {};
  values['active.matters'] = 0;
  for (const matter of matters) {
    if (isDeleted(matter) || matter['destroyedAt']) continue;
    if (options.wip) {
      values['wip.timeCents'] = (values['wip.timeCents'] ?? 0) + num(matter['wipCents']);
      values['wip.disbursementsCents'] = (values['wip.disbursementsCents'] ?? 0) + num(matter['disbursementWipCents']);
    }
    const status = String(matter['status'] ?? '');
    if (!status || status === 'lead') continue;
    const openedOn = dayOfInstant(matter['createdAt'], timeZone);
    if (!openedOn || openedOn > asOf) continue;
    const closedOn = status === 'closed' || status === 'archived' ? dayOfInstant(matter['closedAt'], timeZone) : null;
    if (closedOn && closedOn <= asOf) continue;
    const type = `active.matters.type.${metricKeyPart(str(matter['type']) ?? 'unknown')}`;
    values['active.matters'] += 1;
    values[type] = (values[type] ?? 0) + 1;
  }
  return values;
}

/** Deadlines overdue at the end of `asOf`: due on or before it and not resolved by then. */
export function deadlineSnapshotMetrics(deadlines: Iterable<Data>, asOf: DateOnly): MetricValues {
  const values: MetricValues = { 'overdue.deadlines': 0, 'overdue.deadlines.critical': 0 };
  for (const deadline of deadlines) {
    if (isDeleted(deadline)) continue;
    const status = String(deadline['status'] ?? '');
    const due = deadline['dueDate'];
    if (!DEADLINE_COUNTED.has(status) || !isDateOnly(due) || due > asOf) continue;
    const resolvedOn = (deadline['resolution'] as Data | undefined)?.['on'];
    if (status !== 'upcoming' && (!isDateOnly(resolvedOn) || resolvedOn <= asOf)) continue;
    values['overdue.deadlines'] = (values['overdue.deadlines'] ?? 0) + 1;
    if (deadline['critical'] === true)
      values['overdue.deadlines.critical'] = (values['overdue.deadlines.critical'] ?? 0) + 1;
  }
  return values;
}

/** Clerk's monthly metering (`clerk-YYYY-MM`, AI-02 and AI-07) as `clerk.*` figures; per-user figures stay behind. */
export function clerkRollupValues(values: Data | undefined): MetricValues {
  const out: MetricValues = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'number' || key.startsWith('user.')) continue;
    out[`clerk.${key}`] = value;
  }
  return out;
}

/** The aged-debtors snapshot (`debtors-YYYY-MM-DD`, BILL-08) as `debtors.*` figures. */
export function debtorsRollupValues(values: Data | undefined): MetricValues {
  const out: MetricValues = {};
  for (const [key, value] of Object.entries(values ?? {})) if (typeof value === 'number') out[`debtors.${key}`] = value;
  return out;
}

/** What a period's snapshot figures are taken from. */
export interface SnapshotInput {
  matters: readonly Data[];
  deadlines: readonly Data[];
  /** The day they describe the end of. */
  asOf: DateOnly;
  timeZone?: string;
  /** WIP is only known now, so only the latest snapshot carries it. */
  wip?: boolean;
  /** Clerk's monthly metering documents' `values` to add up (one month, or an FY's months). */
  clerk?: readonly (Data | undefined)[];
  /** The aged-debtors document's `values` (BILL-08). */
  debtors?: Data | undefined;
}

/** A period's snapshot figures: active matters, overdue deadlines, aged debtors, Clerk's metering and, with `wip`, WIP. */
export function snapshotMetrics(input: SnapshotInput): MetricValues {
  const values: MetricValues = {
    ...matterSnapshotMetrics(input.matters, input.asOf, {
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      wip: input.wip === true,
    }),
    ...deadlineSnapshotMetrics(input.deadlines, input.asOf),
    ...debtorsRollupValues(input.debtors),
  };
  for (const clerk of input.clerk ?? []) addMetricValues(values, clerkRollupValues(clerk));
  return values;
}

// ---------- reading ----------

/** A histogram's buckets (`{prefix}.d{n}` → count), shortest first. */
export function metricHistogram(values: MetricValues, prefix: string): { days: number; count: number }[] {
  const buckets: { days: number; count: number }[] = [];
  for (const [key, count] of Object.entries(values)) {
    if (!key.startsWith(`${prefix}.d`) || count <= 0) continue;
    const days = Number(key.slice(prefix.length + 2));
    if (Number.isInteger(days)) buckets.push({ days, count });
  }
  return buckets.sort((a, b) => a.days - b.days);
}

/** The median of a days histogram (e.g. `cycle.probate.instructionsToGrant`), or null when empty. */
export function medianDays(values: MetricValues, prefix: string): number | null {
  const buckets = metricHistogram(values, prefix);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (!total) return null;
  const nth = (n: number) => {
    let seen = 0;
    for (const bucket of buckets) {
      seen += bucket.count;
      if (seen >= n) return bucket.days;
    }
    return buckets.at(-1)?.days ?? 0;
  };
  return total % 2 ? nth((total + 1) / 2) : (nth(total / 2) + nth(total / 2 + 1)) / 2;
}

/** Weekdays (Monday to Friday) from `start` to `end`, inclusive. */
export function workingDays(start: DateOnly, end: DateOnly): number {
  if (end < start) return 0;
  const span = daysBetween(start, end) + 1;
  let days = Math.floor(span / 7) * 5;
  for (let i = 0, day = addDays(start, Math.floor(span / 7) * 7); i < span % 7; i++, day = addDays(day, 1))
    if (weekday(day) <= 5) days++;
  return days;
}

/** A period's time target in minutes: its working days (up to `upTo`, for a period to date) at the daily target. */
export function periodTargetMinutes(
  period: string,
  dailyTargetMinutes: number,
  options: { fyStartMonth?: number; upTo?: DateOnly } = {},
): number {
  const range = metricPeriodRange(period, options.fyStartMonth ?? 7);
  if (!range) return 0;
  const end = options.upTo && options.upTo < range.end ? options.upTo : range.end;
  return workingDays(range.start, end) * Math.max(0, dailyTargetMinutes);
}

/** Utilisation: billable minutes over the target, as a whole percentage; null without a target. */
export function utilisationPct(billableMinutes: number, targetMinutes: number): number | null {
  return targetMinutes > 0 ? Math.round((billableMinutes * 100) / targetMinutes) : null;
}

// ---------- shards and visibility ----------

/** How many counter shards an org's period documents use: 10 above 20 active members, else none (1). */
export function metricShardCount(activeMembers: number): number {
  return activeMembers > METRIC_SHARD_MEMBER_THRESHOLD ? METRIC_SHARDS : 1;
}

/**
 * Who sees every member's figures under the org's `settings.insights.memberVisibility` (lawyers
 * and above by default). Role lists, not PERMISSIONS actions: firestore.rules spells them out,
 * because each action added to the generated `perm()` map costs every rule that calls `can()`, and
 * Clerk's message lists are at the rules' 1000-expression limit.
 */
export const MEMBER_METRICS_READERS: Readonly<Record<MemberMetricsVisibility, readonly Role[]>> = {
  lawyers: ['owner', 'admin', 'lawyer'],
  admins: ['owner', 'admin'],
  everyone: ROLES,
};

/** Whether `role` sees another member's figures (everyone sees their own); the rules mirror this. */
export function canSeeMemberMetrics(
  role: Role,
  visibility: MemberMetricsVisibility | undefined,
  self = false,
): boolean {
  return self || MEMBER_METRICS_READERS[visibility ?? 'lawyers'].includes(role);
}
