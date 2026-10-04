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
    abn: z.string().regex(/^\d{11}$/, { message: 'ABN is 11 digits' }),
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
    settings: z.object({ clerk: z.object({ enabled: z.boolean() }).optional() }).optional(),
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
  { path: 'orgs/{orgId}/members' },
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
  },
  { path: 'orgs/{orgId}/invites', serverOwned: ['tokenHash', 'status', 'invitedBy', 'expiresAt'], updatable: ['role'] },
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
    serverOwned: ['orgIds', 'claimsVersion', 'legacy'],
    updatable: ['displayName', 'firstName', 'lastName', 'activeOrgId', 'prefs'],
  },
);

export type Org = z.infer<typeof Org.schema>;
export type Member = z.infer<typeof Member.schema>;
export type Invite = z.infer<typeof Invite.schema>;
export type User = z.infer<typeof User.schema>;
