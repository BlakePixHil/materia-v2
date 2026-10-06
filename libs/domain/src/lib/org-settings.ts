import * as z from 'zod';

import { DEFAULT_ORG_TIMEZONE } from './constants';
import { isMatterNumberFormat } from './matters';
import { validTimeZone } from './notifications';
import { CentsSchema, DocIdSchema, NonEmptyString } from './schemas/common';
import { JurisdictionSchema, MatterTypeSchema, RoundingSchema } from './schemas/enums';
import { FeeDefaultsSchema, MatterTypeCodeSchema } from './schemas/tenancy';
import type { DateOnly } from './values/date-only';

/**
 * Org settings (CORE-21): the practice, billing and fee defaults that owners and admins edit in
 * Settings, the ABN checksum and financial-year helpers, and the `orgs-updateSettings` input.
 */

/** Records are kept at least this long after a matter closes (the practitioner's obligation). */
export const MIN_RETENTION_YEARS = 7;

/** Holiday localities for reminders (not court deadlines): the locality's own public holidays. */
export const HOLIDAY_LOCALITIES = [
  { value: 'VIC_MELBOURNE', label: 'Melbourne (Melbourne Cup Day)' },
  { value: 'VIC_GREATER_GEELONG', label: 'Greater Geelong (Geelong Cup Day)' },
] as const;
export type HolidayLocality = (typeof HOLIDAY_LOCALITIES)[number]['value'];
export const HolidayLocalitySchema = z.enum(HOLIDAY_LOCALITIES.map((l) => l.value) as [HolidayLocality]);

/** Billing units offered in settings, in minutes. */
export const BILLING_UNIT_OPTIONS = [1, 6, 10, 15] as const;

/** The digits of an ABN, without spaces. */
export function normaliseAbn(value: string): string {
  return value.replace(/\s/g, '');
}

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/**
 * The ATO's ABN check: subtract 1 from the first digit, weight the 11 digits, and the sum must
 * divide by 89.
 */
export function isValidAbn(value: string): boolean {
  const abn = normaliseAbn(value);
  if (!/^\d{11}$/.test(abn)) return false;
  const digits = [...abn].map(Number);
  digits[0] = (digits[0] as number) - 1;
  const sum = digits.reduce((total, digit, i) => total + digit * (ABN_WEIGHTS[i] as number), 0);
  return sum % 89 === 0;
}

/** "51824753556" → "51 824 753 556". Anything that isn't 11 digits comes back as it was. */
export function formatAbn(value: string): string {
  const abn = normaliseAbn(value);
  return /^\d{11}$/.test(abn) ? `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}` : value;
}

/** Why an ABN can't be saved, or null (empty is fine: the ABN is optional). */
export function abnProblem(value: string): string | null {
  const abn = normaliseAbn(value);
  if (!abn) return null;
  if (!/^\d{11}$/.test(abn)) return 'An ABN is 11 digits.';
  return isValidAbn(abn) ? null : 'This isn’t a valid ABN. Check the digits.';
}

/**
 * A matter number format that is valid but may repeat numbers: without `{YYYY}` or `{YY}` the
 * running number restarts each year, so next year's first number is this year's first number.
 */
export function matterNumberFormatWarning(format: string): string | null {
  const trimmed = format.trim();
  if (!isMatterNumberFormat(trimmed)) return null;
  if (/\{(YYYY|YY)\}/.test(trimmed)) return null;
  return 'Without {YYYY} or {YY}, the running number restarts each year, so a number could repeat. A repeat is refused when the matter is created.';
}

/**
 * The financial year a date falls in, as the year it starts (`budgets[fyStartYear]`). The year
 * starts in July by default, so 2026-08-01 and 2027-06-30 are both 2026 (FY2026–27).
 */
export function fyStartYear(date: DateOnly, startMonth = 7): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}

/** "FY2026–27" for the year starting in 2026 (en dash). A calendar FY (January) is "FY2026". */
export function fyLabel(startYear: number, startMonth = 7): string {
  if (startMonth === 1) return `FY${startYear}`;
  return `FY${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Australian zones first, then every other zone the runtime knows. */
export function timeZoneOptions(): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const australian = all.filter((zone) => zone.startsWith('Australia/'));
  const rest = all.filter((zone) => !zone.startsWith('Australia/'));
  const first = australian.length ? australian : [DEFAULT_ORG_TIMEZONE];
  return [...first, ...rest];
}

const TimeZoneSchema = z
  .string()
  .min(1)
  .refine((zone) => validTimeZone(zone) === zone, { message: 'Choose a time zone from the list' });

/** Settings → Practice. */
export const PracticeSettingsInput = z
  .object({
    name: NonEmptyString.max(120),
    /** Empty removes the ABN. */
    abn: z
      .string()
      .transform(normaliseAbn)
      .refine((abn) => abn === '' || isValidAbn(abn), { message: 'This isn’t a valid ABN' }),
    primaryJurisdiction: JurisdictionSchema,
    jurisdictions: z.array(JurisdictionSchema).min(1),
    timezone: TimeZoneSchema,
    holidayLocality: HolidayLocalitySchema,
    retentionYears: z.number().int().min(MIN_RETENTION_YEARS).max(100),
  })
  .refine((p) => p.jurisdictions.includes(p.primaryJurisdiction), {
    message: 'The primary jurisdiction must be one of the practice’s jurisdictions',
    path: ['jurisdictions'],
  });

/** Settings → Billing & rates. */
export const BillingSettingsInput = z.object({
  defaultRateCents: CentsSchema.refine((value) => value >= 0, { message: 'A rate can’t be negative' }),
  unitMinutes: z.number().int().min(1).max(60),
  rounding: RoundingSchema,
  gstRegistered: z.boolean(),
  invoicePrefix: z
    .string()
    .trim()
    .max(10)
    .regex(/^[A-Za-z0-9-]*$/, { message: 'Use letters, digits and hyphens' }),
  paymentTermsDays: z.number().int().min(0).max(365),
  /** The daily time target (BILL-03), in minutes; 6 hours when unset. */
  dailyTargetMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
});

/**
 * `orgs-updateSettings` (CORE-21): any of the groups. `dryRun` checks the change and reports what
 * it would do (reminders to reschedule, matters using a removed jurisdiction) without saving.
 */
export const UpdateOrgSettingsInput = z.object({
  requestId: z.uuid(),
  practice: PracticeSettingsInput.optional(),
  billing: BillingSettingsInput.optional(),
  feeDefaults: FeeDefaultsSchema.optional(),
  matterNumberFormat: z
    .string()
    .trim()
    .refine(isMatterNumberFormat, { message: 'Include {seq} and only known tokens' })
    .optional(),
  matterTypeCodes: z.partialRecord(MatterTypeSchema, MatterTypeCodeSchema).optional(),
  /** The next invoice number; only before the first invoice (numbers are gapless). */
  nextInvoiceNumber: z.number().int().min(1).max(9_999_999).optional(),
  dryRun: z.boolean().default(false),
});
export type UpdateOrgSettingsInput = z.input<typeof UpdateOrgSettingsInput>;

/** What a settings change does, as `orgs-updateSettings` reports it. */
export interface OrgSettingsImpact {
  /** Upcoming deadlines whose reminders move (time zone or holiday locality changed). */
  remindersRescheduled: number;
  /** Matters still open in a jurisdiction being removed: the change is refused while there are any. */
  jurisdictionInUse: { matterId: string; number: string; title: string; jurisdiction: string }[];
  gstChanged: boolean;
  /** The fields that change. */
  changed: string[];
}

export interface UpdateOrgSettingsResult {
  saved: boolean;
  impact: OrgSettingsImpact;
}

/** `orgs-memberSecurity` (CORE-21): MFA and last sign-in from Auth, for the team table. */
export const MemberSecurityInput = z.object({ uids: z.array(DocIdSchema).min(1).max(100) });
export interface MemberSecurity {
  uid: string;
  mfaEnrolled: boolean;
  /** ISO instants, or null when unknown. */
  lastSignInAt: string | null;
  lastActiveAt: string | null;
}
