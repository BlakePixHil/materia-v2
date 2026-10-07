import { firestoreCacheMode, type SessionSecurity } from '@materia/data-access';

import type { AuthSession } from './auth-port';

/**
 * What this device saw last of the signed-in session and the org's security policy (MAT-177),
 * read without the Firebase SDK so the shell and the page can be drawn before Auth and Firestore
 * answer. It decides only what is drawn: the rules and callables check the live sign-in, the data
 * layer waits for Auth to confirm it, and the session watcher corrects the screen if Auth's answer
 * differs. A shared-computer sign-in keeps it in sessionStorage, as Firestore's cache choice is.
 */
const SESSION_KEY = 'materia.session';
const SECURITY_KEY = 'materia.sessionSecurity';

function storages(): Storage[] {
  try {
    return [globalThis.localStorage, globalThis.sessionStorage].filter((storage): storage is Storage => !!storage);
  } catch {
    return [];
  }
}

/** Where this sign-in keeps it: the tab's sessionStorage on a shared computer, else localStorage. */
function storage(): Storage | undefined {
  try {
    return firestoreCacheMode() === 'memory' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(key: string): unknown {
  try {
    const value = storage()?.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be full or unavailable. Never leave an older value behind: the next start-up
    // waits for Auth, as without a cache.
    remove(key);
  }
}

function remove(key: string): void {
  for (const store of storages()) {
    try {
      store.removeItem(key);
    } catch {
      // Storage may be unavailable.
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const isText = (value: unknown): value is string => typeof value === 'string';
const isOptionalText = (value: unknown) => value === undefined || value === null || isText(value);

function asSession(value: unknown): AuthSession | null {
  if (!isRecord(value) || !isRecord(value['claims'])) return null;
  const { uid, email, displayName, emailVerified, providerIds, mfaEnrolled, claims, authTime, secondFactor } = value;
  const ok =
    isText(uid) &&
    isOptionalText(email) &&
    isOptionalText(displayName) &&
    typeof emailVerified === 'boolean' &&
    Array.isArray(providerIds) &&
    providerIds.every(isText) &&
    typeof mfaEnrolled === 'boolean' &&
    isText(claims['orgId']) &&
    isOptionalText(claims['role']) &&
    isOptionalText(claims['orgName']) &&
    typeof authTime === 'number' &&
    (secondFactor === undefined || typeof secondFactor === 'boolean');
  return ok ? (value as unknown as AuthSession) : null;
}

/** The session this device saw last, if it had an org: what the shell can be drawn from. */
export function readCachedSession(): AuthSession | null {
  return asSession(read(SESSION_KEY));
}

/** Keeps a session with an org for the next start-up, and forgets everything else. */
export function saveCachedSession(session: AuthSession | null): void {
  if (!session?.claims.orgId) {
    forgetCachedSession();
    return;
  }
  write(SESSION_KEY, session);
}

const toDate = (value: unknown): Date | null | undefined =>
  value === null ? null : isText(value) && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined;

/** The org's security policy this device saw last for this member, with its dates. */
export function readCachedSecurity(uid: string, orgId: string): SessionSecurity | null {
  const value = read(SECURITY_KEY);
  if (!isRecord(value) || value['uid'] !== uid || value['orgId'] !== orgId) return null;
  const security = value['security'];
  if (!isRecord(security) || !isRecord(security['policy'])) return null;
  const policy = security['policy'];
  const numbers = ['sessionIdleMinutes', 'maxSessionDays', 'mfaGraceHours'].every(
    (key) => typeof policy[key] === 'number',
  );
  const mfaRequiredSince = toDate(policy['mfaRequiredSince']);
  const mfaEnforceAfter = toDate(policy['mfaEnforceAfter']);
  const validAfter = toDate(security['validAfter']);
  const deletionScheduledAt = toDate(security['deletionScheduledAt'] ?? null);
  const terms = security['termsAcceptedVersion'];
  if (
    !numbers ||
    typeof policy['mfaRequired'] !== 'boolean' ||
    mfaRequiredSince === undefined ||
    mfaEnforceAfter === undefined ||
    validAfter === undefined ||
    deletionScheduledAt === undefined ||
    !isOptionalText(terms)
  ) {
    return null;
  }
  return {
    policy: {
      mfaRequired: policy['mfaRequired'],
      sessionIdleMinutes: policy['sessionIdleMinutes'] as number,
      maxSessionDays: policy['maxSessionDays'] as number,
      mfaGraceHours: policy['mfaGraceHours'] as number,
      mfaRequiredSince,
      mfaEnforceAfter,
    },
    validAfter,
    ...(terms === undefined ? {} : { termsAcceptedVersion: terms as string | null }),
    deletionScheduledAt,
  };
}

/** Keeps the org's security policy for this member's next start-up. */
export function saveCachedSecurity(uid: string, orgId: string, security: SessionSecurity): void {
  write(SECURITY_KEY, { uid, orgId, security });
}

/** Forgets both, from either storage: on sign-out, or when the session ends. */
export function forgetCachedSession(): void {
  remove(SESSION_KEY);
  remove(SECURITY_KEY);
}
