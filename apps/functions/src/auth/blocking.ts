import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
  type AuthBlockingEvent,
} from 'firebase-functions/v2/identity';

import { describeUserAgent, SIGN_IN_LOG_DAYS, SignIn } from '@materia/domain';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { flagValue } from '../core/flags';
import { createLog, functionsSink, type LogSink } from '../core/log';

/**
 * Projects with open sign-up when Remote Config doesn't set `auth_openSignup` (the
 * `auth.openSignup` flag, FND-23): anyone may create an account (to create an org). On for dev; off
 * for prod and the emulator (`demo-materia`) until the owner decides.
 */
export const OPEN_SIGNUP_PROJECTS: readonly string[] = ['materia-v2-dev'];

export function openSignupFor(projectId: string | undefined): boolean {
  return !!projectId && OPEN_SIGNUP_PROJECTS.includes(projectId);
}

/** Shown to the person in the sign-up error; the web app matches on the code. */
export const SIGNUP_CLOSED_MESSAGE = 'SIGNUP_CLOSED: Sign-up is by invitation only';

export interface BlockingDeps {
  db: () => Firestore;
  openSignup: () => boolean | Promise<boolean>;
  now: () => Date;
  sink: LogSink;
}

/** True when the email has an invite that is pending and not expired, in any org. */
export async function hasPendingInvite(db: Firestore, email: string, now: Date): Promise<boolean> {
  const snapshot = await db
    .collectionGroup('invites')
    .where('email', '==', email.toLowerCase())
    .where('status', '==', 'pending')
    .get();
  return snapshot.docs.some((doc) => {
    const expiresAt = doc.get('expiresAt') as Timestamp | undefined;
    return !expiresAt || expiresAt.toMillis() > now.getTime();
  });
}

/** `beforeUserCreated`: sign-up needs a pending invite unless open sign-up is on. */
export async function checkSignUp(
  event: Pick<AuthBlockingEvent, 'data' | 'eventId'>,
  deps: BlockingDeps,
): Promise<void> {
  const log = createLog({ fn: 'auth-beforeCreate', eventId: event.eventId, uid: event.data?.uid ?? null }, deps.sink);
  if (await deps.openSignup()) return;
  const email = event.data?.email;
  if (email && (await hasPendingInvite(deps.db(), email, deps.now()))) {
    log.info('sign-up allowed by invite');
    return;
  }
  log.warn('sign-up blocked: no invite');
  throw new HttpsError('permission-denied', SIGNUP_CLOSED_MESSAGE);
}

/**
 * `beforeUserSignedIn`: stamps the sign-in time in the server-only `users/{uid}/private/session`,
 * and logs the sign-in in `users/{uid}/signIns/{eventId}` for "Your sessions" (SEC-04): when, how,
 * and a coarse device and browser. Never the IP address or the raw user agent.
 */
export async function stampSignIn(
  event: Pick<AuthBlockingEvent, 'data' | 'eventId' | 'additionalUserInfo'> & { userAgent?: string },
  deps: BlockingDeps,
): Promise<void> {
  const uid = event.data?.uid;
  if (!uid) return;
  const db = deps.db();
  const now = deps.now();
  const provider = event.additionalUserInfo?.providerId ?? 'unknown';
  const entry = SignIn.schema.parse({
    at: now,
    authTime: Math.floor(now.getTime() / 1000),
    provider: provider.slice(0, 64),
    ...describeUserAgent(event.userAgent),
    secondFactor: (event.data?.multiFactor?.enrolledFactors?.length ?? 0) > 0,
    expireAt: new Date(now.getTime() + SIGN_IN_LOG_DAYS * 86_400_000),
    createdAt: now,
    createdBy: uid,
    updatedAt: now,
    updatedBy: uid,
    schemaVersion: SignIn.version,
  });
  const batch = db.batch();
  batch.set(
    db.doc(`users/${uid}/private/session`),
    {
      lastSignInAt: FieldValue.serverTimestamp(),
      lastSignInProvider: provider,
      signInCount: FieldValue.increment(1),
    },
    { merge: true },
  );
  batch.set(db.doc(`users/${uid}/signIns/${event.eventId}`), entry);
  await batch.commit();
}

const deps = (): BlockingDeps => ({
  db: adminDb,
  // The Remote Config flag when set (no org applies before sign-up), else the project list.
  openSignup: async () =>
    (await flagValue({ db: adminDb(), clock: { now: () => new Date() } }, 'auth.openSignup')) ||
    openSignupFor(process.env['GCLOUD_PROJECT']),
  now: () => new Date(),
  sink: functionsSink,
});

/** `auth-beforeCreate`. Firebase allows one blocking function per event in a project. */
export const beforeCreate = beforeUserCreated({ region: REGION }, (event) => checkSignUp(event, deps()));

/** `auth-beforeSignIn`. */
export const beforeSignIn = beforeUserSignedIn({ region: REGION }, (event) => stampSignIn(event, deps()));
