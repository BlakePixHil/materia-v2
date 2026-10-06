import { readFile } from 'node:fs/promises';

import * as z from 'zod';

/**
 * One legacy Firebase Auth account (MIG-04), parsed from either source the import takes:
 *
 * - `accounts:lookup` on the legacy project, through the read-only account (no password hashes:
 *   the read-only role sees them redacted, which is fine for a Google-only user);
 * - a file from `firebase auth:export --format=json`, filtered to the one user, when the user
 *   has a password and the hash is needed.
 *
 * Both are Identity Toolkit account JSON. Fields the import doesn't use are dropped on parse.
 */

const ProviderSchema = z.object({
  providerId: z.string().min(1),
  rawId: z.string().min(1).optional(),
  federatedId: z.string().optional(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  photoUrl: z.string().optional(),
});

const Millis = z.union([z.string(), z.number()]).transform(String);

const AuthUserSchema = z.object({
  localId: z.string().min(1),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  displayName: z.string().optional(),
  photoUrl: z.string().optional(),
  phoneNumber: z.string().optional(),
  disabled: z.boolean().optional(),
  passwordHash: z.string().optional(),
  salt: z.string().optional(),
  createdAt: Millis.optional(),
  providerUserInfo: z.array(ProviderSchema).optional(),
  mfaInfo: z.array(z.unknown()).optional(),
  customAttributes: z.string().optional(),
  tenantId: z.string().optional(),
});

/** What Identity Toolkit returns in place of a hash the caller may not see. */
const REDACTED = 'REDACTED';

/** A sign-in identity from another provider (Google, Microsoft…), which the import keeps. */
export interface FederatedIdentity {
  providerId: string;
  /** The provider's own id for the person (Google's `sub`); empty when the source lacks it. */
  rawId: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
}

export interface LegacyAuthRecord {
  uid: string;
  /** The Auth record's email, which the import uses (never the profile's). */
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  photoUrl?: string;
  phoneNumber?: string;
  disabled: boolean;
  /** Epoch milliseconds, as a string. */
  createdAt?: string;
  /** Every linked provider except password and phone. */
  identities: FederatedIdentity[];
  /**
   * `none`: no password. `hash`: a password with its scrypt hash (from an export). `unavailable`:
   * a password whose hash this source doesn't show (redacted or missing).
   */
  password: 'none' | 'hash' | 'unavailable';
  /** Base64, only when `password` is `hash`. */
  passwordHash?: string;
  passwordSalt?: string;
  phoneSignIn: boolean;
  mfaFactors: number;
  /** Legacy custom claims are never imported: v2 sets its own (FND-17) at load (MIG-06). */
  hasCustomClaims: boolean;
  tenantId?: string;
}

/** Drops undefined fields, so optional fields stay absent (exactOptionalPropertyTypes). */
export function present<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function isRedacted(hash: string): boolean {
  return Buffer.from(hash, 'base64').toString('utf8') === REDACTED || hash === REDACTED;
}

/** Parses one Identity Toolkit account (lookup or export). Throws on a shape it can't use. */
export function parseAuthUser(raw: unknown): LegacyAuthRecord {
  const user = AuthUserSchema.parse(raw);
  const providers = user.providerUserInfo ?? [];
  const hash = user.passwordHash && !isRedacted(user.passwordHash) ? user.passwordHash : undefined;
  const hasPassword = Boolean(user.passwordHash) || providers.some((p) => p.providerId === 'password');
  const claims = user.customAttributes ? (JSON.parse(user.customAttributes) as unknown) : undefined;
  return {
    uid: user.localId,
    ...present({
      email: user.email,
      displayName: user.displayName,
      photoUrl: user.photoUrl,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt,
      tenantId: user.tenantId,
    }),
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    identities: providers
      .filter((p) => p.providerId !== 'password' && p.providerId !== 'phone')
      .map((p) => ({
        providerId: p.providerId,
        rawId: p.rawId ?? '',
        ...present({ email: p.email, displayName: p.displayName, photoUrl: p.photoUrl }),
      })),
    password: hash ? 'hash' : hasPassword ? 'unavailable' : 'none',
    ...(hash ? present({ passwordHash: hash, passwordSalt: user.salt }) : {}),
    phoneSignIn: providers.some((p) => p.providerId === 'phone'),
    mfaFactors: (user.mfaInfo ?? []).length,
    hasCustomClaims: typeof claims === 'object' && claims !== null && Object.keys(claims).length > 0,
  };
}

/**
 * Reads the one account for `uid` from a file: an `auth:export` file (`{ users: [...] }`) or a
 * single account object. A file holding anyone else is refused: the export must be filtered to the
 * one user, and the full export deleted, before the import sees it.
 */
export async function readAuthRecordFile(path: string, uid: string): Promise<LegacyAuthRecord> {
  const json = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const users =
    typeof json === 'object' && json !== null && 'users' in json && Array.isArray(json.users)
      ? (json.users as unknown[])
      : [json];
  if (users.length !== 1) {
    throw new Error(
      `${path} holds ${users.length} accounts. Filter the export to the one user (jq '{users: [.users[] | ` +
        `select(.localId == "${uid}")]}'), then delete the full export.`,
    );
  }
  const record = parseAuthUser(users[0]);
  if (record.uid !== uid) throw new Error(`${path} holds ${record.uid}, not ${uid}.`);
  return record;
}
