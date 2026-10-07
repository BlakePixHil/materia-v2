import * as z from 'zod';

import { DEFAULT_ORG_TIMEZONE } from './constants';
import { DocIdSchema } from './schemas/common';
import { JurisdictionSchema, RoleSchema, type Role } from './schemas/enums';

/**
 * Organisations, membership and invites (FND-17, ADR-005): the limits, the callable inputs shared
 * by functions and the web app, and the custom-claims calculation.
 */

/** Invites expire after seven days. */
export const INVITE_TTL_DAYS = 7;
/** Pending invites allowed per org at once. */
export const MAX_PENDING_INVITES = 50;
/** Firebase rejects custom claims over 1000 bytes (serialised JSON). */
export const CLAIMS_MAX_BYTES = 1000;
/**
 * With more memberships than this, the `orgs` claim carries only the active org; rules and
 * functions read the member documents for the others (a documented limitation).
 */
export const CLAIMS_MAX_ORGS = 20;
/** The active org's name is in the claim for the shell; longer names are cut. */
export const CLAIMS_ORG_NAME_CHARS = 60;

/** Timezones offered at onboarding (Australian practices). */
export const ORG_TIMEZONES = [
  'Australia/Melbourne',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Hobart',
] as const;

const RequestId = z.uuid();
const Email = z.string().trim().toLowerCase().max(320).pipe(z.email());

export const CreateOrgInput = z.object({
  requestId: RequestId,
  name: z.string().trim().min(1).max(120),
  abn: z
    .string()
    .transform((value) => value.replace(/\s/g, ''))
    .pipe(z.string().regex(/^\d{11}$/, { message: 'ABN is 11 digits' }))
    .optional(),
  primaryJurisdiction: JurisdictionSchema,
  timezone: z.enum(ORG_TIMEZONES).default(DEFAULT_ORG_TIMEZONE),
  /**
   * The terms of service version (`TERMS_VERSION`, SEC-01) the creating owner ticked to accept on the
   * practice's behalf. Recorded on the org; without it the owner is asked before using the app.
   */
  acceptTermsVersion: z.string().trim().min(1).max(20).optional(),
});

export const InviteMemberInput = z.object({ requestId: RequestId, email: Email, role: RoleSchema });
/** The invite link carries the token; only its SHA-256 is stored. */
export const AcceptInviteInput = z.object({
  requestId: RequestId,
  inviteId: DocIdSchema,
  token: z.string().min(32).max(100),
});
export const InviteRefInput = z.object({ requestId: RequestId, inviteId: DocIdSchema });
export const ChangeRoleInput = z.object({ requestId: RequestId, uid: DocIdSchema, role: RoleSchema });
/** `suspended: false` reinstates a suspended member. */
export const SuspendMemberInput = z.object({
  requestId: RequestId,
  uid: DocIdSchema,
  suspended: z.boolean().default(true),
});
export const MemberRefInput = z.object({ requestId: RequestId, uid: DocIdSchema });
export const TransferOwnershipInput = z.object({ requestId: RequestId, toUid: DocIdSchema });
export const SwitchActiveOrgInput = z.object({ requestId: RequestId, orgId: DocIdSchema });

export type CreateOrgInput = z.input<typeof CreateOrgInput>;
export type InviteMemberInput = z.input<typeof InviteMemberInput>;

/** An active membership as the claims see it. */
export interface MembershipRole {
  orgId: string;
  role: Role;
  name: string;
}

/** The tenancy custom claims (ADR-005). Other claims (`platformAdmin`) are kept as they are. */
export interface TenancyClaims {
  orgId?: string;
  role?: Role;
  orgName?: string;
  orgs?: Record<string, Role>;
}

export const TENANCY_CLAIM_KEYS = ['orgId', 'role', 'orgName', 'orgs'] as const;

/** The active org: the preferred one while it is still active, otherwise the first active one. */
export function pickActiveOrg(memberships: readonly MembershipRole[], preferred: string | null): string | null {
  if (preferred && memberships.some((m) => m.orgId === preferred)) return preferred;
  return memberships[0]?.orgId ?? null;
}

/**
 * The claims for a set of active memberships: `orgId`, `role` and `orgName` from the active org,
 * `orgs` mapping every active membership to its role. Over CLAIMS_MAX_ORGS memberships (or if the
 * result would still exceed the size limit) `orgs` keeps only the active org.
 */
export function computeClaims(memberships: readonly MembershipRole[], activeOrgId: string | null): TenancyClaims {
  const active = memberships.find((m) => m.orgId === activeOrgId);
  if (!active) return {};
  const base = {
    orgId: active.orgId,
    role: active.role,
    orgName: active.name.slice(0, CLAIMS_ORG_NAME_CHARS),
  };
  const all: TenancyClaims = {
    ...base,
    orgs: Object.fromEntries(memberships.map((m) => [m.orgId, m.role])),
  };
  if (memberships.length <= CLAIMS_MAX_ORGS && claimsBytes(all) < CLAIMS_MAX_BYTES) return all;
  return { ...base, orgs: { [active.orgId]: active.role } };
}

/** The serialised size Firebase checks against its 1000-byte limit. */
export function claimsBytes(claims: object): number {
  return new TextEncoder().encode(JSON.stringify(claims)).length;
}
