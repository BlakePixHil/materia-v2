import type { UserImportRecord } from 'firebase-admin/auth';

import { present, type LegacyAuthRecord } from './record.ts';

/**
 * What the auth import (MIG-04) does with one legacy account, decided from the account and the
 * target project's state without touching either. It aborts, for a person to decide, on anything
 * the ticket says to stop for, and skips when the account is already there, so a re-run is a no-op.
 */

/** A v2 Auth user, as much of it as the plan needs. Never an email in logs. */
export interface TargetUser {
  uid: string;
  email?: string;
  /** Linked providers and the provider's id for the person (`password` has the email). */
  providers: { providerId: string; uid: string }[];
  createdAt?: string;
  /** Empty until the user first signs in to v2. */
  lastSignInAt?: string;
  hasCustomClaims: boolean;
}

export interface TargetState {
  /** The v2 user that already has the legacy uid, if any. */
  byUid: TargetUser | null;
  /** Other v2 users holding the account's email or one of its sign-in identities. */
  conflicts: TargetUser[];
  /** Sign-in providers the target project has on; `any` on the emulator, which checks none. */
  enabledProviders: ReadonlySet<string> | 'any';
}

export interface ImportPlan {
  action: 'import' | 'skip' | 'abort';
  /** Why it skips or aborts; empty for an import. */
  reasons: string[];
  /** Conflicting v2 users a person named with --replace-user: deleted before the import. */
  replace: TargetUser[];
  /** The account has a password hash, so the import needs the legacy scrypt parameters. */
  needsHashParams: boolean;
  /** Worth saying, not worth stopping for. */
  notes: string[];
}

const sameEmail = (a?: string, b?: string) => a !== undefined && a.toLowerCase() === b?.toLowerCase();

/** One line about a v2 user for a person deciding whether to delete it. Never its email. */
export function describeUser(user: TargetUser): string {
  const providers = user.providers.map((p) => p.providerId).join(', ') || 'no providers';
  const signIn = user.lastSignInAt ? `last signed in ${user.lastSignInAt}` : 'never signed in';
  const claims = user.hasCustomClaims ? ', has v2 claims (an org member)' : '';
  return `${user.uid} (${providers}; created ${user.createdAt ?? 'unknown'}, ${signIn}${claims})`;
}

function recordProblems(record: LegacyAuthRecord, enabled: ReadonlySet<string> | 'any'): string[] {
  const problems: string[] = [];
  const isOn = (provider: string) => enabled === 'any' || enabled.has(provider);
  if (record.disabled) {
    problems.push('The legacy account is disabled. Ask why before importing it.');
  }
  if (!record.email) problems.push('The legacy account has no email, and v2 accounts need one.');
  if (record.tenantId) problems.push(`The legacy account is in tenant ${record.tenantId}; the import has no tenants.`);
  if (record.mfaFactors > 0) {
    problems.push(
      `The legacy account has ${record.mfaFactors} second factor(s), which v2 can't import (it uses TOTP only). ` +
        'Ask before importing it without them; the user would enrol again.',
    );
  }
  if (record.phoneSignIn) problems.push("The legacy account signs in by phone, which v2 doesn't offer.");
  for (const identity of record.identities) {
    if (!identity.rawId) problems.push(`The ${identity.providerId} identity has no provider uid, so it can't be kept.`);
    if (!isOn(identity.providerId)) {
      problems.push(
        `${identity.providerId} sign-in is off in the target project, so the user couldn't sign in with it. ` +
          'Turn it on first (for Microsoft, the app registration in infra/MANUAL.md).',
      );
    }
  }
  if (record.password === 'unavailable') {
    problems.push(
      "The account has a password, but this source doesn't show its hash. Import from the filtered " +
        'auth:export file (--record), with LEGACY_SCRYPT_PARAMS in Secret Manager (docs/runbooks/migration-auth-import.md).',
    );
  }
  if (record.password === 'hash' && !isOn('password')) {
    problems.push('Email and password sign-in is off in the target project, so the password would not work.');
  }
  return problems;
}

export function planAuthImport(
  record: LegacyAuthRecord,
  target: TargetState,
  { replaceUids = [] }: { replaceUids?: readonly string[] } = {},
): ImportPlan {
  const reasons = recordProblems(record, target.enabledProviders);
  const notes: string[] = [];
  const replace: TargetUser[] = [];
  if (record.hasCustomClaims) notes.push('Legacy custom claims are not imported; v2 sets its own at load (MIG-06).');

  if (target.byUid) {
    if (!sameEmail(target.byUid.email, record.email)) {
      reasons.push(
        `v2 already has ${record.uid} with a different email. Stop and ask: it is another person, or the email changed.`,
      );
    } else {
      const have = new Set(target.byUid.providers.map((p) => `${p.providerId}:${p.uid}`));
      const missing = record.identities.filter((i) => !have.has(`${i.providerId}:${i.rawId}`));
      if (missing.length) {
        notes.push(`The v2 account lacks ${missing.map((i) => i.providerId).join(', ')}; ask before changing it.`);
      }
    }
  } else {
    for (const user of target.conflicts) {
      if (replaceUids.includes(user.uid)) replace.push(user);
      else {
        reasons.push(
          `v2 user ${describeUser(user)} already holds this account's email or sign-in identity. Deleting it needs a ` +
            `person's approval; then re-run with --replace-user ${user.uid}.`,
        );
      }
    }
    for (const uid of replaceUids) {
      if (!target.conflicts.some((user) => user.uid === uid)) {
        reasons.push(`--replace-user ${uid} doesn't hold this account's email or identity, so nothing replaces it.`);
      }
    }
  }

  const needsHashParams = record.password === 'hash';
  if (reasons.length) return { action: 'abort', reasons, replace: [], needsHashParams, notes };
  if (target.byUid) {
    return {
      action: 'skip',
      reasons: [`v2 already has ${record.uid} with the same email, so there is nothing to do.`],
      replace: [],
      needsHashParams,
      notes,
    };
  }
  return { action: 'import', reasons: [], replace, needsHashParams, notes };
}

export interface RollbackPlan {
  action: 'delete' | 'skip' | 'abort';
  reason: string;
}

/**
 * Removes the imported account, unless it isn't the imported one. Once the user has signed in,
 * only a rehearsal project may lose it: in prod that would lock them out (`signedInMayGo` false).
 */
export function planRollback(
  record: LegacyAuthRecord,
  byUid: TargetUser | null,
  { signedInMayGo }: { signedInMayGo: boolean },
): RollbackPlan {
  if (!byUid) return { action: 'skip', reason: `v2 has no ${record.uid}, so there is nothing to roll back.` };
  if (!sameEmail(byUid.email, record.email)) {
    return { action: 'abort', reason: `v2's ${record.uid} has a different email, so it isn't the imported account.` };
  }
  if (!byUid.lastSignInAt) return { action: 'delete', reason: `${record.uid} was imported and has never signed in.` };
  if (!signedInMayGo) {
    return {
      action: 'abort',
      reason: `${record.uid} has signed in to v2 (${byUid.lastSignInAt}); removing it would lock the user out. Delete it by hand only if a person says so.`,
    };
  }
  return {
    action: 'delete',
    reason:
      `${record.uid} was imported and signed in (${byUid.lastSignInAt}) during the rehearsal. Its sign-in log ` +
      `(users/${record.uid}/private/session and signIns in Firestore) stays for the load's rollback to remove.`,
  };
}

/**
 * The Admin SDK import record: the same uid, the Auth record's email and its verification, name,
 * photo, creation time, every sign-in identity with its provider uid, and the password hash and
 * salt when there are some. Not imported: custom claims (FND-17 sets them at MIG-06), the legacy
 * last sign-in (v2's starts empty, so rollback can tell a used account) and second factors (aborted on).
 */
export function toUserImport(record: LegacyAuthRecord): UserImportRecord {
  const created = record.createdAt ? new Date(Number(record.createdAt)) : undefined;
  return {
    uid: record.uid,
    ...present({ email: record.email, displayName: record.displayName, photoURL: record.photoUrl }),
    emailVerified: record.emailVerified,
    disabled: record.disabled,
    ...(created && !Number.isNaN(created.getTime()) ? { metadata: { creationTime: created.toUTCString() } } : {}),
    ...(record.identities.length
      ? {
          providerData: record.identities.map((identity) => ({
            providerId: identity.providerId,
            uid: identity.rawId,
            ...present({ email: identity.email, displayName: identity.displayName, photoURL: identity.photoUrl }),
          })),
        }
      : {}),
    ...(record.password === 'hash' && record.passwordHash
      ? {
          passwordHash: Buffer.from(record.passwordHash, 'base64'),
          ...(record.passwordSalt ? { passwordSalt: Buffer.from(record.passwordSalt, 'base64') } : {}),
        }
      : {}),
  };
}

/** What the imported v2 account gets wrong, compared with the legacy account; empty if nothing. */
export function checkImported(record: LegacyAuthRecord, user: TargetUser | null): string[] {
  if (!user) return [`${record.uid} isn't in v2 after the import.`];
  const problems: string[] = [];
  if (!sameEmail(user.email, record.email)) problems.push('the email differs');
  const have = new Set(user.providers.map((p) => `${p.providerId}:${p.uid}`));
  for (const identity of record.identities) {
    if (!have.has(`${identity.providerId}:${identity.rawId}`))
      problems.push(`the ${identity.providerId} identity is missing`);
  }
  if (record.password === 'hash' && !user.providers.some((p) => p.providerId === 'password')) {
    problems.push('the password is missing');
  }
  return problems;
}
