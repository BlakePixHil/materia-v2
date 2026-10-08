import { createHash, randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { connectStorageEmulator, getStorage, ref, uploadBytes, type FirebaseStorage } from 'firebase/storage';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import {
  DOCUMENT_CALLABLES,
  DOWNLOAD_URL_TTL_SECONDS,
  pendingUploadPath,
  uploadSettings,
  type GetDownloadUrlResult,
  type Role,
  type StartZipResult,
} from '@materia/domain';

import { sampleEml, samplePdf } from '../../src/documents/testing';
import { EICAR_TEST_STRING, FAKE_SCANNER_TIMEOUT_MARKER } from '../../src/ports/fakes';

/**
 * CORE-12 through the emulators: client uploads to the pending area (Storage rules), the
 * documents-onUpload trigger with the fake scanner (clean, EICAR, timeout), magic bytes,
 * duplicates (one after the other and at the same moment), versions and restore, and download
 * URLs. Every person, matter and file is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = 'demo-materia.appspot.com';
const ORG = 'org-documents';
const MATTER_ID = 'm-documents';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const DOCS = `${MATTER}/documents`;
const PASSWORD = 'fictional-password-d12';

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let storage: FirebaseStorage;

type Data = Record<string, unknown>;

const uidOf = (role: Role) => `docs-${role}`;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
/** A unique fictional PDF (the label changes its hash). */
const pdf = (label: string) => bytes(`%PDF-1.7\n% fictional ${label} ${randomUUID()}\n%%EOF\n`);

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active' });
}

let signedIn: Role | undefined;
async function signInAs(role: Role) {
  if (signedIn === role) return;
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
  signedIn = role;
}

/** What the web app does: the bytes to `pending/{uploadId}` with the upload contract's metadata. */
async function upload(
  role: Role,
  data: Uint8Array,
  options: { fileName?: string; documentId?: string; uploadId?: string } = {},
): Promise<string> {
  await signInAs(role);
  const uploadId = options.uploadId ?? randomUUID();
  await uploadBytes(
    ref(storage, pendingUploadPath(ORG, MATTER_ID, uploadId)),
    data,
    uploadSettings({
      uid: uidOf(role),
      fileName: options.fileName ?? 'Fictional brief.pdf',
      sha256: sha256(data),
      ...(options.documentId ? { documentId: options.documentId } : {}),
    }),
  );
  return uploadId;
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const uploadStatus = (doc: Data) => (doc['upload'] as { status?: string } | undefined)?.status;
const versionsOf = (doc: Data) => (doc['versions'] as Data[] | undefined) ?? [];

/** Waits for the pipeline to finish with an upload (stored, or recorded as delayed, infected or rejected). */
const settled = (docId: string, uploadId: string) =>
  poll(
    () => data(`${DOCS}/${docId}`),
    (doc) =>
      versionsOf(doc).some((v) => v['uploadId'] === uploadId) ||
      ['delayed', 'infected', 'rejected'].includes(uploadStatus(doc) ?? ''),
  );

const pendingExists = async (uploadId: string) =>
  (
    await getAdminStorage(admin)
      .bucket(BUCKET)
      .file(pendingUploadPath(ORG, MATTER_ID, uploadId))
      .exists()
  )[0];

function callable<T>(name: string) {
  return (input: Data) =>
    httpsCallable<Data, T>(getFunctions(client, 'australia-southeast1'), name)(input).then((result) => result.data);
}
const getDownloadUrl = callable<GetDownloadUrlResult>(DOCUMENT_CALLABLES.getDownloadUrl);
const restoreVersion = callable<{ version: number; restoredFrom: number }>(DOCUMENT_CALLABLES.restoreVersion);
const resolveDuplicate = callable<Data>(DOCUMENT_CALLABLES.resolveDuplicate);
const startZip = callable<StartZipResult>(DOCUMENT_CALLABLES.startZip);
const saveAttachment = callable<{ uploadId: string; docId: string; fileName: string }>(
  DOCUMENT_CALLABLES.saveAttachment,
);

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: (error as FunctionsError).code, details: (error as FunctionsError).details as Data };
  }
  throw new Error('expected a failure');
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'documents-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('docs-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Documents Practice', timezone: 'Australia/Melbourne' });
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);
  await db.doc(MATTER).set({
    number: 'DC-2026-0001',
    title: 'Estate of Fictional Rowan',
    type: 'probate',
    status: 'active',
    privileged: false,
    openTaskCount: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
  });

  client = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'fake-api-key', authDomain: 'localhost', storageBucket: BUCKET },
    'documents-integration-client',
  );
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  storage = getStorage(client);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('documents-onUpload', () => {
  it('stores a clean PDF as version 1 with its page count, then clears the quarantine', async () => {
    const file = new Uint8Array(await samplePdf({ pages: 3 }));
    const uploadId = await upload('paralegal', file);
    const doc = await settled(uploadId, uploadId);
    expect(doc).toMatchObject({
      name: 'Fictional brief.pdf',
      version: 1,
      sha256: sha256(file),
      sizeBytes: file.length,
      mime: 'application/pdf',
      pageCount: 3,
      encrypted: false,
      scan: { status: 'clean' },
      ingest: { status: 'pending' },
      createdBy: uidOf('paralegal'),
    });
    expect(doc['upload']).toBeUndefined();
    expect(await pendingExists(uploadId)).toBe(false);
    const [stored] = await getAdminStorage(admin).bucket(BUCKET).file(`${DOCS}/${uploadId}/v1`).download();
    expect(sha256(stored)).toBe(sha256(file));
  });

  it('marks a password-protected PDF encrypted', async () => {
    const uploadId = await upload('lawyer', new Uint8Array(await samplePdf({ pages: 2, encrypted: true })));
    expect(await settled(uploadId, uploadId)).toMatchObject({ encrypted: true, scan: { status: 'clean' } });
  });

  it('deletes an infected file (EICAR), records it and notifies the uploader and admins', async () => {
    const uploadId = await upload('paralegal', bytes(`${EICAR_TEST_STRING}\n`), { fileName: 'Fictional notes.txt' });
    const doc = await settled(uploadId, uploadId);
    expect(doc).toMatchObject({ scan: { status: 'infected' }, upload: { status: 'infected' }, version: 0 });
    expect(await pendingExists(uploadId)).toBe(false);
    const notifications = await poll(
      async () => (await db.collection(`orgs/${ORG}/notifications`).where('documentId', '==', uploadId).get()).docs,
      (docs) => docs.length >= 2,
    );
    expect(notifications.map((n) => n.get('recipientUid')).sort()).toEqual([uidOf('owner'), uidOf('paralegal')]);
    expect(notifications[0]?.data()).toMatchObject({ kind: 'document_infected', priority: 'high' });
  });

  it('keeps the file quarantined with "Scanning delayed" when the scanner times out', async () => {
    const uploadId = await upload('lawyer', bytes(`${FAKE_SCANNER_TIMEOUT_MARKER} fictional`), {
      fileName: 'Slow file.txt',
    });
    const doc = await settled(uploadId, uploadId);
    expect(doc).toMatchObject({ scan: { status: 'pending' }, upload: { status: 'delayed', attempts: 1 } });
    expect(await pendingExists(uploadId)).toBe(true);
    // Not downloadable while quarantined.
    await signInAs('lawyer');
    expect(await failure(getDownloadUrl({ matterId: MATTER_ID, docId: uploadId }))).toMatchObject({
      code: 'functions/failed-precondition',
    });
  });

  it('rejects a file whose bytes are not its type (magic bytes)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const uploadId = await upload('lawyer', png, { fileName: 'Not really.pdf' });
    expect(await settled(uploadId, uploadId)).toMatchObject({
      scan: { status: 'error' },
      upload: { status: 'rejected', reason: 'type_mismatch' },
    });
    expect(await pendingExists(uploadId)).toBe(false);
  });
});

describe('duplicates', () => {
  it('marks a second upload of the same file duplicateOf the first; discard removes it', async () => {
    const file = pdf('duplicate');
    const first = await upload('lawyer', file);
    await settled(first, first);
    const second = await upload('paralegal', file, { fileName: 'Copy of brief.pdf' });
    expect(await settled(second, second)).toMatchObject({ duplicateOf: first, scan: { status: 'clean' } });
    expect((await data(`${MATTER}/documentHashes/${sha256(file)}`))['documentId']).toBe(first);

    await signInAs('paralegal');
    await resolveDuplicate({ requestId: randomUUID(), matterId: MATTER_ID, docId: second, action: 'discard' });
    const discarded = await data(`${DOCS}/${second}`);
    expect(discarded['deletedAt']).toBeTruthy();
    expect(discarded['duplicateOf']).toBeUndefined();
  });

  it('two uploads of the same file at the same moment: exactly one is the original', async () => {
    const file = pdf('concurrent');
    const [a, b] = await Promise.all([
      upload('lawyer', file, { uploadId: randomUUID() }),
      upload('lawyer', file, { uploadId: randomUUID(), fileName: 'Same brief.pdf' }),
    ]);
    const [docA, docB] = await Promise.all([settled(a as string, a as string), settled(b as string, b as string)]);
    const marks = [docA['duplicateOf'], docB['duplicateOf']];
    expect(marks.filter(Boolean)).toHaveLength(1);
    const original = docA['duplicateOf'] ? b : a;
    expect(marks).toContain(original);
    expect((await data(`${MATTER}/documentHashes/${sha256(file)}`))['documentId']).toBe(original);
  });
});

describe('versions and downloads', () => {
  it('adds versions through the same pipeline, restores one and signs 5-minute download URLs', async () => {
    const v1 = pdf('version one');
    const docId = await upload('lawyer', v1, { fileName: 'Draft will.pdf' });
    await settled(docId, docId);
    const v2 = pdf('version two');
    const next = await upload('paralegal', v2, { fileName: 'Draft will v2.pdf', documentId: docId });
    const updated = await settled(docId, next);
    expect(updated).toMatchObject({ version: 2, sha256: sha256(v2), name: 'Draft will.pdf' });
    expect(versionsOf(updated).map((v) => [v['version'], v['fileName']])).toEqual([
      [1, 'Draft will.pdf'],
      [2, 'Draft will v2.pdf'],
    ]);
    // A new version doesn't create a document of its own.
    expect((await db.doc(`${DOCS}/${next}`).get()).exists).toBe(false);

    await signInAs('lawyer');
    expect(await restoreVersion({ requestId: randomUUID(), matterId: MATTER_ID, docId, version: 1 })).toEqual({
      version: 3,
      restoredFrom: 1,
    });
    const restored = await data(`${DOCS}/${docId}`);
    expect(restored).toMatchObject({ version: 3, sha256: sha256(v1) });
    expect(versionsOf(restored).at(-1)).toMatchObject({ version: 3, restoredFrom: 1 });

    const before = Date.now();
    const result = await getDownloadUrl({ matterId: MATTER_ID, docId, version: 2 });
    expect(result).toMatchObject({ version: 2, fileName: 'Draft will.pdf' });
    const expiresIn = new Date(result.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan((DOWNLOAD_URL_TTL_SECONDS - 30) * 1000);
    expect(expiresIn).toBeLessThanOrEqual((DOWNLOAD_URL_TTL_SECONDS + 5) * 1000);
    const url = new URL(result.url);
    expect(url.searchParams.get('X-Goog-Expires')).toBe(String(DOWNLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="Draft will.pdf"/);
    const response = await fetch(result.url);
    expect(response.status).toBe(200);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(v2));
  });

  it('signs a URL that opens when two first signings at once left the file two download tokens', async () => {
    const original = pdf('two tokens');
    const docId = await upload('lawyer', original, { fileName: 'Scan.pdf' });
    const doc = await settled(docId, docId);
    const path = String(versionsOf(doc)[0]?.['storagePath']);
    // What two signings at the same moment leave: the emulator keeps both tokens as "a,b".
    const file = getAdminStorage(admin).bucket(BUCKET).file(path);
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } });
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } });

    await signInAs('lawyer');
    const { url } = await getDownloadUrl({ matterId: MATTER_ID, docId });
    expect(new URL(url).searchParams.get('token')).not.toContain(',');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(original));
  });

  it('privileged documents are hidden from readonly', async () => {
    const docId = await upload('lawyer', pdf('privileged'), { fileName: 'Advice.pdf' });
    await settled(docId, docId);
    await db.doc(`${DOCS}/${docId}`).update({ privileged: true });
    await signInAs('readonly');
    expect(await failure(getDownloadUrl({ matterId: MATTER_ID, docId }))).toMatchObject({
      code: 'functions/not-found',
    });
    await signInAs('lawyer');
    await expect(getDownloadUrl({ matterId: MATTER_ID, docId })).resolves.toMatchObject({ version: 1 });
  });
});

describe('zip downloads', () => {
  it('starts a zip export job, leaving out privileged documents the role can’t see', async () => {
    const will = await upload('lawyer', pdf('zip will'), { fileName: 'Will.pdf' });
    const advice = await upload('lawyer', pdf('zip advice'), { fileName: 'Advice.pdf' });
    await settled(will, will);
    await settled(advice, advice);
    await db.doc(`${DOCS}/${advice}`).update({ privileged: true });

    await signInAs('readonly');
    const partial = await startZip({ requestId: randomUUID(), matterId: MATTER_ID, docIds: [will, advice] });
    expect(partial).toMatchObject({ included: 1, skipped: 1 });
    expect(await data(`orgs/${ORG}/jobs/${partial.jobId}`)).toMatchObject({
      type: 'documents.zip',
      status: 'queued',
      createdBy: uidOf('readonly'),
      target: { kind: 'export', name: 'Documents DC-2026-0001' },
      input: { inputs: [{ storagePath: `${DOCS}/${will}/v1`, fileName: 'Will.pdf' }] },
    });
    expect(await failure(startZip({ requestId: randomUUID(), matterId: MATTER_ID, docIds: [advice] }))).toMatchObject({
      code: 'functions/failed-precondition',
      details: { reason: 'nothing_to_zip' },
    });

    await signInAs('lawyer');
    const full = await startZip({ requestId: randomUUID(), matterId: MATTER_ID, docIds: [will, advice] });
    expect(full).toMatchObject({ included: 2, skipped: 0 });
  });
});

describe('email documents', () => {
  it('parses an .eml into a message rendition and saves an attachment through the pipeline', async () => {
    const docId = await upload('lawyer', new Uint8Array(sampleEml()), { fileName: 'Valuation letter.eml' });
    await settled(docId, docId);
    const doc = await poll(
      () => data(`${DOCS}/${docId}`),
      (d) => !!(d['renditions'] as Data | undefined)?.['message'],
    );
    expect(doc).toMatchObject({ mime: 'message/rfc822', scan: { status: 'clean' } });

    await signInAs('lawyer');
    const rendition = await getDownloadUrl({ matterId: MATTER_ID, docId, rendition: 'message' });
    const message = (await (await fetch(rendition.url)).json()) as Data;
    expect(message).toMatchObject({
      format: 'message.v1',
      subject: 'Fictional valuation letter',
      attachments: [{ index: 0, fileName: 'Inventory of assets.txt', savable: true }],
    });

    const saved = await saveAttachment({ requestId: randomUUID(), matterId: MATTER_ID, docId, attachmentIndex: 0 });
    const attachment = await settled(saved.docId, saved.uploadId);
    expect(attachment).toMatchObject({
      name: 'Inventory of assets.txt',
      category: 'correspondence',
      mime: 'text/plain',
      scan: { status: 'clean' },
      createdBy: uidOf('lawyer'),
    });
  });
});
