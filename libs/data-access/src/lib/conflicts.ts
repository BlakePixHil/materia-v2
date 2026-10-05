import * as z from 'zod';

import { Matter, SoftDeleteShape } from '@materia/domain';

import { repo, type Repository } from './repository';

const matter = Matter.schema.shape;

/**
 * A conflict alert the server leaves on a matter (CORE-02): a party added after the check matched
 * someone on another matter. Read leniently (every field optional) so an older or newer server
 * shape never hides the matter.
 */
export const ConflictAlertSchema = /* @__PURE__ */ z.object({
  checkId: z.string().optional(),
  contactId: z.string().optional(),
  at: z.date().optional(),
  /** Truthy when an adverse role was found (the adverse-role label, or `true`). */
  adverse: z.union([z.boolean(), z.string()]).optional(),
});
export type ConflictAlert = z.infer<typeof ConflictAlertSchema>;

/**
 * What the conflict check reads from `orgs/{orgId}/matters/{id}` (CORE-02): the matter's name and
 * status, the contacts to check (clients, the deceased, the testator) and the current
 * determination. Other fields are dropped, not rejected.
 */
export const MatterConflictSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  clientContactIds: matter.clientContactIds,
  deceased: z.object({ contactId: z.string() }).optional(),
  testator: matter.testator,
  conflictCheck: matter.conflictCheck.optional(),
  conflictAlert: ConflictAlertSchema.nullable().optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterConflict = z.infer<typeof MatterConflictSchema>;

/** Matters, read for their conflict check (no writes: determinations go through `conflicts-determine`). */
export function matterConflictsRepository(): Repository<MatterConflict> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: MatterConflictSchema, version: Matter.version });
}

/** The `conflicts-*` callables (built in apps/functions/src/conflicts, CORE-02). */
export const CONFLICT_CALLABLES = {
  /** `RunConflictCheckInput` → `RunConflictCheckResult` (paralegal and above). */
  run: 'conflicts-run',
  /** `DetermineConflictInput` → `DetermineConflictResult` (lawyer and above). */
  determine: 'conflicts-determine',
} as const;
