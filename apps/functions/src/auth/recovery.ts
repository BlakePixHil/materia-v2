import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { DomainError } from '@materia/domain';

import { audit } from '../audit/audit';
import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: object,
) => Promise<Buffer>;

export const RECOVERY_CODE_COUNT = 10;
/** Failed recovery attempts allowed per window, per account. */
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
/**
 * scrypt cost for new codes. Each stored code records its `N`, so raising the cost later keeps
 * existing codes verifiable. Tests lower `N` to stay fast; production never changes it at runtime.
 */
export const RECOVERY_SCRYPT = { N: 16384, r: 8, p: 1 };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // No 0/O, 1/I/L.

export interface StoredCode {
  salt: string;
  hash: string;
  /** scrypt cost the hash was made with (16384 when absent). */
  N?: number;
  usedAt: Timestamp | null;
}

/** `ABCDE-FGHJK`: 10 characters from a 31-letter alphabet (about 50 bits). */
export function newRecoveryCode(bytes: Buffer = randomBytes(10)): string {
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
}

/** Codes are compared without dashes, spaces or case. */
export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export async function hashCode(
  code: string,
  salt: Buffer = randomBytes(16),
  N: number = RECOVERY_SCRYPT.N,
): Promise<{ salt: string; hash: string; N: number }> {
  const hash = await scrypt(normaliseCode(code), salt, 32, { ...RECOVERY_SCRYPT, N });
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), N };
}

export async function matchesCode(code: string, stored: Pick<StoredCode, 'salt' | 'hash' | 'N'>): Promise<boolean> {
  const { hash } = await hashCode(code, Buffer.from(stored.salt, 'hex'), stored.N ?? 16384);
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored.hash, 'hex'));
}

const recoveryDoc = (uid: string) => `users/${uid}/private/recovery`;

/**
 * `auth-generateRecoveryCodes` (FND-16): ten single-use MFA recovery codes, returned once and
 * stored only as scrypt hashes in the server-only `users/{uid}/private/recovery`. Needs a sign-in
 * within five minutes. Generating again replaces the old codes.
 */
export const generateRecoveryCodesDefinition = {
  name: 'auth-generateRecoveryCodes',
  input: z.object({}),
  recentLoginMinutes: 5,
  handler: async ({ uid, db, clock }): Promise<{ codes: string[] }> => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    const stored = await Promise.all(codes.map(async (code) => ({ ...(await hashCode(code)), usedAt: null })));
    await db.doc(recoveryDoc(uid as string)).set({
      codes: stored,
      generatedAt: Timestamp.fromDate(clock.now()),
      failedAttempts: 0,
      windowStart: null,
    });
    return { codes };
  },
} satisfies UserCallableDefinition<z.ZodObject, { codes: string[] }>;

export const UseRecoveryCodeInput = z.object({
  email: z.email().max(320),
  code: z.string().min(10).max(20),
});

const INVALID = () =>
  new DomainError('INVALID_ARGUMENT', 'Invalid recovery code', { fields: { code: ['Invalid recovery code'] } });

/**
 * `auth-useRecoveryCode` (FND-16): for someone who lost their authenticator. A valid unused code
 * removes their MFA factors (each code works once), so they can sign in with their password and
 * enrol again. Five failed attempts per 15 minutes per account; unknown emails get the same error
 * as wrong codes. Recorded in the audit log of their org.
 */
export const useRecoveryCodeDefinition = {
  name: 'auth-useRecoveryCode',
  input: UseRecoveryCodeInput,
  auth: 'optional',
  handler: async ({ input, db, auth, clock, log, requestId }): Promise<{ ok: true; remaining: number }> => {
    const user = await auth.getUserByEmail(input.email.toLowerCase()).catch(() => null);
    if (!user) throw INVALID();
    const ref = db.doc(recoveryDoc(user.uid));
    const now = clock.now().getTime();
    const outcome = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { ok: false as const };
      const windowStart = (snapshot.get('windowStart') as Timestamp | null)?.toMillis() ?? 0;
      const inWindow = now - windowStart < ATTEMPT_WINDOW_MS;
      const failed = inWindow ? ((snapshot.get('failedAttempts') as number | undefined) ?? 0) : 0;
      if (failed >= MAX_ATTEMPTS) return { ok: false as const, limited: true };
      const codes = (snapshot.get('codes') as StoredCode[] | undefined) ?? [];
      let matched = -1;
      for (const [index, stored] of codes.entries()) {
        // Check every unused code, so timing doesn't reveal which one matched.
        if (!stored.usedAt && (await matchesCode(input.code, stored)) && matched === -1) matched = index;
      }
      if (matched === -1) {
        tx.update(ref, {
          failedAttempts: failed + 1,
          windowStart: inWindow ? Timestamp.fromMillis(windowStart) : Timestamp.fromMillis(now),
        });
        return { ok: false as const };
      }
      const next = codes.map((code, index) =>
        index === matched ? { ...code, usedAt: Timestamp.fromMillis(now) } : code,
      );
      tx.update(ref, { codes: next, failedAttempts: 0, windowStart: null, lastUsedAt: FieldValue.serverTimestamp() });
      return { ok: true as const, remaining: next.filter((code) => !code.usedAt).length };
    });
    if ('limited' in outcome && outcome.limited) throw new DomainError('RATE_LIMITED', 'Too many recovery attempts');
    if (!outcome.ok) throw INVALID();

    await auth.updateUser(user.uid, { multiFactor: { enrolledFactors: null } });
    const orgId = typeof user.customClaims?.['orgId'] === 'string' ? user.customClaims['orgId'] : null;
    if (orgId) {
      await audit(
        { uid: user.uid, orgId, requestId, db, clock },
        {
          action: 'auth.mfa_recovered',
          entity: { path: `orgs/${orgId}/members/${user.uid}` },
          summary: 'MFA removed with a recovery code; re-enrolment required',
          data: { remainingCodes: outcome.remaining },
        },
      );
    }
    log.info('mfa recovered', { remaining: outcome.remaining });
    return { ok: true, remaining: outcome.remaining };
  },
} satisfies UserCallableDefinition<typeof UseRecoveryCodeInput, { ok: true; remaining: number }>;

export const generateRecoveryCodes = defineUserCallable(generateRecoveryCodesDefinition);
export const useRecoveryCode = defineUserCallable(useRecoveryCodeDefinition);
