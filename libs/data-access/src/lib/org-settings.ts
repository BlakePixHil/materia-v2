import * as z from 'zod';

import { Org, OrgClerkSettingsSchema, withBoardWipLimit } from '@materia/domain';

import { repo, type Repository } from './repository';

const org = Org.schema.shape;

/**
 * What the matter numbering settings and the matter screen read from `orgs/{orgId}` (CORE-21a):
 * the number format and the `{TYPE}` codes.
 * Other org fields are dropped, not rejected.
 */
export const OrgNumberingSchema = /* @__PURE__ */ z.object({
  name: org.name,
  matterNumberFormat: org.matterNumberFormat,
  matterTypeCodes: org.matterTypeCodes,
});
export type OrgNumbering = z.infer<typeof OrgNumberingSchema>;

/**
 * The active org's own document, by the org id (`orgs/{orgId}`). Owners and admins update the
 * whitelisted settings client-direct (`Org.update`, `org.settings` in the rules); the audit
 * trigger records every change.
 */
export function orgSettingsRepository(): Repository<OrgNumbering> {
  return repo(() => 'orgs', { schema: OrgNumberingSchema, version: Org.version, update: Org.update });
}

/**
 * What Settings → Practice and Billing & rates read from `orgs/{orgId}` (CORE-21). Every field but
 * the name is optional, so an org made before a field existed still loads; the pages fill defaults.
 * These fields change only through `orgs-updateSettings`.
 */
export const OrgSettingsSchema = /* @__PURE__ */ z.object({
  name: org.name,
  abn: org.abn,
  jurisdictions: org.jurisdictions.optional(),
  primaryJurisdiction: org.primaryJurisdiction.optional(),
  timezone: z.string().optional(),
  holidayLocality: z.string().optional(),
  retentionYears: z.number().int().optional(),
  billing: org.billing.partial().optional(),
  feeDefaults: org.feeDefaults,
  fy: org.fy.optional(),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** The active org's settings, read-only here: saves go through `orgs-updateSettings`. */
export function orgSettingsReadRepository(): Repository<OrgSettings> {
  return repo(() => 'orgs', { schema: OrgSettingsSchema, version: Org.version });
}

/**
 * The org's referral settings (CORE-18): `settings` is read and written whole (the Clerk settings
 * in it are kept), so a change sends the current `settings` with `referrals` replaced.
 */
export const OrgReferralSettingsSchema = /* @__PURE__ */ z.object({ settings: org.settings });
export type OrgReferralSettings = z.infer<typeof OrgReferralSettingsSchema>;

/** The active org's document, read for its settings and updated as `orgSettingsRepository` is. */
export function orgReferralSettingsRepository(): Repository<OrgReferralSettings> {
  return repo(() => 'orgs', { schema: OrgReferralSettingsSchema, version: Org.version, update: Org.update });
}

/** The `settings` an update writes to turn the "Thank referrer" task on or off. */
export function withThankYouTask(
  settings: OrgReferralSettings['settings'],
  thankYouTask: boolean,
): NonNullable<OrgReferralSettings['settings']> {
  return { ...(settings ?? {}), referrals: { ...(settings?.referrals ?? {}), thankYouTask } } as NonNullable<
    OrgReferralSettings['settings']
  >;
}

/**
 * The Matters board's WIP limits (CORE-04a) sit in the same `settings` map, read and written whole
 * the same way, so a change keeps the Clerk and referral settings. Every member reads them.
 */
export function orgBoardSettingsRepository(): Repository<OrgReferralSettings> {
  return orgReferralSettingsRepository();
}

/** The `settings` an update writes to set one column's WIP limit, or (`null`) clear it. */
export function withBoardWipLimitSetting(
  settings: OrgReferralSettings['settings'],
  key: string,
  limit: number | null,
): NonNullable<OrgReferralSettings['settings']> {
  const wipLimits = withBoardWipLimit(settings?.board?.wipLimits, key, limit);
  return { ...(settings ?? {}), board: { ...(settings?.board ?? {}), wipLimits } } as NonNullable<
    OrgReferralSettings['settings']
  >;
}

/**
 * What Settings → Clerk and AI reads from `orgs/{orgId}` (AI-13): the org's Clerk switches, limits
 * and disclosure acknowledgement. Read-only here: they change through `clerk-updateSettings`.
 */
export const OrgClerkSettingsReadSchema = /* @__PURE__ */ z.object({
  name: org.name,
  settings: z.object({ clerk: OrgClerkSettingsSchema.optional() }).optional(),
});
export type OrgClerkSettingsRead = z.infer<typeof OrgClerkSettingsReadSchema>;

/** The active org's Clerk settings, by the org id. */
export function orgClerkSettingsRepository(): Repository<OrgClerkSettingsRead> {
  return repo(() => 'orgs', { schema: OrgClerkSettingsReadSchema, version: Org.version });
}

/**
 * A month of the org's Clerk metering (`orgs/{orgId}/metrics/clerk-{YYYY-MM}`, AI-02 and AI-07):
 * flat counters under `values`. Readable by roles with `billing.view`; written only by Functions.
 */
export const ClerkMetricsSchema = /* @__PURE__ */ z.object({
  period: z.string().optional(),
  values: z.record(z.string(), z.number()).default({}),
});
export type ClerkMetrics = z.infer<typeof ClerkMetricsSchema>;

export function clerkMetricsRepository(): Repository<ClerkMetrics> {
  return repo((orgId) => `orgs/${orgId}/metrics`, { schema: ClerkMetricsSchema, version: 1 });
}
