import { getApp, getApps, initializeApp } from 'firebase/app';

import { createFirestoreJobSource, type JobSource } from '@materia/data-access';

import { environment } from '../../../environments/environment';

/** The Firestore job watcher for this environment (lazy-loaded by JOB_SOURCE). */
export function createJobSource(): Promise<JobSource> {
  const app = getApps().length ? getApp() : initializeApp(environment.firebase);
  return createFirestoreJobSource(app, { emulators: environment.useEmulators });
}
