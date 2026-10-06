import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import { createLog } from '../../src/core/log';
import { storageFiles } from '../../src/documents/files';
import { expireExports } from '../../src/jobs/sweep-exports';
import { FakeClock } from '../../src/ports/fakes';

/**
 * CORE-12b through the Storage and Firestore emulators: `jobs-sweepExports`' sweep finds export
 * files with the bucket's own glob listing and deletes them with their jobs, leaving matter
 * documents and certificates alone. Every name is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = 'demo-materia.appspot.com';
const ORG = 'org-exports';

let admin: App;
let db: Firestore;

const bucket = () => getAdminStorage(admin).bucket(BUCKET);
const save = (path: string) => bucket().file(path).save(Buffer.from('fictional'), { contentType: 'application/pdf' });
const exists = async (path: string) => (await bucket().file(path).exists())[0];

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'exports-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
});

afterAll(async () => {
  await deleteAdminApp(admin);
});

describe('jobs-sweepExports', () => {
  it('deletes export files and their jobs once they are old enough, and nothing else', async () => {
    const zip = `orgs/${ORG}/exports/j-zip.zip`;
    const receipt = `orgs/${ORG}/exports/j-receipt.pdf`;
    const document = `orgs/${ORG}/matters/m1/documents/d1/v1`;
    const certificate = `orgs/${ORG}/certificates/dc-m1.pdf`;
    for (const path of [zip, receipt, document, certificate]) await save(path);
    await db.doc(`orgs/${ORG}/jobs/j-zip`).set({
      type: 'documents.zip',
      target: { kind: 'export', name: 'Documents M-2026-0001' },
      status: 'succeeded',
      output: { storagePath: zip },
      createdBy: 'exports-lawyer',
    });

    const log = createLog({ fn: 'exports-integration' }, () => undefined);
    const deps = { db, files: storageFiles(BUCKET), log };
    // Not yet 7 days old: kept.
    expect(await expireExports({ ...deps, clock: new FakeClock(new Date()) })).toMatchObject({ failed: 0 });
    expect(await exists(zip)).toBe(true);
    expect(await exists(receipt)).toBe(true);

    // Eight days on: both exports go, with the zip's job. (Counts are at least: the bucket is shared
    // with the other suites in this run.)
    const later = new FakeClock(new Date(Date.now() + 8 * 86_400_000));
    const swept = await expireExports({ ...deps, clock: later });
    expect(swept.failed).toBe(0);
    expect(swept.files).toBeGreaterThanOrEqual(2);
    expect(swept.jobs).toBeGreaterThanOrEqual(1);
    expect(await exists(zip)).toBe(false);
    expect(await exists(receipt)).toBe(false);
    expect((await db.doc(`orgs/${ORG}/jobs/j-zip`).get()).exists).toBe(false);
    expect(await exists(document)).toBe(true);
    expect(await exists(certificate)).toBe(true);
  });
});
