import { readFileSync } from 'node:fs';
import path from 'node:path';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import { documentVersionPath } from '@materia/domain';

import { chunkSearch } from '../../src/documents/ingest/search';
import { fakeEmbedding } from '../../src/ports/fakes';

/**
 * AI-04 through the emulators: a clean document version queues `documents-ingest` (trigger →
 * Cloud Tasks), which extracts, chunks and embeds it (fake embeddings); Firestore vector search
 * finds its chunks with the org, matter and privileged pre-filters; a privileged change reaches
 * every chunk; removing the document deletes them. Every name and document is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = 'demo-materia.appspot.com';
const ORG = 'org-ingest';
const MATTER_ID = 'm-ingest';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const WILL = readFileSync(path.resolve(__dirname, '../../../../libs/test-utils/fixtures/pdfs/will.pdf'));

let admin: App;
let db: Firestore;

type Data = Record<string, unknown>;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const docPath = (docId: string) => `${MATTER}/documents/${docId}`;
const docData = async (docId: string) => (await db.doc(docPath(docId)).get()).data() ?? {};
const chunks = async (docId: string) =>
  (await db.collection(`${docPath(docId)}/chunks`).get()).docs.map((d) => d.data() as Data);
const ingestStatus = (doc: Data) => (doc['ingest'] as { status?: string } | undefined)?.status;

/** What documents-onUpload leaves behind for a clean upload: the stored bytes and the document. */
async function storeCleanVersion(docId: string, fileName: string, data: Buffer) {
  const storagePath = documentVersionPath(ORG, MATTER_ID, docId, 1);
  await getAdminStorage(admin).bucket(BUCKET).file(storagePath).save(data, { contentType: 'application/pdf' });
  const at = FieldValue.serverTimestamp();
  await db.doc(docPath(docId)).set({
    orgId: ORG,
    matterId: MATTER_ID,
    name: fileName,
    category: 'other',
    privileged: false,
    tags: [],
    version: 1,
    versionSeq: 1,
    storagePath,
    mime: 'application/pdf',
    sizeBytes: data.length,
    sha256: 'b'.repeat(64),
    versions: [
      {
        version: 1,
        storagePath,
        fileName,
        mime: 'application/pdf',
        sizeBytes: data.length,
        sha256: 'b'.repeat(64),
        uploadedAt: new Date(),
        uploadedBy: 'ingest-lawyer',
      },
    ],
    scan: { status: 'clean' },
    ingest: { status: 'pending' },
    source: 'upload',
    encrypted: false,
    accessRestricted: false,
    deletedAt: null,
    createdAt: at,
    createdBy: 'ingest-lawyer',
    updatedAt: at,
    updatedBy: 'ingest-lawyer',
    schemaVersion: 1,
  });
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'ingest-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Ingest Practice', timezone: 'Australia/Melbourne' });
  await db.doc(MATTER).set({ title: 'Estate of Fictional Margaret', privileged: false, deletedAt: null });
});

afterAll(async () => {
  await deleteAdminApp(admin);
});

describe('documents-ingest', () => {
  it('ingests a clean PDF, finds it by vector search, follows the privileged flag and deletes with the document', async () => {
    await storeCleanVersion('d-will', 'Will.pdf', WILL);
    const done = await poll(
      () => docData('d-will'),
      (doc) => ['done', 'skipped', 'failed'].includes(ingestStatus(doc) ?? ''),
    );
    expect(done['ingest']).toMatchObject({ status: 'done', version: 1, pages: 2, chunks: 2 });
    const stored = await chunks('d-will');
    expect(stored.map((c) => c['page'])).toEqual([1, 2]);
    expect(stored[0]).toMatchObject({ orgId: ORG, matterId: MATTER_ID, docVersion: 1, privileged: false });

    // Vector search in the emulator, with the same fake embeddings the functions used.
    const search = chunkSearch({ db, embedding: fakeEmbedding });
    const hits = await search.searchChunks({
      orgId: ORG,
      matterId: MATTER_ID,
      query: 'Who are the executors and trustees?',
      k: 5,
      allowPrivileged: false,
    });
    expect(hits[0]).toMatchObject({ documentId: 'd-will', version: 1, page: 1 });
    expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? 2);

    // Privileged: every chunk follows, and searches without privileged access skip them.
    await db.doc(docPath('d-will')).update({ privileged: true });
    const privileged = await poll(
      () => chunks('d-will'),
      (all) => all.every((c) => c['privileged'] === true),
    );
    expect(privileged.map((c) => c['privileged'])).toEqual([true, true]);
    expect(
      await search.searchChunks({ orgId: ORG, matterId: MATTER_ID, query: 'executors', allowPrivileged: false }),
    ).toEqual([]);
    expect(
      await search.searchChunks({ orgId: ORG, matterId: MATTER_ID, query: 'executors', allowPrivileged: true }),
    ).toHaveLength(2);

    // Removing the document deletes its chunks.
    await db.doc(docPath('d-will')).update({ deletedAt: new Date(), deletedBy: 'ingest-lawyer' });
    expect(
      await poll(
        () => chunks('d-will'),
        (all) => all.length === 0,
      ),
    ).toEqual([]);
  });
});
