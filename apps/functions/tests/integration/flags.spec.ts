import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * FND-23 acceptance tests through the emulators: a server-enforced flag stops its callable
 * (`system-echo` behind `system.echo`), and only platform admins can set org overrides. Fictional data.
 */
const PROJECT_ID = 'demo-materia';
const PASSWORD = 'fictional-password-1';
const OFF_ORG = 'org-flags-off';
const ON_ORG = 'org-flags-on';

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const fns = () => getFunctions(client, 'australia-southeast1');
const echo = (message: string) =>
  httpsCallable<Record<string, unknown>, { message: string }>(
    fns(),
    'system-echo',
  )({ requestId: randomUUID(), message });
const setOverride = (orgId: string, key: string, value: boolean | null) =>
  httpsCallable<Record<string, unknown>, { ok: boolean }>(fns(), 'flags-setOrgOverride')({ orgId, key, value });

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}

async function createUser(uid: string, claims: Record<string, unknown>, orgId?: string) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email: `${uid}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uid, claims);
  if (orgId) await db.doc(`orgs/${orgId}/members/${uid}`).set({ role: claims['role'], status: 'active' });
}

async function signInAs(uid: string) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uid}@example.test`, PASSWORD);
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'flags-integration-admin');
  db = getAdminFirestore(admin);
  for (const org of [OFF_ORG, ON_ORG]) {
    await db.recursiveDelete(db.doc(`orgs/${org}`));
    await db.doc(`orgs/${org}`).set({ name: 'Fictional Flag Practice' });
  }
  await createUser('flags-platform-admin', { platformAdmin: true });
  await createUser('flags-owner', { orgId: OFF_ORG, role: 'owner' }, OFF_ORG);
  await createUser('flags-lawyer-off', { orgId: OFF_ORG, role: 'lawyer' }, OFF_ORG);
  await createUser('flags-lawyer-on', { orgId: ON_ORG, role: 'lawyer' }, ON_ORG);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'flags-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(fns(), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('feature flags through the emulators', () => {
  it('only platform admins can set org overrides', async () => {
    await signInAs('flags-owner');
    const denied = await failure(setOverride(OFF_ORG, 'system.echo', false));
    expect([denied.code, (denied.details as { code?: string }).code]).toEqual([
      'functions/permission-denied',
      'PERMISSION_DENIED',
    ]);
    await signInAs('flags-platform-admin');
    const unknown = await failure(setOverride(OFF_ORG, 'no.such.flag', true));
    expect(unknown.code).toBe('functions/invalid-argument');
    expect((await setOverride(OFF_ORG, 'system.echo', false)).data).toEqual({ ok: true });
    const org = await db.doc(`orgs/${OFF_ORG}`).get();
    expect(org.get('flags')).toEqual({ 'system.echo': false });
    expect(org.get('updatedBy')).toBe('flags-platform-admin');
    const audit = await db.collection(`orgs/${OFF_ORG}/audit`).where('action', '==', 'flag.override_set').get();
    expect(audit.docs.map((d) => d.get('entity.path'))).toEqual([`orgs/${OFF_ORG}/flags/system.echo`]);
  });

  it('a server-enforced flag that is off blocks its callable for that org only', async () => {
    await signInAs('flags-lawyer-off');
    const blocked = await failure(echo('hello'));
    expect([blocked.code, blocked.details as { code?: string; flag?: string }]).toEqual([
      'functions/failed-precondition',
      expect.objectContaining({ code: 'FEATURE_DISABLED', flag: 'system.echo' }),
    ]);
    await signInAs('flags-lawyer-on');
    expect((await echo('hello')).data.message).toBe('hello');
  });
});
