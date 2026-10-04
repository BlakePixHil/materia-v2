import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let app: App | undefined;

/** The Admin SDK app, initialised once and lazily (keeps cold starts light). */
export function adminApp(): App {
  app ??= getApps()[0] ?? initializeApp();
  return app;
}

export function adminDb(): Firestore {
  return getFirestore(adminApp());
}
