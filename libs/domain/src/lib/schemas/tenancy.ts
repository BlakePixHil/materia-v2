import { z } from 'zod';

import { DEFAULT_ORG_TIMEZONE } from '../constants';
import { CentsSchema, DateOnlySchema, DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import {
  InviteStatusSchema,
  JurisdictionSchema,
  MemberStatusSchema,
  RoleSchema,
  RoundingSchema,
  ThemeSchema,
} from './enums';

/** `orgs/{orgId}`: the firm. */
export const Org = withMeta(
  {
    name: NonEmptyString,
    /** Optional at onboarding (FND-17); set later in org settings. */
    abn: z
      .string()
      .regex(/^\d{11}$/, { message: 'ABN is 11 digits' })
      .optional(),
    acn: z
      .string()
      .regex(/^\d{9}$/)
      .optional(),
    practiceType: z.enum(['wills_estates', 'general', 'other']),
    jurisdictions: z.array(JurisdictionSchema).min(1),
    primaryJurisdiction: JurisdictionSchema,
    timezone: z.string().default(DEFAULT_ORG_TIMEZONE),
    holidayLocality: z.string().min(1),
    billing: z.object({
      unitMinutes: z.number().int().positive().default(6),
      rounding: RoundingSchema,
      gstRegistered: z.boolean(),
      defaultRateCents: CentsSchema,
      invoicePrefix: z.string().max(10),
      paymentTermsDays: z.number().int().min(0).max(365),
    }),
    matterNumberFormat: z.string().min(1).default('M-{YYYY}-{seq:4}'),
    fy: z.object({ startMonth: z.number().int().min(1).max(12) }),
    retentionYears: z.number().int().min(1).default(7),
    plan: z.enum(['trial', 'standard', 'enterprise']),
    security: z.object({ mfaRequired: z.boolean(), sessionIdleMinutes: z.number().int().positive() }),
    settings: z
      .object({
        clerk: z
          .object({
            /** The org's own Clerk switch (AI-13 builds the toggle); `false` turns Clerk off for the org. */
            enabled: z.boolean(),
            /** Monthly token budget (all token kinds); the gateway default applies when unset. */
            monthlyTokenBudget: z.number().int().positive().optional(),
            /** Per-user request window; the gateway default (30 per 10 minutes) applies when unset. */
            userRateLimit: z
              .object({ requests: z.number().int().positive(), windowMinutes: z.number().int().positive() })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    /** Per-org feature flag overrides (FND-23), written only by `flags-setOrgOverride`. */
    flags: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
    legalHold: z.object({ on: z.boolean(), reason: z.string(), by: z.string(), at: InstantSchema }).optional(),
    deletionScheduledAt: InstantSchema.optional(),
    termsAcceptedVersion: z.string().optional(),
  },
  {
    path: 'orgs',
    serverOwned: ['legalHold', 'deletionScheduledAt', 'flags'],
  },
);

/** `orgs/{orgId}/members/{uid}`. */
export const Member = withMeta(
  {
    role: RoleSchema,
    status: MemberStatusSchema,
    /** Lower-case sign-in email, shown in the team list to tell apart members with the same name (FND-17). */
    email: z
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    displayName: NonEmptyString,
    initials: z.string().min(1).max(3),
    title: z.string(),
    admissionNo: z.string().optional(),
    defaultRateCents: CentsSchema,
    rates: z.array(z.object({ effectiveFrom: DateOnlySchema, rateCents: CentsSchema })).default([]),
    colour: z.string(),
    budgets: z.record(z.string().regex(/^\d{4}$/), CentsSchema).default({}),
    supervisorUid: DocIdSchema.optional(),
  },
  {
    path: 'orgs/{orgId}/members',
    // Role and status change only through the orgs-* callables, which keep the last-owner invariant
    // and the custom claims in step (FND-17).
    serverOwned: ['role', 'status', 'email'],
  },
);

/** `orgs/{orgId}/invites/{inviteId}`. The raw token is never stored, only its hash. */
export const Invite = withMeta(
  {
    email: z.email().transform((value) => value.toLowerCase()),
    role: RoleSchema,
    tokenHash: z.string().min(32),
    expiresAt: InstantSchema,
    status: InviteStatusSchema,
    invitedBy: DocIdSchema,
    /** Who accepted it and when (FND-17); accepting again is a no-op for them. */
    acceptedBy: DocIdSchema.optional(),
    acceptedAt: InstantSchema.optional(),
  },
  {
    path: 'orgs/{orgId}/invites',
    serverOwned: ['tokenHash', 'status', 'invitedBy', 'expiresAt', 'acceptedBy', 'acceptedAt'],
    updatable: ['role'],
  },
);

/** `users/{uid}`: profile and preferences (user-scoped, not org-scoped). */
export const User = withMeta(
  {
    email: z.email().transform((value) => value.toLowerCase()),
    displayName: NonEmptyString,
    firstName: z.string(),
    lastName: z.string(),
    orgIds: z.array(DocIdSchema),
    activeOrgId: DocIdSchema.nullable(),
    claimsVersion: z.number().int().min(0).default(0),
    /**
     * Active memberships with the org name, for the org switcher (FND-17). Mirrors the `orgs` claim,
     * which carries roles only; written by `auth-syncClaims`.
     */
    memberships: z.record(DocIdSchema, z.object({ role: RoleSchema, name: z.string() })).default({}),
    prefs: z.object({
      theme: ThemeSchema,
      density: z.enum(['comfortable', 'compact']),
      shortcuts: z.boolean(),
      notifications: z.object({
        email: z.boolean(),
        push: z.boolean(),
        digestHour: z.number().int().min(0).max(23),
      }),
    }),
    legacy: z.object({ uid: z.string(), migratedAt: InstantSchema }).optional(),
  },
  {
    path: 'users',
    // The active org changes only through `orgs-switchActiveOrg`, which also sets the claims.
    serverOwned: ['orgIds', 'activeOrgId', 'claimsVersion', 'memberships', 'legacy'],
    updatable: ['displayName', 'firstName', 'lastName', 'prefs'],
  },
);

export type Org = z.infer<typeof Org.schema>;
export type Member = z.infer<typeof Member.schema>;
export type Invite = z.infer<typeof Invite.schema>;
export type User = z.infer<typeof User.schema>;
