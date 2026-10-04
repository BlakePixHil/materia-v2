import { isDevMode } from '@angular/core';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore/lite';
import { fetchAndActivate, getAll, getRemoteConfig } from 'firebase/remote-config';

import { FLAG_KEYS, FLAGS, remoteConfigKey, type FlagValue } from '@materia/domain';

import type { FlagValueSource } from './feature-flags';
import { environment } from '../../../environments/environment';
import { firebaseApp } from '../firebase-app';

/** Remote Config is fetched at most this often: 1 minute in dev builds, 1 hour in production. */
export const fetchIntervalMs = () => (isDevMode() ? 60_000 : 3_600_000);

/**
 * Remote Config and the org document, through the Firebase SDK (lazy-loaded). The emulators have
 * no client Remote Config, so locally only the registry defaults and org overrides apply.
 */
export function createFirebaseFlagSource(): FlagValueSource {
  const app = firebaseApp();
  const firestore = getFirestore(app);
  if (environment.useEmulators) connectFirestoreEmulator(firestore, '127.0.0.1', 8080);

  return {
    async remote() {
      if (environment.useEmulators) return {};
      const config = getRemoteConfig(app);
      config.settings.minimumFetchIntervalMillis = fetchIntervalMs();
      await fetchAndActivate(config);
      const all = getAll(config);
      const values: Record<string, FlagValue> = {};
      for (const key of FLAG_KEYS) {
        const value = all[remoteConfigKey(key)];
        if (!value || value.getSource() !== 'remote') continue;
        const type = FLAGS[key].type;
        values[key] = type === 'boolean' ? value.asBoolean() : type === 'number' ? value.asNumber() : value.asString();
      }
      return values;
    },
    async org(orgId) {
      const snapshot = await getDoc(doc(firestore, 'orgs', orgId));
      return (snapshot.get('flags') as Record<string, unknown> | undefined) ?? {};
    },
  };
}
