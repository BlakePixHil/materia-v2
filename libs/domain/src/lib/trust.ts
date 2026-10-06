import * as z from 'zod';

import { DocIdSchema } from './schemas/common';
import { TrustRecordsSystemSchema } from './schemas/enums';
import { DateOnlySchema, daysBetween, toDisplay, type DateOnly } from './values/date-only';
import { CentsSchema } from './values/money';

/**
 * Trust balance snapshots (BILL-11, ADR-035). Materia is never the trust ledger: a matter shows, at
 * most, the balance someone copied from the firm's own trust records, with its as-at date, the
 * records it came from and the words "Not the trust ledger". There are no trust transactions, no
 * running balance and no "available" amount anywhere. Behind `billing.trustDisplay`.
 */

export type TrustRecordsSystem = z.infer<typeof TrustRecordsSystemSchema>;

/** "Your trust records are kept in" (Settings → Trust account). */
export const TRUST_RECORDS_SYSTEMS: readonly { value: TrustRecordsSystem; label: string }[] = [
  { value: 'leap', label: 'LEAP' },
  { value: 'smokeball', label: 'Smokeball' },
  { value: 'actionstep', label: 'Actionstep' },
  { value: 'other', label: 'Other' },
];

export const DEFAULT_TRUST_STALE_DAYS = 30;

/** Shown wherever a snapshot appears. */
export const NOT_THE_TRUST_LEDGER = 'Not the trust ledger';

/** The fixed, non-editable text on Settings → Trust account (ADR-035). */
export const TRUST_EXPLAINER =
  'Materia shows a trust balance you copy from your trust records. It is not the trust ledger. Always check your trust records before paying money out.';

/** A billion dollars: anything larger is a typo. */
export const MAX_TRUST_BALANCE_CENTS = 100_000_000_000;

export const TRUST_NOTE_MAX = 200;
export const TRUST_OTHER_NAME_MAX = 60;

export const TRUST_CALLABLES = {
  recordSnapshot: 'trust-recordSnapshot',
  updateSettings: 'trust-updateSettings',
} as const;

/** The org's trust display settings (`orgs/{orgId}.trust`). */
export interface TrustSettings {
  showOnMatters: boolean;
  system: TrustRecordsSystem;
  otherName?: string | undefined;
  staleAfterDays: number;
}

export const TrustSettingsInput = z
  .object({
    showOnMatters: z.boolean(),
    system: TrustRecordsSystemSchema,
    otherName: z
      .string()
      .trim()
      .max(TRUST_OTHER_NAME_MAX, { message: `Up to ${TRUST_OTHER_NAME_MAX} characters` })
      .optional(),
    staleAfterDays: z.number().int().min(1, { message: 'Enter 1 to 365 days' }).max(365, {
      message: 'Enter 1 to 365 days',
    }),
  })
  .refine((settings) => settings.system !== 'other' || !!settings.otherName, {
    message: 'Name the trust records',
    path: ['otherName'],
  })
  // Drops the key, not just the value: callables send `undefined` as null.
  .transform(({ otherName, ...settings }): TrustSettings =>
    settings.system === 'other' && otherName ? { ...settings, otherName } : settings,
  ) satisfies z.ZodType<TrustSettings>;

/** `trust-updateSettings` (owners and admins). */
export const UpdateTrustSettingsInput = z.object({ requestId: z.uuid(), settings: TrustSettingsInput });
export type UpdateTrustSettingsInput = z.input<typeof UpdateTrustSettingsInput>;

/** `trust-recordSnapshot` (`trust.record` and `billing.view`). The as-at date is checked against the org's today. */
export const RecordTrustSnapshotInput = z.object({
  requestId: z.uuid(),
  matterId: DocIdSchema,
  amountCents: CentsSchema.refine((value) => value >= 0, { message: 'A trust balance can’t be negative' }).refine(
    (value) => value <= MAX_TRUST_BALANCE_CENTS,
    { message: 'That balance is too large' },
  ),
  asAt: DateOnlySchema,
  note: z.string().trim().max(TRUST_NOTE_MAX).optional(),
});
export type RecordTrustSnapshotInput = z.input<typeof RecordTrustSnapshotInput>;

export interface TrustSaveResult {
  saved: boolean;
}

/** The org's settings, with the defaults for an org that never saved them (off). */
export function trustSettingsOf(org: { trust?: Partial<TrustSettings> | undefined } | null | undefined): TrustSettings {
  const trust = org?.trust;
  return {
    showOnMatters: trust?.showOnMatters ?? false,
    system: trust?.system ?? 'other',
    otherName: trust?.otherName,
    staleAfterDays: trust?.staleAfterDays ?? DEFAULT_TRUST_STALE_DAYS,
  };
}

/** The records' name, as each snapshot carries it ("Smokeball", or what the firm typed). */
export function trustRecordsName(settings: Pick<TrustSettings, 'system' | 'otherName'>): string {
  if (settings.system === 'other') return settings.otherName?.trim() || 'Trust records';
  return TRUST_RECORDS_SYSTEMS.find((system) => system.value === settings.system)?.label ?? 'Trust records';
}

/** Why an as-at date can't be used, or null. Long-past dates are fine (they show as out of date). */
export function asAtProblem(asAt: DateOnly, today: DateOnly): string | null {
  return asAt > today ? 'The as-at date can’t be in the future' : null;
}

/** A snapshot older than the threshold shows the amber "Out of date" chip. */
export function trustSnapshotOutOfDate(asAt: DateOnly, today: DateOnly, staleAfterDays: number): boolean {
  return daysBetween(asAt, today) > staleAfterDays;
}

/** "as at 3 Oct 2026 · from Smokeball". */
export function trustSnapshotLine(snapshot: { asAt: DateOnly; sourceSystemName: string }): string {
  return `as at ${toDisplay(snapshot.asAt)} · from ${snapshot.sourceSystemName}`;
}
