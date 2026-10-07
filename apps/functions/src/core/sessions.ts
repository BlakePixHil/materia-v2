import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import {
  DomainError,
  mfaEnforced,
  resolveSecurity,
  sessionExpired,
  sessionRevoked,
  usedSecondFactor,
  type OrgSecurity,
  type ResolvedSecurity,
} from '@materia/domain';

import type { Clock } from '../ports';

/** What the callable wrapper checks a sign-in against (SEC-04). */
export interface SessionPolicy {
  policy: ResolvedSecurity;
  /** The member's `sessionsValidAfter`: sign-ins before it were signed out everywhere. */
  validAfter: Date | null;
  /**
   * When the practice is to be deleted (SEC-05): until then it is read-only, and only the callables
   * in `READ_ONLY_CALLABLES` run (core/read-only.ts). Absent or null when it isn't.
   */
  deletionScheduledAt?: Date | null;
}

export type SessionLookup = (orgId: string, uid: string) => Promise<SessionPolicy>;

const TTL_MS = 60_000;

const toDate = (value: unknown): Date | undefined =>
  value instanceof Date ? value : value ? (value as Timestamp).toDate?.() : undefined;

/** The stored `security` block with its Timestamps as Dates. */
export function readSecurity(raw: unknown): Partial<OrgSecurity> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const security = raw as Record<string, unknown>;
  return {
    ...(security as Partial<OrgSecurity>),
    mfaRequiredSince: toDate(security['mfaRequiredSince']),
    mfaEnforceAfter: toDate(security['mfaEnforceAfter']),
  };
}

/**
 * Reads the org's security policy, its deletion date (SEC-05) and the member's
 * `sessionsValidAfter`, cached 60 s per instance like the member lookup: a policy change, a
 * deletion request or a "sign out everywhere" reaches callables within a minute (the rules apply
 * it at once).
 */
export function cachedSessionLookup(db: () => Firestore, clock: Clock): SessionLookup & { clear(): void } {
  const cache = new Map<string, { value: SessionPolicy; until: number }>();
  const lookup = async (orgId: string, uid: string) => {
    const key = `${orgId}/${uid}`;
    const now = clock.now().getTime();
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.value;
    const [org, member] = await Promise.all([
      db().doc(`orgs/${orgId}`).get(),
      db().doc(`orgs/${orgId}/members/${uid}`).get(),
    ]);
    const value: SessionPolicy = {
      policy: resolveSecurity(readSecurity(org.get('security'))),
      validAfter: toDate(member.get('sessionsValidAfter')) ?? null,
      deletionScheduledAt: toDate(org.get('deletionScheduledAt')) ?? null,
    };
    cache.set(key, { value, until: now + TTL_MS });
    return value;
  };
  return Object.assign(lookup, { clear: () => cache.clear() });
}

/**
 * Refuses a sign-in the org's policy no longer accepts: signed out everywhere since
 * (SESSION_REVOKED), older than the session length (SESSION_EXPIRED), or without a second factor
 * once the org requires one and the grace is over (MFA_REQUIRED, unless `mfa` is false).
 */
export function assertSessionAllowed(
  token: Record<string, unknown>,
  session: SessionPolicy,
  nowMs: number,
  options: { mfa: boolean } = { mfa: true },
): void {
  const authTimeMs = typeof token['auth_time'] === 'number' ? token['auth_time'] * 1000 : 0;
  if (sessionRevoked(authTimeMs, session.validAfter)) {
    throw new DomainError('SESSION_REVOKED', 'This sign-in was signed out everywhere; sign in again');
  }
  if (sessionExpired(authTimeMs, session.policy, nowMs)) {
    throw new DomainError('SESSION_EXPIRED', 'This sign-in is older than the organisation allows; sign in again');
  }
  if (options.mfa && mfaEnforced(session.policy, nowMs) && !usedSecondFactor(token)) {
    throw new DomainError('MFA_REQUIRED', 'The organisation requires a second factor');
  }
}
