import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { contactDerivedFields, type ContactReference, type FindDuplicatesResult, type Role } from '@materia/domain';

/**
 * CORE-01 through the emulators: the contacts callables with real claims, the contacts-onWrite
 * trigger, and a large merge finishing through the contacts-continueMerge Cloud Tasks queue.
 * All people, practices and matters are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-contacts';
const PASSWORD = 'fictional-password-c1';
const C = `orgs/${ORG}/contacts`;
const M = `orgs/${ORG}/matters`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

/** A person contact as the server would store it (derived fields included). */
function person(given: string, family: string, extra: Record<string, unknown> = {}) {
  const fields = {
    kind: 'person' as const,
    givenNames: given,
    familyName: family,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    ...extra,
  };
  return { ...meta, ...fields, ...contactDerivedFields(fields as never) };
}
const matter = (title: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  title,
  status: 'active',
  privileged: false,
  clientContactIds: ['c-bystander'],
  ...extra,
});
const party = (matterId: string, contactId: string, role: string) => ({
  ...meta,
  orgId: ORG,
  matterId,
  contactId,
  role,
});

async function createMember(who: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: `contacts-${who}`, email: `contacts-${who}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(`contacts-${who}`, { orgId: ORG, role: who });
  await db.doc(`orgs/${ORG}/members/contacts-${who}`).set({ role: who, status: 'active' });
}

async function signInAs(who: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `contacts-${who}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )(data).then((result) => result.data);
}

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'contacts-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(
    existing.users.filter((u) => u.uid.startsWith('contacts-')).map((u) => adminAuth.deleteUser(u.uid)),
  );
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Contacts Practice', retentionYears: 7 });
  for (const role of ['owner', 'lawyer', 'readonly'] as const) await createMember(role);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'contacts-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('contacts-create and contacts-onWrite', () => {
  it('creates a contact with its derived fields, and the trigger follows later edits', async () => {
    await signInAs('lawyer');
    const { contactId } = await call<{ contactId: string }>('contacts-create', {
      requestId: randomUUID(),
      contact: {
        kind: 'person',
        givenNames: 'Ada',
        familyName: 'Quill',
        phones: [{ type: 'mobile', number: '+61412345678' }],
        emails: [{ type: 'personal', address: 'ada.quill@example.test' }],
      },
    });
    const created = await data(`${C}/${contactId}`);
    expect(created).toMatchObject({
      sortName: 'ada quill',
      dedupeKey: 'person:ada quill|',
      createdBy: 'contacts-lawyer',
    });
    expect(created['search']).toEqual(expect.arrayContaining(['ad', 'ada', 'qu', 'quill', '0412345678']));

    // A client-style edit: the trigger recomputes the derived fields, without touching meta.
    await db.doc(`${C}/${contactId}`).update({ familyName: 'Quillfeather', updatedBy: 'contacts-lawyer' });
    const updated = await poll(
      () => data(`${C}/${contactId}`),
      (doc) => doc['sortName'] === 'ada quillfeather',
    );
    expect(updated['search']).toContain('quillfeath');
    expect(updated['dedupeKey']).toBe('person:ada quillfeather|');
    expect(updated['updatedBy']).toBe('contacts-lawyer');
  });

  it('fills the derived fields of a contact written without them (migration, console)', async () => {
    await db.doc(`${C}/c-raw`).set({ ...meta, kind: 'organisation', orgName: 'Harbourside Trustees Pty Ltd' });
    const doc = await poll(
      () => data(`${C}/c-raw`),
      (value) => typeof value['sortName'] === 'string',
    );
    expect(doc).toMatchObject({ sortName: 'harbourside trustees pty ltd', dedupeKey: 'org:harbourside trustees' });
    expect(doc['search']).toEqual(expect.arrayContaining(['ha', 'harboursid', 'tr', 'trustees']));
  });

  it('refuses readonly members', async () => {
    await signInAs('readonly');
    const error = await failure(
      call('contacts-create', { requestId: randomUUID(), contact: { kind: 'person', familyName: 'Nobody' } }),
    );
    expect(detailsOf(error)['code']).toBe('PERMISSION_DENIED');
  });
});

describe('contacts-findDuplicates', () => {
  beforeAll(async () => {
    const batch = db.batch();
    batch.set(
      db.doc(`${C}/dup-john`),
      person('John', 'Smith', {
        dateOfBirth: '1950-01-02',
        emails: [{ type: 'personal', address: 'john.smith@example.test' }],
      }),
    );
    batch.set(db.doc(`${C}/dup-jon`), person('Jon', 'Smyth', { dateOfBirth: '1950-01-02' }));
    batch.set(db.doc(`${C}/dup-jane`), person('Jane', 'Smith', { dateOfBirth: '1980-07-30' }));
    batch.set(db.doc(`${C}/dup-gone`), person('John', 'Smith', { dateOfBirth: '1950-01-02', deletedAt: new Date() }));
    batch.set(db.doc(`${C}/dup-tomb`), person('John', 'Smith', { mergedInto: 'dup-john', deletedAt: new Date() }));
    await batch.commit();
  });

  it('returns the near-duplicates of what was typed, best first', async () => {
    await signInAs('lawyer');
    const { matches } = await call<FindDuplicatesResult>('contacts-findDuplicates', {
      kind: 'person',
      givenNames: 'John',
      familyName: 'Smith',
      dateOfBirth: '1950-01-02',
    });
    expect(matches.map((m) => m.contactId)).toEqual(['dup-john', 'dup-jon']);
    expect(matches[0]).toMatchObject({ displayName: 'John Smith', email: 'john.smith@example.test' });
    const byEmail = await call<FindDuplicatesResult>('contacts-findDuplicates', {
      kind: 'person',
      givenNames: 'J',
      familyName: 'Smith',
      emails: ['JOHN.SMITH@example.test'],
    });
    expect(byEmail.matches[0]?.contactId).toBe('dup-john');
    expect(byEmail.matches[0]?.reasons).toContain('email');
  });
});

describe('contacts-merge', () => {
  beforeAll(async () => {
    const batch = db.batch();
    batch.set(db.doc(`${C}/c-bystander`), person('Bea', 'Stander'));
    batch.set(
      db.doc(`${C}/m-keep`),
      person('Harriet', 'Okafor', { phones: [{ type: 'mobile', number: '+61400000101' }] }),
    );
    batch.set(
      db.doc(`${C}/m-merge`),
      person('Harriet', 'Okafur', {
        dateOfBirth: '1961-04-05',
        phones: [
          { type: 'mobile', number: '+61400000101' },
          { type: 'home', number: '+61352220000' },
        ],
        isReferrer: true,
      }),
    );
    batch.set(
      db.doc(`${M}/mm-1`),
      matter('Estate of Fictional Okafor', {
        clientContactIds: ['m-merge', 'c-bystander', 'm-keep'],
        deceased: { contactId: 'm-merge', dateOfDeath: '2026-05-01', domicile: 'VIC', lastAddress: 'Highton VIC' },
      }),
    );
    batch.set(db.doc(`${M}/mm-2`), matter('Will of Fictional Okafor', { testator: { contactId: 'm-merge' } }));
    batch.set(db.doc(`${M}/mm-3`), matter('Referred matter', { referrerContactId: 'm-merge' }));
    batch.set(db.doc(`${M}/mm-1/parties/p-keep`), party('mm-1', 'm-keep', 'executor'));
    batch.set(db.doc(`${M}/mm-1/parties/p-merge`), party('mm-1', 'm-merge', 'beneficiary'));
    batch.set(db.doc(`orgs/${ORG}/safeCustody/sc-1`), {
      ...meta,
      testatorContactId: 'm-merge',
      packetNo: 'SC-0101',
      status: 'held',
    });
    await batch.commit();
  });

  it('is for owners and admins only', async () => {
    await signInAs('lawyer');
    const error = await failure(
      call('contacts-merge', { requestId: randomUUID(), keepId: 'm-keep', mergeId: 'm-merge' }),
    );
    expect(detailsOf(error)['code']).toBe('PERMISSION_DENIED');
  });

  it('re-points matters, parties (both roles kept), referrers and safe custody, and is audited', async () => {
    await signInAs('owner');
    const requestId = randomUUID();
    const result = await call('contacts-merge', { requestId, keepId: 'm-keep', mergeId: 'm-merge' });
    expect(result).toEqual({ repointed: 5, queued: false });
    // The same requestId replays the stored result.
    expect(await call('contacts-merge', { requestId, keepId: 'm-keep', mergeId: 'm-merge' })).toEqual(result);

    expect(await data(`${M}/mm-1`)).toMatchObject({
      clientContactIds: ['m-keep', 'c-bystander'],
      deceased: { contactId: 'm-keep' },
      updatedBy: 'contacts-owner',
    });
    expect(await data(`${M}/mm-2`)).toMatchObject({ testator: { contactId: 'm-keep' } });
    expect(await data(`${M}/mm-3`)).toMatchObject({ referrerContactId: 'm-keep' });
    expect(await data(`orgs/${ORG}/safeCustody/sc-1`)).toMatchObject({ testatorContactId: 'm-keep' });
    expect(await data(`${M}/mm-1/parties/p-keep`)).toMatchObject({ contactId: 'm-keep', role: 'executor' });
    const beneficiary = await data(`${M}/mm-1/parties/p-merge`);
    expect(beneficiary).toMatchObject({ contactId: 'm-keep', role: 'beneficiary' });
    expect(beneficiary['deletedAt']).toBeUndefined();

    const kept = await data(`${C}/m-keep`);
    expect(kept).toMatchObject({ dateOfBirth: '1961-04-05', isReferrer: true });
    expect((kept['phones'] as { number: string }[]).map((p) => p.number)).toEqual(['+61400000101', '+61352220000']);
    const tombstone = await data(`${C}/m-merge`);
    expect(tombstone['mergedInto']).toBe('m-keep');
    expect(tombstone['deletedAt']).toBeDefined();

    const audit = await db.collection(`orgs/${ORG}/audit`).where('requestId', '==', requestId).get();
    const merged = audit.docs.map((d) => d.data()).find((entry) => entry['action'] === 'contact.merged');
    expect(merged).toMatchObject({
      actor: { uid: 'contacts-owner' },
      entity: { path: `${C}/m-keep` },
      data: { keepId: 'm-keep', mergeId: 'm-merge', repointed: 5, queued: false },
    });
  });

  it('finishes a 600-reference merge through the Cloud Tasks queue', async () => {
    await db.doc(`${C}/big-keep`).set(person('Desmond', 'Featherstonehaugh'));
    await db.doc(`${C}/big-merge`).set(person('Desmond', 'Featherstonhaugh'));
    for (let chunk = 0; chunk < 3; chunk++) {
      const batch = db.batch();
      for (let i = chunk * 200; i < (chunk + 1) * 200; i++) {
        const matterId = `big-${String(Math.floor(i / 3)).padStart(3, '0')}`;
        batch.set(db.doc(`${M}/${matterId}/parties/bp-${i}`), party(matterId, 'big-merge', `role-${i % 3}`));
      }
      await batch.commit();
    }
    const remaining = async () =>
      (
        await db
          .collectionGroup('parties')
          .where('orgId', '==', ORG)
          .where('contactId', '==', 'big-merge')
          .count()
          .get()
      ).data().count;
    expect(await remaining()).toBe(600);

    await signInAs('owner');
    const result = await call('contacts-merge', { requestId: randomUUID(), keepId: 'big-keep', mergeId: 'big-merge' });
    expect(result).toEqual({ repointed: 200, queued: true });
    expect(await poll(remaining, (count) => count === 0, 120_000)).toBe(0);
    const kept = await db
      .collectionGroup('parties')
      .where('orgId', '==', ORG)
      .where('contactId', '==', 'big-keep')
      .count()
      .get();
    expect(kept.data().count).toBe(600);
  }, 180_000);
});

describe('contacts-delete', () => {
  beforeAll(async () => {
    const batch = db.batch();
    batch.set(db.doc(`${C}/d-used`), person('Linh', 'Tran'));
    batch.set(db.doc(`${C}/d-free`), person('Minh', 'Tran'));
    batch.set(db.doc(`${M}/dm-1`), matter('Estate of Fictional Tran', { clientContactIds: ['d-used'] }));
    batch.set(db.doc(`${M}/dm-2`), matter('Probate of Fictional Tran'));
    batch.set(db.doc(`${M}/dm-2/parties/dp-1`), party('dm-2', 'd-used', 'executor'));
    await batch.commit();
  });

  it('refuses while matters reference the contact, listing them', async () => {
    await signInAs('lawyer');
    const error = await failure(call('contacts-delete', { requestId: randomUUID(), contactId: 'd-used' }));
    expect(error.code).toBe('functions/failed-precondition');
    expect(detailsOf(error)).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'contact_referenced' });
    expect(detailsOf(error)['references'] as ContactReference[]).toEqual(
      expect.arrayContaining([
        { matterId: 'dm-1', matterTitle: 'Estate of Fictional Tran', role: 'client' },
        { matterId: 'dm-2', matterTitle: 'Probate of Fictional Tran', role: 'executor' },
      ]),
    );
    expect((await data(`${C}/d-used`))['deletedAt']).toBeUndefined();
  });

  it('soft deletes an unreferenced contact', async () => {
    await signInAs('lawyer');
    expect(await call('contacts-delete', { requestId: randomUUID(), contactId: 'd-free' })).toEqual({ deleted: true });
    expect(await data(`${C}/d-free`)).toMatchObject({ deletedBy: 'contacts-lawyer' });
  });
});
