import * as z from 'zod';

import { DocIdSchema, InstantSchema } from './schemas/common';

/**
 * `orgs/{orgId}.settings.connector` (the Claude connector, INT-07, ADR-064): whether members may
 * connect Claude, and whether Claude may suggest changes. Off until an owner or admin turns it on;
 * written only by `connector-setPractice`, which revokes every connection when it turns the
 * connector off. Apart from connector.ts so the org schema doesn't load the connector's schemas.
 */
export const OrgConnectorSettingsSchema = z.object({
  enabled: z.boolean(),
  allowProposals: z.boolean(),
  updatedBy: DocIdSchema.optional(),
  updatedAt: InstantSchema.optional(),
});
export type OrgConnectorSettings = z.infer<typeof OrgConnectorSettingsSchema>;

export interface ResolvedConnectorSettings {
  enabled: boolean;
  allowProposals: boolean;
}

/**
 * The two switches, from the app's converted read or the server's raw one. Only the switches are
 * read: on the server `updatedAt` is a Firestore Timestamp, which the schema's Date would refuse.
 */
export function resolveConnectorSettings(raw: unknown): ResolvedConnectorSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<Record<string, unknown>>) : {};
  return { enabled: value['enabled'] === true, allowProposals: value['allowProposals'] !== false };
}
