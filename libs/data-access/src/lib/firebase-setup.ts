import { InjectionToken } from '@angular/core';
import type { FirebaseApp } from 'firebase/app';

import type { FirestoreCacheMode } from './firestore/firestore-client';

/** How to reach Firebase: the app (initialised by the web app) and whether to use the emulators. */
export interface FirebaseSetup {
  /** The initialised app (loaded lazily, so the SDK stays out of the initial bundle). */
  app: () => Promise<FirebaseApp>;
  useEmulators: boolean;
  /** `host:port` of the Firestore emulator (default `127.0.0.1:8080`). */
  firestoreEmulator?: string;
  /** Emulator only: sign Firestore requests as this user (`{ sub, orgId, role }`), for tests without Auth. */
  emulatorUserToken?: { sub: string; [claim: string]: unknown };
  /** Overrides the cache choice (tests); by default the sign-in's shared-computer option decides. */
  cacheMode?: () => FirestoreCacheMode;
}

export const FIREBASE_SETUP = new InjectionToken<FirebaseSetup>('FIREBASE_SETUP');
