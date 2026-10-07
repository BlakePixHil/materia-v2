import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore/lite';
import {
  ensureInitialized,
  fetchAndActivate,
  getAll,
  getRemoteConfig,
  type RemoteConfig,
} from 'firebase/remote-config';

import { FLAG_KEYS, FLAGS, remoteConfigKey, type FlagValue } from '@materia/domain';

import type { FlagValueSource } from './feature-flags';
import { environment } from '../../../environments/environment';
import { firebaseApp } from '../firebase-app';

/**
 * Remote Config is fetched at most this often: 1 hour in prod, 1 minute everywhere else (the
 * deployed dev site included, so a flag flipped in the dev console shows up on the next reload).
 */
export const fetchIntervalMs = (env: string = environment.name) => (env === 'prod' ? 3_600_000 : 60_000);

/** The registry's flags as Remote Config has them (only values set in the console). */
function readFlags(config: RemoteConfig): Record<string, FlagValue> {
  const all = getAll(config);
  const values: Record<string, FlagValue> = {};
  for (const key of FLAG_KEYS) {
    const value = all[remoteConfigKey(key)];
    if (!value || value.getSource() !== 'remote') continue;
    const type = FLAGS[key].type;
    values[key] = type === 'boolean' ? value.asBoolean() : type === 'number' ? value.asNumber() : value.asString();
  }
  return values;
}

/**
 * Remote Config and the org document, through the Firebase SDK (lazy-loaded). The emulators have
 * no client Remote Config, so locally only the registry defaults and org overrides apply.
 */
export function createFirebaseFlagSource(): FlagValueSource {
  const app = firebaseApp();
  const firestore = getFirestore(app);
  if (environment.useEmulators) connectFirestoreEmulator(firestore, '127.0.0.1', 8080);

  return {
    async remote(updated) {
      if (environment.useEmulators) return {};
      const config = getRemoteConfig(app);
      config.settings.minimumFetchIntervalMillis = fetchIntervalMs();
      // The values this device fetched last load from IndexedDB at once and apply now; the fetch
      // runs behind them (at most every fetchIntervalMs) and replaces them if they changed, so
      // flagged UI doesn't wait on the network. The very first load still waits for it.
      await ensureInitialized(config);
      const fetched = fetchAndActivate(config);
      if (config.lastFetchStatus === 'no-fetch-yet') {
        await fetched;
        return readFlags(config);
      }
      fetched.then(
        (activated) => {
          if (activated) updated?.(readFlags(config));
        },
        () => undefined,
      );
      return readFlags(config);
    },
    async org(orgId) {
      const snapshot = await getDoc(doc(firestore, 'orgs', orgId));
      return (snapshot.get('flags') as Record<string, unknown> | undefined) ?? {};
    },
  };
}
