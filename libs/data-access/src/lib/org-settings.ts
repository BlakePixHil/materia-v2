import * as z from 'zod';

import { Org } from '@materia/domain';

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
