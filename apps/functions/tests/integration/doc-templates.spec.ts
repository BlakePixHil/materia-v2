import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { HttpsError } from 'firebase-functions/v2/https';

import type { GenerateDocumentResult, Role, SaveDocTemplateResult } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { cachedMemberLookup } from '../../src/core/members';
import { generateDefinition } from '../../src/docs/generate';
import { systemTemplateDocx } from '../../src/docs/system-templates';
import { publishTemplateDefinition, saveLetterheadDefinition, saveTemplateDefinition } from '../../src/docs/templates';
import { docxText, docxWith } from '../../src/docs/testing';
import { storageFiles } from '../../src/documents/files';
import { fakePorts } from '../../src/ports/fakes';

/**
 * INT-06 against the emulators' Firestore and Storage: an owner saves the letterhead details,
 * uploads a .docx template (a bad tag is refused by name) and publishes it, and a lawyer generates
 * documents from it and from a built-in template; each lands in the matter's documents with its
 * merged .docx in Storage, and the missing fields are listed. Members read templates; nobody writes
 * them directly. The docs-* callables' own pipelines (claims, role, membership, idempotency) run in
 * this process, so the shard's Functions emulator starts no workers for them. Fictional only.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ORG = 'org-doc-templates';
const PASSWORD = 'fictional-password-int6';
const MATTER_ID = 'm-docs';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `int6-${role}`;
const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

async function createMember(role: Role, displayName: string, title: string) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({
    role,
    status: 'active',
    displayName,
    title,
    email: `${uidOf(role)}@example.test`,
    defaultRateCents: 45_000,
    rates: [],
  });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(definition: unknown, role: Role, data: Record<string, unknown>): Promise<T> {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts(),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    definition as CallableDefinition<never, T>,
    { data: { requestId: randomUUID(), ...data }, auth: { uid: uidOf(role), token: { orgId: ORG, role } } },
    deps,
  );
}
const files = () => storageFiles(BUCKET);
const saveLetterhead = (data: Record<string, unknown>) =>
  call<{ saved: true }>(saveLetterheadDefinition, 'owner', data);
const saveTemplate = (data: Record<string, unknown>) =>
  call<SaveDocTemplateResult>(saveTemplateDefinition(files), 'owner', data);
const publishTemplate = (data: Record<string, unknown>) =>
  call<{ templateId: string }>(publishTemplateDefinition, 'owner', data);
const generate = (data: Record<string, unknown>) =>
  call<GenerateDocumentResult>(generateDefinition(files), 'lawyer', data);

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

const upload = (data: Buffer, fileName: string) => ({ fileName, contentBase64: data.toString('base64') });

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'doc-templates-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('int6-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db
    .doc(`orgs/${ORG}`)
    .set({ name: 'Harbour & Vine Legal', abn: '00000000001', timezone: 'Australia/Melbourne' });
  await createMember('owner', 'Alex Morgan', 'Principal');
  await createMember('lawyer', 'Jordan Price', 'Senior Associate');
  await db.doc(`orgs/${ORG}/contacts/c-catherine`).set({
    kind: 'person',
    givenNames: 'Catherine',
    familyName: 'Doyle',
    emails: [],
    phones: [],
    addresses: [
      {
        type: 'residential',
        line1: '11 Example Street',
        suburb: 'Newtown',
        state: 'VIC',
        postcode: '3220',
        country: 'AU',
      },
    ],
    deletedAt: null,
    ...meta,
  });
  await db.doc(MATTER).set({
    number: 'HV-2026-0101',
    title: 'Estate of Margaret Doyle',
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    privileged: false,
    clientContactIds: ['c-catherine'],
    responsibleUid: uidOf('lawyer'),
    fee: { arrangement: 'fixed', amountCents: 440_000, history: [] },
    deletedAt: null,
    ...meta,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'doc-templates-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('document templates and docx merge', () => {
  let templateId = '';

  it('saves the letterhead and an uploaded template, refusing a bad tag by name', async () => {
    await saveLetterhead({ address: 'Level 2, 10 Example Street\nGeelong VIC 3220', phone: '(03) 5200 0000' });
    expect((await db.doc(`orgs/${ORG}/settings/letterhead`).get()).data()).toMatchObject({
      address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
      phone: '(03) 5200 0000',
    });

    const bad = await failure(
      saveTemplate({
        name: 'Broken',
        kind: 'letter',
        file: upload(docxWith(['Dear {client.fullname}']), 'Broken.docx'),
      }),
    );
    expect(bad.code).toBe('invalid-argument');
    expect(bad.details).toMatchObject({
      reason: 'template_invalid',
      problems: [
        expect.objectContaining({ message: '{client.fullname} isn’t a field. Did you mean {client.fullName}?' }),
      ],
    });

    // The built-in letter, uploaded as the firm's own and offered in its place.
    const saved = await saveTemplate({
      name: 'Engagement letter',
      kind: 'letter',
      replaces: 'system-letter',
      file: upload(systemTemplateDocx('system-letter').data, 'Engagement letter.docx'),
    });
    templateId = saved.templateId;
    expect(saved).toMatchObject({ version: 1, warnings: [] });
    expect(saved.fields).toEqual(expect.arrayContaining(['client.firstName', 'body', 'firm.name']));
    const stored = (await db.doc(`orgs/${ORG}/docTemplates/${templateId}`).get()).data();
    expect(stored).toMatchObject({ published: false, version: 1, replaces: 'system-letter' });
    const [exists] = await getStorage(admin).bucket().file(`orgs/${ORG}/docTemplates/${templateId}/v1.docx`).exists();
    expect(exists).toBe(true);
  });

  it('generates only once the template is published, then saves it to the matter', async () => {
    const early = await failure(generate({ templateId, matterId: MATTER_ID }));
    expect(early.details).toMatchObject({ reason: 'template_unpublished' });

    await publishTemplate({ templateId, version: 1 });
    const result = await generate({
      templateId,
      matterId: MATTER_ID,
      data: { body: 'Thank you for your **instructions**.' },
    });
    expect(result.missing).toEqual([]);
    const record = (await db.doc(`${MATTER}/documents/${result.documentId}`).get()).data();
    expect(record).toMatchObject({
      category: 'correspondence',
      source: 'generated',
      version: 1,
      scan: { status: 'clean' },
      generatedFrom: { templateId, version: 1 },
      createdBy: uidOf('lawyer'),
    });
    const [file] = await getStorage(admin).bucket().file(String(record?.['storagePath'])).download();
    const text = docxText(file);
    expect(text).toContain('Dear Catherine');
    expect(text).toContain('Thank you for your instructions.');
    expect(text).toContain('Jordan Price');
    expect(docxText(file, 'word/header1.xml')).toContain('Harbour & Vine Legal');
    // A member reads the generated document like any other.
    await signInAs('lawyer');
    expect((await getDoc(doc(firestore, `${MATTER}/documents/${result.documentId}`))).exists()).toBe(true);
  });

  it('lists the fields with no value and marks them in the document', async () => {
    await db.doc(`orgs/${ORG}/contacts/c-catherine`).update({ addresses: [] });
    const letter = await generate({ templateId, matterId: MATTER_ID, data: { body: 'A short note.' } });
    expect(letter.missing).toEqual(['client.address']);
    const record = (await db.doc(`${MATTER}/documents/${letter.documentId}`).get()).data();
    const [file] = await getStorage(admin).bucket().file(String(record?.['storagePath'])).download();
    expect(docxText(file)).toContain('[[missing: client.address]]');
  });

  it('files a built-in costs disclosure under its tag, with the fixed fee as the estimate', async () => {
    const disclosure = await generate({ templateId: 'system-costs-disclosure', matterId: MATTER_ID });
    expect(disclosure.missing).toEqual([]);
    const record = (await db.doc(`${MATTER}/documents/${disclosure.documentId}`).get()).data();
    expect(record).toMatchObject({
      category: 'correspondence',
      tags: ['costs-disclosure'],
      generatedFrom: { templateId: 'system-costs-disclosure' },
    });
    const [file] = await getStorage(admin).bucket().file(String(record?.['storagePath'])).download();
    expect(docxText(file)).toContain('the fixed fee of $4,400.00');
  });

  it('lets members read templates and the letterhead, and nobody write a template directly', async () => {
    await signInAs('lawyer');
    expect((await getDoc(doc(firestore, `orgs/${ORG}/docTemplates/${templateId}`))).exists()).toBe(true);
    expect((await getDoc(doc(firestore, `orgs/${ORG}/settings/letterhead`))).exists()).toBe(true);
    await signInAs('owner');
    await expect(
      updateDoc(doc(firestore, `orgs/${ORG}/docTemplates/${templateId}`), { published: false }),
    ).rejects.toThrow();
  });
});
