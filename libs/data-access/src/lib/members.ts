import { z } from 'zod';

import { Member } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const shape = Member.schema.shape;

/**
 * What the team list reads from `orgs/{orgId}/members/{uid}`: the fields it shows, validated by the
 * `libs/domain` Member schema, plus the rate, budgets and supervisor that owners and admins edit
 * there (CORE-21). Other fields are dropped, not rejected.
 */
export const MemberListItemSchema = /* @__PURE__ */ z.object({
  displayName: shape.displayName,
  email: shape.email,
  role: shape.role,
  status: shape.status,
  initials: shape.initials.optional(),
  colour: shape.colour.optional(),
  title: shape.title.optional(),
  defaultRateCents: shape.defaultRateCents.optional(),
  rates: shape.rates.optional(),
  budgets: shape.budgets.optional(),
  supervisorUid: shape.supervisorUid,
});
export type MemberListItem = z.infer<typeof MemberListItemSchema>;

/** Current members (removed ones hidden), by name. Index: members (status, displayName). */
export const MEMBER_LIST_QUERY: QuerySpec<MemberListItem> = {
  where: [['status', 'in', ['active', 'suspended']]],
  orderBy: [['displayName', 'asc']],
  pageSize: 25,
};

/**
 * The members repository: the worked example of the data layer (FND-19), used by the team page.
 * Owners and admins update a member's rate, budgets and supervisor client-direct (`Member.update`,
 * `members.manage` in the rules; CORE-21). Call it in an injection context.
 */
export function membersRepository(): Repository<MemberListItem> {
  return repo((orgId) => `orgs/${orgId}/members`, {
    schema: MemberListItemSchema,
    version: Member.version,
    update: Member.update,
  });
}
