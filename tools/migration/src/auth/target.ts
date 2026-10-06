import type { Auth, UserImportOptions, UserImportRecord, UserRecord } from 'firebase-admin/auth';

import type { TargetState, TargetUser } from './plan.ts';
import type { LegacyAuthRecord } from './record.ts';
import type { RestDeps } from '../legacy/rest.ts';

/**
 * The v2 side of the auth import (MIG-04): Identity Platform through the Admin SDK (or the Auth
 * emulator), plus two REST reads the SDK doesn't offer: which sign-in providers are on, and the
 * scrypt parameters in Secret Manager.
 */

export interface TargetAuth {
  getUser(uid: string): Promise<TargetUser | null>;
  getUserByEmail(email: string): Promise<TargetUser | null>;
  getUserByIdentity(providerId: string, rawId: string): Promise<TargetUser | null>;
  /** Imports one user; throws if Identity Platform rejects it. */
  importUser(user: UserImportRecord, options?: UserImportOptions): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

function toTargetUser(user: UserRecord): TargetUser {
  return {
    uid: user.uid,
    ...(user.email ? { email: user.email } : {}),
    providers: user.providerData.map((p) => ({ providerId: p.providerId, uid: p.uid })),
    ...(user.metadata.creationTime ? { createdAt: user.metadata.creationTime } : {}),
    ...(user.metadata.lastSignInTime ? { lastSignInAt: user.metadata.lastSignInTime } : {}),
    hasCustomClaims: Object.keys(user.customClaims ?? {}).length > 0,
  };
}

async function orNull(lookup: Promise<UserRecord>): Promise<TargetUser | null> {
  try {
    return toTargetUser(await lookup);
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  }
}

export function adminTarget(auth: Auth): TargetAuth {
  return {
    getUser: (uid) => orNull(auth.getUser(uid)),
    getUserByEmail: (email) => orNull(auth.getUserByEmail(email)),
    getUserByIdentity: (providerId, rawId) => orNull(auth.getUserByProviderUid(providerId, rawId)),
    async importUser(user, options) {
      const result = await auth.importUsers([user], options);
      const failure = result.errors[0];
      if (result.failureCount || failure) {
        throw new Error(`Identity Platform refused the import: ${failure?.error.message ?? 'no reason given'}`);
      }
    },
    deleteUser: (uid) => auth.deleteUser(uid),
  };
}

/** The target's users that matter to the plan: the uid itself, and anyone else holding the account. */
export async function readTargetState(
  target: TargetAuth,
  record: LegacyAuthRecord,
  enabledProviders: TargetState['enabledProviders'],
): Promise<TargetState> {
  const byUid = await target.getUser(record.uid);
  const others = new Map<string, TargetUser>();
  const add = (user: TargetUser | null) => {
    if (user && user.uid !== record.uid) others.set(user.uid, user);
  };
  if (record.email) add(await target.getUserByEmail(record.email));
  for (const identity of record.identities) {
    if (identity.rawId) add(await target.getUserByIdentity(identity.providerId, identity.rawId));
  }
  return { byUid, conflicts: [...others.values()], enabledProviders };
}

// ---------- REST reads on the target ----------

const IDENTITY_ADMIN = 'https://identitytoolkit.googleapis.com/admin/v2';
const SECRET_MANAGER = 'https://secretmanager.googleapis.com/v1';

async function get<T>(deps: RestDeps, project: string, url: string): Promise<T | null> {
  const res = await deps.fetch(url, {
    headers: { authorization: `Bearer ${await deps.token()}`, 'x-goog-user-project': project },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** The sign-in providers on in `project`: `password` if email sign-in is, and each enabled IdP. */
export async function enabledProviders(deps: RestDeps, project: string): Promise<Set<string>> {
  const base = `${IDENTITY_ADMIN}/projects/${project}`;
  const config = await get<{ signIn?: { email?: { enabled?: boolean } } }>(deps, project, `${base}/config`);
  const builtIn = await get<{ defaultSupportedIdpConfigs?: { name: string; enabled?: boolean }[] }>(
    deps,
    project,
    `${base}/defaultSupportedIdpConfigs?pageSize=100`,
  );
  const oidc = await get<{ oauthIdpConfigs?: { name: string; enabled?: boolean }[] }>(
    deps,
    project,
    `${base}/oauthIdpConfigs?pageSize=100`,
  );
  const on = new Set<string>();
  if (config?.signIn?.email?.enabled) on.add('password');
  for (const idp of [...(builtIn?.defaultSupportedIdpConfigs ?? []), ...(oidc?.oauthIdpConfigs ?? [])]) {
    const id = idp.name.slice(idp.name.lastIndexOf('/') + 1);
    if (idp.enabled && id) on.add(id);
  }
  return on;
}

/** The latest version of a Secret Manager secret in `project`, or null if it doesn't exist. */
export async function readSecret(deps: RestDeps, project: string, name: string): Promise<string | null> {
  const res = await get<{ payload?: { data?: string } }>(
    deps,
    project,
    `${SECRET_MANAGER}/projects/${project}/secrets/${name}/versions/latest:access`,
  );
  const data = res?.payload?.data;
  return data ? Buffer.from(data, 'base64').toString('utf8') : null;
}
