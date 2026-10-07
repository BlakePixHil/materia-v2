import * as z from 'zod';

import { DocIdSchema, InstantSchema, withMeta } from './schemas/common';

/**
 * Org security policies (SEC-04): required MFA with a grace period, inactivity sign-out, the
 * longest a sign-in lasts, re-confirmation for sensitive actions, and the sign-in log behind
 * "Your sessions". Pure helpers here are shared by the callables, the blocking function and the
 * web app; the rules mirror `mfaEnforced`, `sessionExpired` and `sessionRevoked`.
 */

/** Inactivity sign-out, in minutes (Settings → Security). */
export const SESSION_IDLE_MINUTES = { min: 15, max: 480, default: 60 } as const;
/** The longest a sign-in lasts before the person signs in again, in days. */
export const MAX_SESSION_DAYS = { min: 1, max: 90, default: 14 } as const;
/** How long members without MFA keep working after an org turns it on, in hours. */
export const MFA_GRACE_HOURS = { min: 0, max: 168, default: 24 } as const;
/** Sensitive actions need a sign-in this recent (`requireRecentLogin`). */
export const SENSITIVE_REAUTH_MINUTES = 5;
/** The inactivity warning shows this long before the sign-out. */
export const IDLE_WARNING_SECONDS = 60;
/** Sign-in log entries are deleted (Firestore TTL on `expireAt`) after this many days. */
export const SIGN_IN_LOG_DAYS = 90;

/** Inactivity choices offered in Settings → Security, in minutes. */
export const SESSION_IDLE_OPTIONS = [15, 30, 60, 120, 240, 480] as const;
/** Session length choices, in days. */
export const MAX_SESSION_OPTIONS = [1, 7, 14, 30, 90] as const;
/** MFA grace choices, in hours. */
export const MFA_GRACE_OPTIONS = [0, 24, 72, 168] as const;

/**
 * `orgs/{orgId}.security` as stored. Orgs made before SEC-04 have only `mfaRequired` and
 * `sessionIdleMinutes`; `resolveSecurity` fills the rest. Written only by `security-updatePolicy`
 * (and `orgs-createOrg`).
 */
export const OrgSecuritySchema = z.object({
  mfaRequired: z.boolean(),
  sessionIdleMinutes: z.number().int().positive(),
  maxSessionDays: z.number().int().positive().optional(),
  mfaGraceHours: z.number().int().min(0).optional(),
  /** When MFA was last turned on. */
  mfaRequiredSince: InstantSchema.optional(),
  /** `mfaRequiredSince` plus the grace: members without MFA are blocked from then (rules too). */
  mfaEnforceAfter: InstantSchema.optional(),
});
export type OrgSecurity = z.infer<typeof OrgSecuritySchema>;

export interface ResolvedSecurity {
  mfaRequired: boolean;
  sessionIdleMinutes: number;
  maxSessionDays: number;
  mfaGraceHours: number;
  mfaRequiredSince: Date | null;
  /** Null with `mfaRequired`: enforced already (an org made before the grace period existed). */
  mfaEnforceAfter: Date | null;
}

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value));

/** The policy with defaults for anything an older org doesn't store. A missing policy is MFA off. */
export function resolveSecurity(raw: Partial<OrgSecurity> | null | undefined): ResolvedSecurity {
  return {
    mfaRequired: raw?.mfaRequired ?? false,
    sessionIdleMinutes: clamp(raw?.sessionIdleMinutes ?? SESSION_IDLE_MINUTES.default, SESSION_IDLE_MINUTES),
    maxSessionDays: raw?.maxSessionDays ?? MAX_SESSION_DAYS.default,
    mfaGraceHours: raw?.mfaGraceHours ?? MFA_GRACE_HOURS.default,
    mfaRequiredSince: raw?.mfaRequiredSince ?? null,
    mfaEnforceAfter: raw?.mfaEnforceAfter ?? null,
  };
}

/** The security block for a new org: MFA required after the default grace, the default limits. */
export function newOrgSecurity(now: Date): OrgSecurity {
  return {
    mfaRequired: true,
    sessionIdleMinutes: SESSION_IDLE_MINUTES.default,
    maxSessionDays: MAX_SESSION_DAYS.default,
    mfaGraceHours: MFA_GRACE_HOURS.default,
    mfaRequiredSince: now,
    mfaEnforceAfter: new Date(now.getTime() + MFA_GRACE_HOURS.default * 3_600_000),
  };
}

/** Whether members without a second factor are blocked now (MFA required and the grace is over). */
export function mfaEnforced(policy: ResolvedSecurity, nowMs: number): boolean {
  if (!policy.mfaRequired) return false;
  return !policy.mfaEnforceAfter || nowMs >= policy.mfaEnforceAfter.getTime();
}

/** Whether a sign-in (`auth_time`, ms) is older than the org allows. */
export function sessionExpired(authTimeMs: number, policy: ResolvedSecurity, nowMs: number): boolean {
  return nowMs - authTimeMs > policy.maxSessionDays * 86_400_000;
}

/** Whether a sign-in (`auth_time`, ms) predates a "sign out everywhere" (`sessionsValidAfter`). */
export function sessionRevoked(authTimeMs: number, validAfter: Date | null | undefined): boolean {
  return !!validAfter && authTimeMs < validAfter.getTime();
}

/** `sessionsValidAfter` for a revocation now: whole seconds, so a sign-in in the same second counts. */
export function revocationInstant(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 1000) * 1000);
}

/** Whether a decoded ID token says the sign-in used a second factor (`firebase.sign_in_second_factor`). */
export function usedSecondFactor(token: Record<string, unknown> | null | undefined): boolean {
  const firebase = token?.['firebase'] as { sign_in_second_factor?: unknown } | undefined;
  return typeof firebase?.sign_in_second_factor === 'string' && firebase.sign_in_second_factor.length > 0;
}

/**
 * What changing the policy does to the MFA dates: turning MFA on starts the grace now; changing
 * the grace while it's on moves the deadline from when it was turned on; turning it off clears both.
 */
export function nextMfaDates(
  before: ResolvedSecurity,
  next: { mfaRequired: boolean; mfaGraceHours: number },
  now: Date,
): { mfaRequiredSince: Date; mfaEnforceAfter: Date } | null {
  if (!next.mfaRequired) return null;
  const since = before.mfaRequired && before.mfaRequiredSince ? before.mfaRequiredSince : now;
  return { mfaRequiredSince: since, mfaEnforceAfter: new Date(since.getTime() + next.mfaGraceHours * 3_600_000) };
}

/** `security-updatePolicy` (owners and admins, recent sign-in). */
export const UpdateSecurityPolicyInput = z.object({
  requestId: z.uuid(),
  mfaRequired: z.boolean(),
  sessionIdleMinutes: z.number().int().min(SESSION_IDLE_MINUTES.min).max(SESSION_IDLE_MINUTES.max),
  maxSessionDays: z.number().int().min(MAX_SESSION_DAYS.min).max(MAX_SESSION_DAYS.max),
  mfaGraceHours: z.number().int().min(MFA_GRACE_HOURS.min).max(MFA_GRACE_HOURS.max),
});
export type UpdateSecurityPolicyInput = z.input<typeof UpdateSecurityPolicyInput>;

/**
 * `security-revokeSessions`: signs a person out everywhere. Without `uid` it is the caller ("sign
 * out everywhere else": the client confirms it's them again straight after, to stay signed in
 * here). Another member needs `members.manage`.
 */
export const RevokeSessionsInput = z.object({ requestId: z.uuid(), uid: DocIdSchema.optional() });
export type RevokeSessionsInput = z.input<typeof RevokeSessionsInput>;
export interface RevokeSessionsResult {
  uid: string;
  /** ISO instant: sign-ins before it no longer work. */
  validAfter: string;
}

/** The kinds of device and browser the sign-in log names (from the user agent). */
export type SignInDevice = 'Mac' | 'Windows PC' | 'iPhone' | 'iPad' | 'Android' | 'Chromebook' | 'Linux' | 'Device';
export type SignInBrowser = 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Browser';

/**
 * A coarse device and browser from a user agent: enough to recognise a session, nothing more (the
 * raw user agent and the IP address are never stored).
 */
export function describeUserAgent(userAgent: string | null | undefined): {
  device: SignInDevice;
  browser: SignInBrowser;
} {
  const ua = userAgent ?? '';
  const device: SignInDevice = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'Device';
  const browser: SignInBrowser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return { device, browser };
}

/**
 * `users/{uid}/signIns/{eventId}` (SEC-04): one per sign-in, written by `auth-beforeSignIn`, read
 * by its owner ("Your sessions"), never written by clients. Firestore TTL deletes it at `expireAt`.
 */
export const SignIn = withMeta(
  () => ({
    at: InstantSchema,
    /** The `auth_time` the sign-in's tokens carry (seconds), to tell which entry is this session. */
    authTime: z.number().int().min(0),
    provider: z.string().min(1).max(64),
    device: z.string().min(1).max(32),
    browser: z.string().min(1).max(32),
    /** Whether the account had a second factor enrolled, so signing in needed it. */
    secondFactor: z.boolean(),
    expireAt: InstantSchema,
  }),
  {
    path: 'users/{uid}/signIns',
    migratable: false,
    serverOwned: ['at', 'authTime', 'provider', 'device', 'browser', 'secondFactor', 'expireAt'],
  },
);
export type SignIn = z.infer<typeof SignIn.schema>;

/** How a sign-in shows in "Your sessions". */
export type SignInState = 'current' | 'active' | 'signedOut' | 'expired';

/**
 * Where a logged sign-in stands: this session (its `authTime` matches the token's within a minute),
 * ended by a "sign out everywhere", past the org's session length, or possibly still signed in.
 */
export function signInState(
  entry: Pick<SignIn, 'authTime'>,
  context: { currentAuthTimeMs: number | null; validAfter: Date | null; policy: ResolvedSecurity; nowMs: number },
): SignInState {
  const authTimeMs = entry.authTime * 1000;
  if (context.currentAuthTimeMs !== null && Math.abs(authTimeMs - context.currentAuthTimeMs) < 60_000) return 'current';
  if (sessionRevoked(authTimeMs, context.validAfter)) return 'signedOut';
  if (sessionExpired(authTimeMs, context.policy, context.nowMs)) return 'expired';
  return 'active';
}

/** Copy for the policy durations ("30 minutes", "2 hours", "1 day", "1 week"). */
export function formatMinutes(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function formatDays(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export function formatGraceHours(hours: number): string {
  if (hours === 0) return 'No grace period';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 7 ? '1 week' : days === 1 ? '24 hours' : `${days} days`;
  }
  return `${hours} hours`;
}
