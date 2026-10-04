import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

/**
 * FND-16 acceptance tests through the emulators: the sign-up gate (`auth-beforeCreate`), the
 * sign-in stamp (`auth-beforeSignIn`), and MFA recovery codes. The emulator project
 * (`demo-materia`) has open sign-up off, like prod. All data is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-auth';
const PASSWORD = 'fictional-password-12';
const INVITED = 'invited.person@example.test';

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const fns = () => getFunctions(client, 'australia-southeast1');
const generateCodes = () =>
  httpsCallable<Record<string, never>, { codes: string[] }>(fns(), 'auth-generateRecoveryCodes')({});
const useCode = (email: string, code: string) =>
  httpsCallable<{ email: string; code: string }, { ok: boolean; remaining: number }>(
    fns(),
    'auth-useRecoveryCode',
  )({ email, code });

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'auth-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  const mine = new Set([INVITED, 'stranger.person@example.test']);
  await Promise.all(existing.users.filter((u) => u.email && mine.has(u.email)).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}/invites/inv-1`).set({
    email: INVITED,
    role: 'paralegal',
    tokenHash: 'f'.repeat(64),
    expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86_400_000),
    status: 'pending',
    invitedBy: 'someone',
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'auth-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(fns(), '127.0.0.1', 5001);
  connectFirestoreEmulator(getFirestore(client), '127.0.0.1', 8080);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('sign-up gate', () => {
  it('refuses sign-up without an invite', async () => {
    const error = await failure(createUserWithEmailAndPassword(auth, 'stranger.person@example.test', PASSWORD));
    expect(error.message).toContain('SIGNUP_CLOSED');
    await expect(getAdminAuth(admin).getUserByEmail('stranger.person@example.test')).rejects.toBeDefined();
  });

  it('allows sign-up with a pending invite, and stamps the sign-in', async () => {
    const credential = await createUserWithEmailAndPassword(auth, INVITED, PASSWORD);
    expect(credential.user.email).toBe(INVITED);
    await signOut(auth);
    await signInWithEmailAndPassword(auth, INVITED, PASSWORD);
    const session = await poll(async () => {
      const snapshot = await db.doc(`users/${credential.user.uid}/private/session`).get();
      return snapshot.exists && (snapshot.get('signInCount') as number) >= 2 ? snapshot.data() : undefined;
    });
    expect(session?.['lastSignInAt']).toBeInstanceOf(Timestamp);
    expect(session?.['lastSignInProvider']).toBe('password');
  });
});

describe('MFA recovery codes', () => {
  it('generates ten codes the client cannot read back, and each works exactly once', async () => {
    await signInWithEmailAndPassword(auth, INVITED, PASSWORD);
    const uid = auth.currentUser?.uid as string;
    const { data } = await generateCodes();
    expect(data.codes).toHaveLength(10);

    // Server-only: the signed-in owner can't read the hashes.
    const denied = await failure(getDoc(doc(getFirestore(client), `users/${uid}/private/recovery`)));
    expect(denied.code).toBe('permission-denied');
    const stored = await db.doc(`users/${uid}/private/recovery`).get();
    expect(JSON.stringify(stored.data())).not.toContain((data.codes[0] as string).replace('-', ''));

    await signOut(auth);
    const first = data.codes[0] as string;
    expect((await useCode(INVITED, first)).data).toEqual({ ok: true, remaining: 9 });
    const reused = await failure(useCode(INVITED, first));
    expect([reused.code, (reused.details as { code?: string }).code]).toEqual([
      'functions/invalid-argument',
      'INVALID_ARGUMENT',
    ]);
    const unknown = await failure(useCode('nobody.here@example.test', first));
    expect((unknown.details as { code?: string }).code).toBe('INVALID_ARGUMENT');
  });

  it('needs a signed-in user to generate codes', async () => {
    await signOut(auth);
    expect((await failure(generateCodes())).code).toBe('functions/unauthenticated');
  });
});
