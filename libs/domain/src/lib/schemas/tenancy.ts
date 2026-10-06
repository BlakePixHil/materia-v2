import * as z from 'zod';

import { ClerkModelChoiceSchema, DEFAULT_CLERK_MODEL } from '../clerk';
import { DEFAULT_ORG_TIMEZONE } from '../constants';
import { NotificationPrefsSchema } from '../notifications';
import { OrgSecuritySchema } from '../security';
import { CentsSchema, DateOnlySchema, DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import {
  InviteStatusSchema,
  JurisdictionSchema,
  MatterTypeSchema,
  MemberStatusSchema,
  RoleSchema,
  RoundingSchema,
  ThemeSchema,
  TrustRecordsSystemSchema,
} from './enums';

/** A matter number `{TYPE}` code (CORE-21a): 1 to 6 letters or digits. */
export const MatterTypeCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,6}$/, { message: 'Use 1 to 6 letters or digits' });

/** A matter type's default fee arrangement and estimate (CORE-21), prefilled at intake (CORE-05). */
// A conditional arrangement needs the matter's own condition, so it can't be a default.
export const FeeDefaultSchema = z
  .object({
    arrangement: z.enum(['hourly', 'fixed', 'capped', 'pro_bono']),
    amountCents: CentsSchema.optional(),
    capCents: CentsSchema.optional(),
    estimateCents: CentsSchema.optional(),
  })
  .refine((fee) => fee.arrangement !== 'fixed' || fee.amountCents !== undefined, {
    message: 'Enter the fixed fee',
    path: ['amountCents'],
  })
  .refine((fee) => fee.arrangement !== 'capped' || fee.capCents !== undefined, {
    message: 'Enter the cap',
    path: ['capCents'],
  });
export type FeeDefault = z.infer<typeof FeeDefaultSchema>;
export const FeeDefaultsSchema = z.partialRecord(MatterTypeSchema, FeeDefaultSchema);
export type FeeDefaults = z.infer<typeof FeeDefaultsSchema>;

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
      /** Budget alert thresholds, percent of the fee basis (BILL-05); 80 and 100 when unset. */
      budgetAlertPcts: z.array(z.number().int().min(1).max(200)).max(5).optional(),
      /** The daily time target on the Time and billing screen (BILL-03); 6 hours when unset. */
      dailyTargetMinutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60)
        .optional(),
    }),
    matterNumberFormat: z.string().min(1).default('M-{YYYY}-{seq:4}'),
    /** `{TYPE}` codes that replace DEFAULT_MATTER_TYPE_CODES in matter numbers (CORE-21a). */
    matterTypeCodes: z.partialRecord(MatterTypeSchema, MatterTypeCodeSchema).optional(),
    /** Each matter type's default fee arrangement and estimate (CORE-21), prefilled at intake. */
    feeDefaults: FeeDefaultsSchema.optional(),
    fy: z.object({ startMonth: z.number().int().min(1).max(12) }),
    retentionYears: z.number().int().min(1).default(7),
    plan: z.enum(['trial', 'standard', 'enterprise']),
    /** Security policies (SEC-04), written only by `security-updatePolicy`. */
    security: OrgSecuritySchema,
    settings: z
      .object({
        clerk: z
          .object({
            /** The org's own Clerk switch (AI-13 builds the toggle); `false` turns Clerk off for the org. */
            enabled: z.boolean().optional(),
            /** The model Clerk runs on (AI-02a): Sonnet 5.5 unless an admin opts into Opus 5.5 (`clerk-setModel`). */
            model: ClerkModelChoiceSchema.default(DEFAULT_CLERK_MODEL),
            /** Monthly token budget (all token kinds); the gateway default applies when unset. */
            monthlyTokenBudget: z.number().int().positive().optional(),
            /** Per-user request window; the gateway default (30 per 10 minutes) applies when unset. */
            userRateLimit: z
              .object({ requests: z.number().int().positive(), windowMinutes: z.number().int().positive() })
              .optional(),
            /** Pages per day Clerk may OCR for the org (AI-04); the ingestion default applies when unset. */
            ocrDailyPages: z.number().int().min(0).optional(),
          })
          .optional(),
        referrals: z
          .object({
            /** A "Thank referrer" task when a referred matter opens (CORE-18). Off unless set. */
            thankYouTask: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * Settings → Trust account (BILL-11, ADR-035): whether matters show the trust balance copied from
     * the firm's own trust records, which records those are, and when a balance is out of date.
     * Written only by `trust-updateSettings`, behind `billing.trustDisplay`.
     */
    trust: z
      .object({
        showOnMatters: z.boolean(),
        system: TrustRecordsSystemSchema,
        /** The records' name when `system` is `other` ("In-house trust records"). */
        otherName: z.string().trim().max(60).optional(),
        staleAfterDays: z.number().int().min(1).max(365),
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
    // The practice details and billing settings change only through `orgs-updateSettings` (CORE-21),
    // which refuses removing a jurisdiction open matters use and keeps the claims' org name current.
    serverOwned: [
      'security',
      'legalHold',
      'deletionScheduledAt',
      'flags',
      'name',
      'abn',
      'jurisdictions',
      'primaryJurisdiction',
      'timezone',
      'holidayLocality',
      'retentionYears',
      'billing',
      'trust',
    ],
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
    /**
     * Sign-ins before this no longer reach the org's data (SEC-04 "sign out everywhere"): the rules
     * compare the token's `auth_time`. Set by `security-revokeSessions`.
     */
    sessionsValidAfter: InstantSchema.optional(),
  },
  {
    path: 'orgs/{orgId}/members',
    // Role and status change only through the orgs-* callables, which keep the last-owner invariant
    // and the custom claims in step (FND-17).
    serverOwned: ['role', 'status', 'email', 'sessionsValidAfter'],
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
      /** Per kind and channel, quiet hours and the daily digest (FND-20, notifications.ts). */
      notifications: NotificationPrefsSchema,
      /** The person's IANA time zone for quiet hours and the digest; the org's when absent. */
      timezone: z.string().min(1).max(64).optional(),
      /** Where signing in (or `/`) lands (CORE-20); Today when absent. */
      startPage: z.enum(['today', 'matters']).optional(),
    }),
    /**
     * The download URL of `users/{uid}/avatar.png` (CORE-20), set by its owner after uploading the
     * cropped 512px square; absent shows initials.
     */
    avatarUrl: z.url().max(2048).optional(),
    /**
     * Set by the Postmark bounce and spam webhook (FND-20): mail to this address bounced hard or
     * was reported as spam, so nothing more is emailed to it.
     */
    emailDeliverability: z
      .object({
        status: z.literal('undeliverable'),
        reason: z.enum(['hard_bounce', 'spam_complaint']),
        at: InstantSchema,
      })
      .optional(),
    legacy: z.object({ uid: z.string(), migratedAt: InstantSchema }).optional(),
  },
  {
    path: 'users',
    // The active org changes only through `orgs-switchActiveOrg`, which also sets the claims.
    serverOwned: ['orgIds', 'activeOrgId', 'claimsVersion', 'memberships', 'emailDeliverability', 'legacy'],
    updatable: ['displayName', 'firstName', 'lastName', 'prefs', 'avatarUrl'],
  },
);

/**
 * `users/{uid}/devices/{deviceId}`: a push token (FCM) for one browser or phone (FND-20, MOB-04).
 * Written by its owner; `notifications-deliver` deletes a token FCM reports as invalid.
 */
export const Device = withMeta(
  {
    token: z.string().min(1).max(4096),
    platform: z.enum(['web', 'ios', 'android']),
    lastSeenAt: InstantSchema,
  },
  { path: 'users/{uid}/devices', migratable: false },
);
export type Device = z.infer<typeof Device.schema>;

export type Org = z.infer<typeof Org.schema>;
export type Member = z.infer<typeof Member.schema>;
export type Invite = z.infer<typeof Invite.schema>;
export type User = z.infer<typeof User.schema>;
