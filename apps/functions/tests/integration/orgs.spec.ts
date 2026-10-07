import { createHash, randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth, type Auth as AdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { TERMS_VERSION } from '@materia/domain';

/**
 * FND-17 through the emulators: every orgs callable (happy path and edge cases) and the
 * `auth-syncClaims` trigger, with real custom claims and the emulator outbox for invite emails.
 * All people and practices are fictional.
 */
const PROJECT_ID = 'demo-materia';
const PASSWORD = 'fictional-password-17';
const RUN = Date.now().toString(36);
const emailFor = (who: string) => `${who}-${RUN}@example.test`;

let admin: App;
let db: Firestore;
let adminAuth: AdminAuth;
let client: FirebaseApp;
let auth: Auth;

const fns = () => getFunctions(client, 'australia-southeast1');
function call<T = Record<string, unknown>>(name: string, data: Record<string, unknown> = {}, requestId = randomUUID()) {
  return httpsCallable<Record<string, unknown>, T>(fns(), name)({ requestId, ...data }).then((r) => r.data);
}

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const codeOf = (error: FunctionsError) => (error.details as { code?: string } | undefined)?.code;

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

/** A verified (by default) account with no org. Returns its uid. */
async function person(who: string, emailVerified = true): Promise<string> {
  const user = await adminAuth.createUser({
    email: emailFor(who),
    password: PASSWORD,
    displayName: `${who[0]?.toUpperCase()}${who.slice(1)} Fictional`,
    emailVerified,
  });
  return user.uid;
}

/** Signs in fresh (a new token carries the latest claims). */
async function signInAs(who: string) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emailFor(who), PASSWORD);
}

const claimsOf = async (uid: string) => (await adminAuth.getUser(uid)).customClaims ?? {};
const userDoc = async (uid: string) => (await db.doc(`users/${uid}`).get()).data() ?? {};

async function createOrgAs(who: string, name: string): Promise<string> {
  await signInAs(who);
  const { orgId } = await call<{ orgId: string }>('orgs-createOrg', { name, primaryJurisdiction: 'VIC' });
  await auth.currentUser?.getIdToken(true);
  return orgId;
}

/** The latest invite email the emulator "sent" to this address, and the token in its link. */
async function inviteMail(email: string) {
  const mail = await poll(async () => {
    const snap = await db.collection('emulatorOutbox').where('to', '==', email).get();
    const latest = snap.docs.map((d) => d.data()).sort((a, b) => b['sentAt'].toMillis() - a['sentAt'].toMillis())[0];
    return latest;
  });
  if (!mail) throw new Error(`No invite email for ${email}`);
  const link = new URL(mail['model']['link'] as string);
  return {
    mail,
    inviteId: decodeURIComponent(link.pathname.split('/').at(-1) ?? ''),
    token: link.searchParams.get('token') ?? '',
  };
}

async function inviteAndAccept(ownerWho: string, inviteeWho: string, role: string) {
  await signInAs(ownerWho);
  await call('orgs-inviteMember', { email: emailFor(inviteeWho), role });
  const { inviteId, token } = await inviteMail(emailFor(inviteeWho));
  await signInAs(inviteeWho);
  const result = await call<{ orgId: string }>('orgs-acceptInvite', { inviteId, token });
  await auth.currentUser?.getIdToken(true);
  return result;
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'orgs-integration-admin');
  db = getAdminFirestore(admin);
  adminAuth = getAdminAuth(admin);
  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'orgs-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(fns(), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('orgs-createOrg', () => {
  it('needs a verified email', async () => {
    await person('unverified', false);
    await signInAs('unverified');
    const error = await failure(call('orgs-createOrg', { name: 'Fictional Legal', primaryJurisdiction: 'VIC' }));
    expect(codeOf(error)).toBe('EMAIL_NOT_VERIFIED');
  });

  it('creates the org with defaults, the owner, counters and claims; a repeat call returns the same org', async () => {
    const uid = await person('founder');
    await signInAs('founder');
    const requestId = randomUUID();
    const input = { name: 'Bayside Fictional Legal', primaryJurisdiction: 'VIC', abn: '00 000 000 002' };
    const { orgId } = await call<{ orgId: string }>('orgs-createOrg', input, requestId);
    expect((await call<{ orgId: string }>('orgs-createOrg', input, requestId)).orgId).toBe(orgId);

    const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
    expect(org).toMatchObject({
      name: 'Bayside Fictional Legal',
      abn: '00000000002',
      timezone: 'Australia/Melbourne',
      fy: { startMonth: 7 },
      retentionYears: 7,
      matterNumberFormat: 'M-{YYYY}-{seq:4}',
      billing: { unitMinutes: 6 },
    });
    expect((await db.doc(`orgs/${orgId}/members/${uid}`).get()).data()).toMatchObject({
      role: 'owner',
      status: 'active',
      email: emailFor('founder'),
    });
    expect((await db.doc(`orgs/${orgId}/counters/matters`).get()).get('next')).toBe(1);
    expect(await claimsOf(uid)).toMatchObject({
      orgId,
      role: 'owner',
      orgName: 'Bayside Fictional Legal',
      orgs: { [orgId]: 'owner' },
    });
    const user = await userDoc(uid);
    expect(user).toMatchObject({ activeOrgId: orgId, orgIds: [orgId] });
    // The callable and the auth-syncClaims trigger both sync the new owner. When they overlap, both
    // see the claims change before either sets them and each bumps the version, which only costs the
    // client an extra token refresh. What matters is that the version moved.
    expect(user['claimsVersion']).toBeGreaterThanOrEqual(1);
    const audit = await db.collection(`orgs/${orgId}/audit`).where('action', '==', 'org.created').get();
    expect(audit.size).toBe(1);
    expect(await db.collection('orgs').where('name', '==', 'Bayside Fictional Legal').get()).toHaveProperty('size', 1);
  });
});

describe('terms of service (SEC-01)', () => {
  it('createOrg records the terms the owner ticked', async () => {
    const uid = await person('ticker');
    await signInAs('ticker');
    const { orgId } = await call<{ orgId: string }>('orgs-createOrg', {
      name: 'Ticked Fictional Legal',
      primaryJurisdiction: 'VIC',
      acceptTermsVersion: TERMS_VERSION,
    });
    const org = (await db.doc(`orgs/${orgId}`).get()).data() ?? {};
    expect(org).toMatchObject({ termsAcceptedVersion: TERMS_VERSION, termsAcceptedBy: uid });
    expect(org['termsAcceptedAt']).toBeInstanceOf(Timestamp);
    const audit = await db.collection(`orgs/${orgId}/audit`).where('action', '==', 'org.terms_accepted').get();
    expect(audit.size).toBe(1);
  });

  it('acceptTerms: the owner only, the current version only, recorded and audited once', async () => {
    const ownerUid = await person('signer');
    await person('deputy');
    const orgId = await createOrgAs('signer', 'Unsigned Fictional Legal');
    expect((await db.doc(`orgs/${orgId}`).get()).get('termsAcceptedVersion')).toBeUndefined();
    await inviteAndAccept('signer', 'deputy', 'admin');

    // `deputy` is signed in as an admin of the org.
    expect(codeOf(await failure(call('orgs-acceptTerms', { version: TERMS_VERSION })))).toBe('PERMISSION_DENIED');
    await signInAs('signer');
    expect(codeOf(await failure(call('orgs-acceptTerms', { version: '0.0' })))).toBe('FAILED_PRECONDITION');
    expect(await call('orgs-acceptTerms', { version: TERMS_VERSION })).toEqual({
      version: TERMS_VERSION,
      recorded: true,
    });
    expect(await call('orgs-acceptTerms', { version: TERMS_VERSION })).toEqual({
      version: TERMS_VERSION,
      recorded: false,
    });
    expect((await db.doc(`orgs/${orgId}`).get()).data()).toMatchObject({
      termsAcceptedVersion: TERMS_VERSION,
      termsAcceptedBy: ownerUid,
    });
    const audit = await db.collection(`orgs/${orgId}/audit`).where('action', '==', 'org.terms_accepted').get();
    expect(audit.size).toBe(1);
  });
});

describe('invites', () => {
  let orgId: string;
  beforeAll(async () => {
    await person('inviter');
    orgId = await createOrgAs('inviter', 'Inviter Fictional Partners');
  });

  it('stores only the token hash and emails the link', async () => {
    const { inviteId, emailed } = await call<{ inviteId: string; emailed: boolean }>('orgs-inviteMember', {
      email: emailFor('newbie').toUpperCase(),
      role: 'paralegal',
    });
    expect(emailed).toBe(true);
    const invite = (await db.doc(`orgs/${orgId}/invites/${inviteId}`).get()).data() ?? {};
    expect(invite).toMatchObject({ email: emailFor('newbie'), role: 'paralegal', status: 'pending' });
    expect(Object.keys(invite)).not.toContain('token');
    const { token, mail } = await inviteMail(emailFor('newbie'));
    expect(mail['template']).toBe('invite');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(invite['tokenHash']).toBe(createHash('sha256').update(token).digest('hex'));
    expect((invite['expiresAt'] as Timestamp).toMillis() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it('accepting: wrong email, wrong token, then success; accepting again is a no-op', async () => {
    await person('newbie');
    await person('impostor');
    const { inviteId, token } = await inviteMail(emailFor('newbie'));

    await signInAs('impostor');
    expect(codeOf(await failure(call('orgs-acceptInvite', { inviteId, token })))).toBe('INVITE_EMAIL_MISMATCH');
    await signInAs('newbie');
    expect(codeOf(await failure(call('orgs-acceptInvite', { inviteId, token: 'x'.repeat(43) })))).toBe(
      'INVITE_INVALID',
    );

    const first = await call<{ orgId: string; orgName: string }>('orgs-acceptInvite', { inviteId, token });
    expect(first).toEqual({ orgId, orgName: 'Inviter Fictional Partners' });
    const again = await call<{ orgId: string }>('orgs-acceptInvite', { inviteId, token });
    expect(again.orgId).toBe(orgId);
    const uid = auth.currentUser?.uid as string;
    expect(await claimsOf(uid)).toMatchObject({ orgId, role: 'paralegal' });
    expect((await db.doc(`orgs/${orgId}/invites/${inviteId}`).get()).data()).toMatchObject({
      status: 'accepted',
      acceptedBy: uid,
    });
    const joined = await db.collection(`orgs/${orgId}/audit`).where('action', '==', 'member.joined').get();
    expect(joined.size).toBe(1);
  });

  it('refuses an invite for an existing member and an expired invite', async () => {
    await signInAs('inviter');
    expect(codeOf(await failure(call('orgs-inviteMember', { email: emailFor('newbie'), role: 'lawyer' })))).toBe(
      'ALREADY_MEMBER',
    );
    await person('late');
    await call('orgs-inviteMember', { email: emailFor('late'), role: 'lawyer' });
    const { inviteId, token } = await inviteMail(emailFor('late'));
    await db.doc(`orgs/${orgId}/invites/${inviteId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await signInAs('late');
    expect(codeOf(await failure(call('orgs-acceptInvite', { inviteId, token })))).toBe('INVITE_EXPIRED');
  });

  it('resend replaces the token; revoke stops the link', async () => {
    await signInAs('inviter');
    await person('resent');
    const { inviteId } = await call<{ inviteId: string }>('orgs-inviteMember', {
      email: emailFor('resent'),
      role: 'readonly',
    });
    const old = await inviteMail(emailFor('resent'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await call('orgs-resendInvite', { inviteId });
    const fresh = await poll(async () => {
      const latest = await inviteMail(emailFor('resent'));
      return latest.token !== old.token ? latest : undefined;
    });
    expect(fresh?.inviteId).toBe(inviteId);
    await call('orgs-revokeInvite', { inviteId });
    expect(codeOf(await failure(call('orgs-revokeInvite', { inviteId })))).toBe('FAILED_PRECONDITION');
    await signInAs('resent');
    expect(codeOf(await failure(call('orgs-acceptInvite', { inviteId, token: fresh?.token as string })))).toBe(
      'INVITE_INVALID',
    );
    expect(codeOf(await failure(call('orgs-acceptInvite', { inviteId, token: old.token })))).toBe('INVITE_INVALID');
  });

  it('only managers invite, only owners invite owners, and at most 50 are pending', async () => {
    await signInAs('newbie'); // a paralegal
    expect(codeOf(await failure(call('orgs-inviteMember', { email: emailFor('x'), role: 'lawyer' })))).toBe(
      'PERMISSION_DENIED',
    );
    await signInAs('inviter');
    const batch = db.batch();
    for (let i = 0; i < 50; i++) {
      batch.set(db.doc(`orgs/${orgId}/invites/bulk-${i}`), {
        email: `bulk-${i}-${RUN}@example.test`,
        role: 'readonly',
        tokenHash: `${i}`.padStart(64, '0'),
        status: 'pending',
        invitedBy: 'someone',
        expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
      });
    }
    await batch.commit();
    const error = await failure(call('orgs-inviteMember', { email: emailFor('one-too-many'), role: 'lawyer' }));
    expect(codeOf(error)).toBe('INVITE_LIMIT');
    await db.recursiveDelete(db.collection(`orgs/${orgId}/invites`));
  });
});

describe('members, the last owner, and claims', () => {
  let orgId: string;
  let ownerUid: string;
  let memberUid: string;

  beforeAll(async () => {
    ownerUid = await person('boss');
    memberUid = await person('staff');
    orgId = await createOrgAs('boss', 'Boss Fictional Lawyers');
    await inviteAndAccept('boss', 'staff', 'paralegal');
  });

  it('the last owner cannot be demoted, suspended or removed', async () => {
    await signInAs('boss');
    expect(codeOf(await failure(call('orgs-changeRole', { uid: ownerUid, role: 'admin' })))).toBe('LAST_OWNER');
    expect(codeOf(await failure(call('orgs-suspendMember', { uid: ownerUid })))).toBe('LAST_OWNER');
    expect(codeOf(await failure(call('orgs-removeMember', { uid: ownerUid })))).toBe('LAST_OWNER');
    expect((await db.doc(`orgs/${orgId}/members/${ownerUid}`).get()).get('role')).toBe('owner');
  });

  it('a role change updates the claims and bumps claimsVersion', async () => {
    const before = (await userDoc(memberUid))['claimsVersion'] as number;
    await signInAs('boss');
    await call('orgs-changeRole', { uid: memberUid, role: 'admin' });
    expect(await claimsOf(memberUid)).toMatchObject({ orgId, role: 'admin', orgs: { [orgId]: 'admin' } });
    expect((await userDoc(memberUid))['claimsVersion']).toBeGreaterThan(before);
    const audit = await db.collection(`orgs/${orgId}/audit`).where('action', '==', 'member.role_changed').get();
    expect(audit.docs[0]?.get('data')).toMatchObject({ from: 'paralegal', to: 'admin' });
  });

  it('an admin cannot make anyone an owner', async () => {
    await signInAs('staff');
    expect(codeOf(await failure(call('orgs-changeRole', { uid: memberUid, role: 'owner' })))).toBe('PERMISSION_DENIED');
  });

  it('transfers ownership to a member (recent sign-in), after which the old owner can be demoted', async () => {
    await signInAs('boss');
    await call('orgs-transferOwnership', { toUid: memberUid });
    expect(await claimsOf(memberUid)).toMatchObject({ role: 'owner' });
    expect(await claimsOf(ownerUid)).toMatchObject({ role: 'admin' });
  });

  it('suspending and reinstating', async () => {
    await signInAs('staff'); // now the owner
    await auth.currentUser?.getIdToken(true);
    await call('orgs-suspendMember', { uid: ownerUid });
    expect((await claimsOf(ownerUid))['orgId']).toBeUndefined();
    await call('orgs-suspendMember', { uid: ownerUid, suspended: false });
    expect(await claimsOf(ownerUid)).toMatchObject({ orgId, role: 'admin' });
  });

  it('removing a member whose active org this is revokes their tokens and clears the claims', async () => {
    const validBefore = (await adminAuth.getUser(ownerUid)).tokensValidAfterTime;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await signInAs('staff');
    const result = await call<{ tokensRevoked: boolean }>('orgs-removeMember', { uid: ownerUid });
    expect(result.tokensRevoked).toBe(true);
    const after = await adminAuth.getUser(ownerUid);
    expect(Date.parse(after.tokensValidAfterTime ?? '')).toBeGreaterThan(Date.parse(validBefore ?? ''));
    expect(after.customClaims?.['orgId']).toBeUndefined();
    expect((await db.doc(`orgs/${orgId}/members/${ownerUid}`).get()).get('status')).toBe('removed');
    expect(await userDoc(ownerUid)).toMatchObject({ activeOrgId: null, orgIds: [] });
  });

  it('removing yourself as the only owner is blocked', async () => {
    await signInAs('staff');
    expect(codeOf(await failure(call('orgs-removeMember', { uid: memberUid })))).toBe('LAST_OWNER');
  });
});

describe('orgs-switchActiveOrg', () => {
  it('switches between orgs the person belongs to, and refuses others', async () => {
    const uid = await person('hopper');
    await person('other-owner');
    const first = await createOrgAs('hopper', 'First Fictional Practice');
    const second = await createOrgAs('other-owner', 'Second Fictional Practice');
    await inviteAndAccept('other-owner', 'hopper', 'lawyer');
    expect(await claimsOf(uid)).toMatchObject({ orgId: second, orgs: { [first]: 'owner', [second]: 'lawyer' } });

    const result = await call<{ orgId: string; claimsVersion: number }>('orgs-switchActiveOrg', { orgId: first });
    expect(result.orgId).toBe(first);
    expect(await claimsOf(uid)).toMatchObject({ orgId: first, role: 'owner', orgName: 'First Fictional Practice' });
    expect((await userDoc(uid))['memberships']).toEqual({
      [first]: { role: 'owner', name: 'First Fictional Practice' },
      [second]: { role: 'lawyer', name: 'Second Fictional Practice' },
    });
    expect(codeOf(await failure(call('orgs-switchActiveOrg', { orgId: 'not-my-org' })))).toBe('MEMBER_INACTIVE');
  });
});

describe('auth-syncClaims', () => {
  it('recomputes claims when a member document changes outside the callables', async () => {
    const uid = await person('direct');
    const orgId = await createOrgAs('direct', 'Direct Fictional Legal');
    const version = (await userDoc(uid))['claimsVersion'] as number;
    // A second owner, written straight to Firestore (as a console edit or a migration would).
    const other = await person('direct-two');
    await db.doc(`orgs/${orgId}/members/${other}`).set({ role: 'lawyer', status: 'active', displayName: 'Direct Two' });
    const claims = await poll(async () => {
      const current = await claimsOf(other);
      return current['orgId'] === orgId ? current : undefined;
    });
    expect(claims).toMatchObject({ orgId, role: 'lawyer', orgs: { [orgId]: 'lawyer' } });
    expect((await userDoc(other))['claimsVersion']).toBe(1);

    await db.doc(`orgs/${orgId}/members/${other}`).update({ role: 'readonly' });
    expect(await poll(async () => ((await claimsOf(other))['role'] === 'readonly' ? true : undefined))).toBe(true);
    // The founder's own claims didn't change, so their version stays.
    expect((await userDoc(uid))['claimsVersion']).toBe(version);
  });
});
