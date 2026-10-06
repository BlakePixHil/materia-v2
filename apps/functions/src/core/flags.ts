import type { Firestore } from 'firebase-admin/firestore';
import { getRemoteConfig } from 'firebase-admin/remote-config';

import {
  DomainError,
  FLAG_KEYS,
  FLAGS,
  remoteConfigKey,
  resolveFlag,
  type FlagKey,
  type FlagValue,
  type FlagValueOf,
} from '@materia/domain';

import { adminApp } from './admin';
import { useFakes } from './env';
import { createLog, errorReportFields } from './log';

/** How long Remote Config and org overrides are cached per instance. */
export const FLAG_CACHE_MS = 60_000;

export interface FlagContext {
  orgId?: string | null;
  db: Firestore;
  clock: { now(): Date };
}

/** Remote Config values for the registry's flags (only those set remotely). Swappable for tests. */
export type RemoteFlagLoader = () => Promise<Record<string, FlagValue>>;

/** Reads the Remote Config server template. Fakes (emulator) use the registry defaults only. */
export const loadRemoteFlags: RemoteFlagLoader = async () => {
  if (useFakes()) return {};
  const template = await getRemoteConfig(adminApp()).getServerTemplate();
  const config = template.evaluate();
  const values: Record<string, FlagValue> = {};
  for (const key of FLAG_KEYS) {
    const value = config.getValue(remoteConfigKey(key));
    if (value.getSource() !== 'remote') continue;
    const type = FLAGS[key].type;
    values[key] = type === 'boolean' ? value.asBoolean() : type === 'number' ? value.asNumber() : value.asString();
  }
  return values;
};

let remoteLoader: RemoteFlagLoader = loadRemoteFlags;
let remoteCache: { at: number; values: Promise<Record<string, FlagValue>> } | undefined;
const orgCache = new Map<string, { at: number; values: Promise<Record<string, unknown>> }>();

/** Drops the cached values, so the next read sees a just-written override. */
export function clearFlagCaches(): void {
  remoteCache = undefined;
  orgCache.clear();
}

/** For tests: swap the Remote Config loader (and drop the caches). */
export function setRemoteFlagLoader(loader: RemoteFlagLoader = loadRemoteFlags): void {
  remoteLoader = loader;
  clearFlagCaches();
}

async function remoteValues(now: number): Promise<Record<string, FlagValue>> {
  if (!remoteCache || now - remoteCache.at > FLAG_CACHE_MS) {
    // Remote Config down: registry defaults (and org overrides) still apply. Logged, because a lost
    // read turns every server-enforced flag off ("This feature isn't turned on for your practice yet").
    remoteCache = {
      at: now,
      values: remoteLoader().catch((error: unknown) => {
        createLog({ fn: 'flags' }).warn('Remote Config read failed; using flag defaults', errorReportFields(error));
        return {};
      }),
    };
  }
  return remoteCache.values;
}

async function orgValues(db: Firestore, orgId: string, now: number): Promise<Record<string, unknown>> {
  const hit = orgCache.get(orgId);
  if (hit && now - hit.at <= FLAG_CACHE_MS) return hit.values;
  const values = db
    .doc(`orgs/${orgId}`)
    .get()
    .then((snapshot) => (snapshot.get('flags') as Record<string, unknown> | undefined) ?? {});
  orgCache.set(orgId, { at: now, values });
  return values;
}

/** A flag's value for the caller's org: org override, then Remote Config, then the default. */
export async function flagValue<K extends FlagKey>(ctx: FlagContext, key: K): Promise<FlagValueOf<K>> {
  const now = ctx.clock.now().getTime();
  const [remote, org] = await Promise.all([
    remoteValues(now),
    ctx.orgId ? orgValues(ctx.db, ctx.orgId, now) : Promise.resolve({}),
  ]);
  return resolveFlag(key, { remote, org }).value;
}

export async function isEnabled(ctx: FlagContext, key: FlagKey): Promise<boolean> {
  return (await flagValue(ctx, key)) === true;
}

/**
 * Stops a callable when its server-enforced flag is off (FND-23): hiding a feature in the client
 * isn't security. Throws FEATURE_DISABLED.
 */
export async function requireFlag(ctx: FlagContext, key: FlagKey): Promise<void> {
  if (!(await isEnabled(ctx, key))) throw new DomainError('FEATURE_DISABLED', `Feature ${key} is off`, { flag: key });
}
