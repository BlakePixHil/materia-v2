import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { HttpsError } from 'firebase-functions/v2/https';

import {
  CLERK_DISCLOSURE_VERSION,
  partyDocId,
  type Role,
  type SaveClerkDraftResult,
  type StartClerkDraftResult,
} from '@materia/domain';

import { DRAFT_QUEUE, draftRunDeps, saveDraftDefinition, startDraftDefinition } from '../../src/clerk/drafts/callables';
import { runDraft, type DraftRunTask } from '../../src/clerk/drafts/run';
import { anthropicKeyPath } from '../../src/clerk/keyring';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import { docxText } from '../../src/docs/testing';
import { storageFiles } from '../../src/documents/files';
import { FakeKms, FakeTaskQueue, fakePorts } from '../../src/ports/fakes';

/**
 * AI-10 against the emulators' Firestore and Storage, with the fake Clerk model: a lawyer starts a
 * letter to the executor, Clerk drafts it server-side with a placeholder for a missing fact, the
 * lawyer edits it through the security rules, and saving merges it into the firm's letterhead and
 * files it in the matter's documents as a Clerk draft, with the authorship in the audit trail and
 * nothing sent. The callables and the queue handler run in this process. Fictional only.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ORG = 'org-clerk-drafts';
const PASSWORD = 'fictional-password-ai10';
const MATTER_ID = 'm-drafts';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const ORG_KEY = 'sk-ant-api03-fictional-drafts-key-0000';
const kms = new FakeKms();
const log = createLog({ fn: 'clerk-drafts-integration' }, () => undefined);

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `ai10-${role}`;
const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

async function createMember(role: Role, displayName: string) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({
    role,
    status: 'active',
    displayName,
    title: 'Senior Associate',
    email: `${uidOf(role)}@example.test`,
  });
}

const tasks = new FakeTaskQueue();
function call<T>(definition: unknown, role: Role, data: Record<string, unknown>): Promise<T> {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts({ clerkKms: kms, tasks }),
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

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as HttpsError & { details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'clerk-drafts-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('ai10-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  // Clerk and drafting are on, and an admin has acknowledged the disclosure (AI-13).
  await db.doc(`orgs/${ORG}`).set({
    name: 'Harbour & Vine Legal',
    abn: '00000000001',
    timezone: 'Australia/Melbourne',
    flags: { 'clerk.enabled': true, 'clerk.features.drafting': true },
    settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION } },
  });
  const sealed = await kms.encrypt(ORG_KEY, anthropicKeyPath(ORG));
  await db.doc(anthropicKeyPath(ORG)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: ORG_KEY.slice(-4),
    opusAvailable: true,
  });
  await db.doc(`orgs/${ORG}/settings/letterhead`).set({
    address: 'Level 2, 10 Example Street\nGeelong VIC 3220',
    phone: '(03) 5200 0000',
    ...meta,
  });
  await createMember('lawyer', 'Jordan Price');
  const contact = (id: string, givenNames: string, familyName: string, extra: Record<string, unknown> = {}) =>
    db.doc(`orgs/${ORG}/contacts/${id}`).set({
      kind: 'person',
      givenNames,
      familyName,
      emails: [],
      phones: [],
      addresses: [],
      deletedAt: null,
      ...meta,
      ...extra,
    });
  await contact('c-catherine', 'Catherine', 'Doyle', {
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
  });
  await contact('c-margaret', 'Margaret', 'Doyle', { dateOfDeath: '2026-07-22' });
  await db.doc(MATTER).set({
    number: 'HV-2026-0110',
    title: 'Estate of Margaret Doyle',
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    privileged: false,
    clientContactIds: ['c-catherine'],
    responsibleUid: uidOf('lawyer'),
    deceased: { contactId: 'c-margaret', dateOfDeath: '2026-07-22' },
    fee: { arrangement: 'fixed', amountCents: 440_000, history: [] },
    deletedAt: null,
    ...meta,
  });
  const party = (role: string, contactId: string) =>
    db.doc(`${MATTER}/parties/${partyDocId(role as never, contactId)}`).set({
      contactId,
      role,
      orgId: ORG,
      matterId: MATTER_ID,
      addedFrom: 'manual',
      deletedAt: null,
      ...meta,
    });
  await party('executor', 'c-catherine');
  await party('deceased', 'c-margaret');

  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'clerk-drafts-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
});

afterAll(async () => {
  setRemoteFlagLoader();
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('Clerk drafting (AI-10)', () => {
  it('drafts a letter server-side, takes the lawyer’s edits and files it on the letterhead, never sent', async () => {
    const executor = partyDocId('executor', 'c-catherine');
    const { draftId } = await call<StartClerkDraftResult>(startDraftDefinition, 'lawyer', {
      matterId: MATTER_ID,
      typeId: 'costs-disclosure-cover',
      recipients: [{ partyId: executor }],
      instructions: 'Ask her to sign and return the costs agreement.',
    });
    const ref = db.doc(`${MATTER}/clerkDrafts/${draftId}`);
    const started = (await ref.get()).data();
    expect(started).toMatchObject({
      status: 'drafting',
      ownerUid: uidOf('lawyer'),
      recipients: [
        expect.objectContaining({
          partyId: executor,
          name: 'Catherine Doyle',
          address: expect.stringContaining('11 Example Street'),
        }),
      ],
    });
    const queued = tasks.queued.filter((task) => task.queue === DRAFT_QUEUE);
    expect(queued).toHaveLength(1);

    // The queue: Clerk drafts it with the fake model.
    const outcome = await runDraft(
      draftRunDeps(db, fakePorts({ clerkModel: new FakeClerkModel(), clerkKms: kms }), log),
      queued[0]?.payload as unknown as DraftRunTask,
    );
    expect(outcome).toBe('drafted');
    const drafted = (await ref.get()).data() as Record<string, unknown>;
    const body = String(drafted['bodyMd']);
    expect(drafted).toMatchObject({ status: 'ready', promptId: 'drafting@1.0.0', missingFacts: [], privileged: false });
    expect(body).toContain('[[TO CONFIRM:');
    expect(drafted['provenance']).toEqual([{ origin: 'clerk', length: body.length }]);
    expect(drafted['generatedMd']).toBe(body);

    // The lawyer edits it through the rules: the body and provenance only.
    await signOut(auth);
    await signInWithEmailAndPassword(auth, `${uidOf('lawyer')}@example.test`, PASSWORD);
    const edited = `${body}\n\nPlease call me with any questions.`;
    const added = edited.length - body.length;
    const stamp = { updatedAt: serverTimestamp(), updatedBy: uidOf('lawyer') };
    await updateDoc(doc(firestore, `${MATTER}/clerkDrafts/${draftId}`), {
      bodyMd: edited,
      provenance: [
        { origin: 'clerk', length: body.length },
        { origin: 'person', length: added },
      ],
      ...stamp,
    });
    await expect(
      updateDoc(doc(firestore, `${MATTER}/clerkDrafts/${draftId}`), { status: 'saved', ...stamp }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const saved = await call<SaveClerkDraftResult>(
      saveDraftDefinition(() => storageFiles(BUCKET)),
      'lawyer',
      {
        matterId: MATTER_ID,
        draftId,
        bodyMd: edited,
        provenance: [
          { origin: 'clerk', length: body.length },
          { origin: 'person', length: added },
        ],
      },
    );
    expect(saved.toConfirm).toBeGreaterThan(0);
    const record = (await db.doc(`${MATTER}/documents/${saved.documentId}`).get()).data();
    expect(record).toMatchObject({
      source: 'clerk_draft',
      category: 'correspondence',
      privileged: false,
      scan: { status: 'clean' },
      generatedFrom: { templateId: 'system-letterhead' },
      createdBy: uidOf('lawyer'),
    });
    expect(record?.['tags']).toContain('clerk-draft');
    const [file] = await getStorage(admin).bucket().file(String(record?.['storagePath'])).download();
    const text = docxText(file);
    expect(text).toContain('Catherine Doyle');
    expect(text).toContain('11 Example Street');
    expect(text).toContain('Please call me with any questions.');
    expect(text).toContain('[[TO CONFIRM:');
    expect(text).toContain('Jordan Price');
    // Who wrote what is kept for audit, never printed.
    expect(text).not.toMatch(/provenance|origin/i);
    expect(docxText(file, 'word/header1.xml')).toContain('Harbour & Vine Legal');

    expect((await ref.get()).data()).toMatchObject({ status: 'saved', documentIds: [saved.documentId] });
    const entries = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'clerk.draft_saved').get();
    expect(entries.docs.map((entry) => entry.get('data'))).toEqual([
      expect.objectContaining({
        typeId: 'costs-disclosure-cover',
        documentId: saved.documentId,
        clerkChars: body.length,
        personChars: added,
      }),
    ]);
    // The lawyer reads the filed letter like any other document.
    expect((await getDoc(doc(firestore, `${MATTER}/documents/${saved.documentId}`))).exists()).toBe(true);
  });

  it('refuses a letter type that doesn’t fit the matter, and drafting while it’s off', async () => {
    const wrongType = await failure(
      call(startDraftDefinition, 'lawyer', { matterId: MATTER_ID, typeId: 'fp-letter-of-demand', recipients: [] }),
    );
    expect(wrongType.details).toMatchObject({ reason: 'draft_type' });

    const drafting = new FieldPath('flags', 'clerk.features.drafting');
    await db.doc(`orgs/${ORG}`).update(drafting, false);
    clearFlagCaches();
    try {
      const off = await failure(
        call(startDraftDefinition, 'lawyer', { matterId: MATTER_ID, typeId: 'client-update', recipients: [] }),
      );
      expect(off.details).toMatchObject({ code: 'CLERK_DISABLED' });
    } finally {
      await db.doc(`orgs/${ORG}`).update(drafting, true);
      clearFlagCaches();
    }
  });
});
