import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

import { ROLES, type Role } from '@materia/domain';

/**
 * FND-15 acceptance tests for the callable wrapper, end to end through the emulators: a signed-in
 * client calls `system-echo` with real custom claims, and `system-recordEcho` runs from Cloud Tasks.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-a';
const PASSWORD = 'fictional-password-1';
const emailFor = (who: string) => `${who}@example.test`;

let admin: App;
let client: FirebaseApp;
let auth: Auth;

async function createUser(who: string, claims: { orgId: string; role: Role } | null, memberStatus: string | null) {
  const adminAuth = getAdminAuth(admin);
  const user = await adminAuth.createUser({ uid: who, email: emailFor(who), password: PASSWORD });
  if (claims) await adminAuth.setCustomUserClaims(user.uid, claims);
  if (memberStatus) {
    await getAdminFirestore(admin)
      .doc(`orgs/${ORG}/members/${who}`)
      .set({ role: claims?.role ?? 'lawyer', status: memberStatus });
  }
}

async function signInAs(who: string) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emailFor(who), PASSWORD);
}

const echo = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, Record<string, unknown>>(
    getFunctions(client, 'australia-southeast1'),
    'system-echo',
  )(data);

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}

const detailCode = (error: FunctionsError) => (error.details as { code?: string } | undefined)?.code;

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'integration-admin');
  await getAdminAuth(admin)
    .listUsers()
    .then((list) => Promise.all(list.users.map((u) => getAdminAuth(admin).deleteUser(u.uid))));
  for (const role of ROLES) await createUser(role, { orgId: ORG, role }, 'active');
  await createUser('suspended', { orgId: ORG, role: 'lawyer' }, 'suspended');
  await createUser('no-claims', null, null);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('system-echo through the emulators', () => {
  it('requires authentication', async () => {
    await signOut(auth);
    const error = await failure(echo({ requestId: randomUUID(), message: 'hi' }));
    expect([error.code, detailCode(error)]).toEqual(['functions/unauthenticated', 'UNAUTHENTICATED']);
  });

  it('requires the org claim', async () => {
    await signInAs('no-claims');
    const error = await failure(echo({ requestId: randomUUID(), message: 'hi' }));
    expect(detailCode(error)).toBe('ORG_CLAIM_MISSING');
  });

  it('denies a role without matter.edit (readonly)', async () => {
    await signInAs('readonly');
    const error = await failure(echo({ requestId: randomUUID(), message: 'hi' }));
    expect([error.code, detailCode(error)]).toEqual(['functions/permission-denied', 'PERMISSION_DENIED']);
  });

  it('denies a suspended member', async () => {
    await signInAs('suspended');
    const error = await failure(echo({ requestId: randomUUID(), message: 'hi' }));
    // auth-syncClaims (FND-17) clears a suspended member's org claim; until it has run, the
    // callable's member lookup denies the stale claim. Either way the call is refused.
    expect(['MEMBER_INACTIVE', 'ORG_CLAIM_MISSING']).toContain(detailCode(error));
  });

  it('rejects invalid input with field paths', async () => {
    await signInAs('paralegal');
    const error = await failure(echo({ requestId: randomUUID(), message: '' }));
    expect(error.code).toBe('functions/invalid-argument');
    expect((error.details as { fields: Record<string, string[]> }).fields).toHaveProperty('message');
  });

  it('echoes for an allowed role, and replays the stored result for the same requestId', async () => {
    await signInAs('lawyer');
    const requestId = randomUUID();
    const first = await echo({ requestId, message: 'hello' });
    expect(first.data).toMatchObject({ message: 'hello', uid: 'lawyer', orgId: ORG, role: 'lawyer', requestId });
    const replay = await echo({ requestId, message: 'hello' });
    expect(replay.data).toEqual(first.data);
    const stored = await getAdminFirestore(admin).doc(`orgs/${ORG}/requests/${requestId}`).get();
    expect(stored.get('status')).toBe('done');
    expect(stored.get('expiresAt').toMillis() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it('runs exactly one of two concurrent calls with the same requestId', async () => {
    await signInAs('lawyer');
    const requestId = randomUUID();
    const results = await Promise.allSettled([
      echo({ requestId, message: 'race' }),
      echo({ requestId, message: 'race' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      data: Record<string, unknown>;
    }>[];
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Either the second replayed the same result, or it was told to retry.
    for (const r of failed) expect(detailCode(r.reason as FunctionsError)).toBe('REQUEST_IN_PROGRESS');
    if (ok.length === 2) expect(ok[0]?.value.data).toEqual(ok[1]?.value.data);
  });

  it('maps a DomainError to its code and hides unexpected errors', async () => {
    await signInAs('owner');
    const domain = await failure(echo({ requestId: randomUUID(), message: 'x', fail: 'domain' }));
    // The client SDK appends the HTTP status to the message ("… [400]").
    expect([domain.code, detailCode(domain)]).toEqual(['functions/failed-precondition', 'FAILED_PRECONDITION']);
    expect(domain.message).toMatch(/^Echo was asked to fail/);
    const crash = await failure(echo({ requestId: randomUUID(), message: 'x', fail: 'crash' }));
    expect([crash.code, detailCode(crash)]).toEqual(['functions/internal', 'INTERNAL']);
    expect(crash.message).toMatch(/^Internal error/);
    expect(JSON.stringify(crash)).not.toContain('Whitfield');
  });

  it('flags a stale org claim', async () => {
    await signInAs('admin');
    const error = await failure(echo({ requestId: randomUUID(), message: 'x', orgId: 'org-b' }));
    expect(detailCode(error)).toBe('ORG_CLAIM_MISMATCH');
  });
});

describe('Cloud Tasks through the emulators', () => {
  it('enqueues system-recordEcho and the task runs', async () => {
    await signInAs('admin');
    const requestId = randomUUID();
    await echo({ requestId, message: 'later', deferred: true });
    const ref = getAdminFirestore(admin).doc(`systemTasks/echo-${requestId}`);
    const deadline = Date.now() + 20_000;
    let handled = false;
    while (Date.now() < deadline && !handled) {
      handled = (await ref.get()).exists;
      if (!handled) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(handled).toBe(true);
    expect((await ref.get()).get('orgId')).toBe(ORG);
  });
});
