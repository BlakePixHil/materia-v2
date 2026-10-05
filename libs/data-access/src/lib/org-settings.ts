import { z } from 'zod';

import { Org } from '@materia/domain';

import { repo, type Repository } from './repository';

const org = Org.schema.shape;

/**
 * What the matter numbering settings and the matter screen read from `orgs/{orgId}` (CORE-21a):
 * the number format, the `{TYPE}` codes and the firm's other system (its name and link template).
 * Other org fields are dropped, not rejected.
 */
export const OrgNumberingSchema = /* @__PURE__ */ z.object({
  name: org.name,
  matterNumberFormat: org.matterNumberFormat,
  matterTypeCodes: org.matterTypeCodes,
  externalSystem: org.externalSystem,
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
