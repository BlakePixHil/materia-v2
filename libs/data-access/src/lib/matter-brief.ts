import * as z from 'zod';

import { MATTER_BRIEF_CALLABLES, MatterBrief, type MatterBriefInput, type MatterBriefResult } from '@materia/domain';

import type { CallableClient } from './callable-client';
import { repo, type Repository } from './repository';

const brief = MatterBrief.schema.shape;

/**
 * What the Overview reads from `matters/{matterId}/briefs/latest` (AI-06c): the brief as it was
 * last written, shown at once while `clerk-matterBrief` checks it is current.
 */
export const MatterBriefDocSchema = /* @__PURE__ */ z.object({
  source: brief.source,
  reason: brief.reason,
  headline: brief.headline,
  items: brief.items,
  read: brief.read,
  day: brief.day,
  privileged: brief.privileged,
  generatedAt: brief.generatedAt,
  refreshes: brief.refreshes,
  pendingUntil: brief.pendingUntil,
});
export type MatterBriefDoc = z.infer<typeof MatterBriefDocSchema>;

/** A matter's brief documents; the Overview watches `latest`. */
export function matterBriefRepository(matterId: () => string | null): Repository<MatterBriefDoc> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/briefs`, {
    schema: MatterBriefDocSchema,
    version: MatterBrief.version,
  });
}

/** `clerk-matterBrief` (AI-06c). */
export interface MatterBriefCallables {
  /**
   * `open` returns the brief, rebuilding it when it is stale (the Overview calls it each time it
   * opens); `refresh` rebuilds it now, three times a day per matter.
   */
  brief(input: MatterBriefInput): Promise<MatterBriefResult>;
}

export function matterBriefCallables(client: Pick<CallableClient, 'call'>): MatterBriefCallables {
  return {
    brief: (input) => client.call<MatterBriefInput, MatterBriefResult>(MATTER_BRIEF_CALLABLES.brief, input),
  };
}
