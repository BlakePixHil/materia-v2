import * as z from 'zod';

import { Matter, SoftDeleteShape } from '@materia/domain';

import { repo, type Repository } from './repository';

// Its own file, not the Matters list's: the sidebar loads with every page, and the list's
// filters would bring intake, contacts and phone numbers with it (MOB-02b, ADR-056).

const matter = Matter.schema.shape;

/**
 * A pinned matter as the sidebar names it (CORE-23): its number, title and type, its status, and
 * whether it is still live. Read one document at a time, by id.
 */
export const PinnedMatterSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  deletedAt: SoftDeleteShape.deletedAt,
  destroyedAt: matter.destroyedAt,
});
export type PinnedMatter = z.infer<typeof PinnedMatterSchema>;

/** The active org's matters, watched one at a time for the sidebar's Pinned section (CORE-23). */
export function pinnedMatterRepository(): Repository<PinnedMatter> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: PinnedMatterSchema, version: Matter.version });
}
