import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import type { MigrationReviewResult, ResolveMigrationReviewResult } from '@materia/domain';

/**
 * MIG-08 through the emulators: the review codes the legacy migration loaded are cleared by the
 * triggers when a person puts the record right elsewhere (matters-denormalise, contacts-onWrite),
 * left alone by the migration's own re-load, and the rest marked reviewed with
 * migration-resolveReview until the import counts as reviewed. All practices and people are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-migration-review';
const PASSWORD = 'fictional-password-mr1';
const M = `orgs/${ORG}/matters`;
const C = `orgs/${ORG}/contacts`;
const LOADED = new Date('2026-10-06T21:00:00.000Z');

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const migration = (legacyPath: string, loadedAt = LOADED) => ({ runId: 'run-it', legacyPath, loadedAt });
const meta = { createdAt: LOADED, createdBy: 'mr-owner', updatedAt: LOADED, updatedBy: 'mr-owner', schemaVersion: 1 };
const matter = (number: string, needsReview: string[], extra: Record<string, unknown> = {}) => ({
  ...meta,
  number,
  title: 'Estate of Fictional Wren',
  type: 'probate',
  status: 'open',
  privileged: false,
  deletedAt: null,
  clientContactIds: ['c-client'],
  needsReview,
  migration: migration(`workflows/w/cards/${number}`),
  ...extra,
});

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )(data).then((result) => result.data);
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
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
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'migration-review-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('mr-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Imported Practice', retentionYears: 7 });
  await adminAuth.createUser({ uid: 'mr-owner', email: 'mr-owner@example.test', password: PASSWORD });
  await adminAuth.setCustomUserClaims('mr-owner', { orgId: ORG, role: 'owner' });
  await db.doc(`orgs/${ORG}/members/mr-owner`).set({ role: 'owner', status: 'active', displayName: 'Tess Fictional' });

  // What the load writes: records stamped with the run, so the triggers skip their side effects.
  await db.doc(`${C}/c-client`).set({
    ...meta,
    kind: 'person',
    givenNames: 'Fictional',
    familyName: 'Wren',
    migration: migration('cards/c1#client'),
  });
  await db.doc(`${C}/c-referrer`).set({
    ...meta,
    kind: 'organisation',
    orgName: 'Unnamed referrer (imported)',
    isReferrer: true,
    needsReview: ['referrer_unnamed'],
    migration: migration('referrers/r1'),
  });
  await db
    .doc(`${M}/m-untitled`)
    .set(matter('M-2025-0001', ['title_missing', 'client_placeholder'], { title: 'Untitled matter (imported)' }));
  await db.doc(`${M}/m-reload`).set(matter('M-2025-0002', ['title_missing'], { title: 'Untitled matter (imported)' }));
  await db.doc(`orgs/${ORG}/migrations/run-it`).set({
    ...meta,
    runId: 'run-it',
    mode: 'rehearsal',
    status: 'succeeded',
    startedAt: LOADED,
    finishedAt: LOADED,
    counts: { matters: 2, contacts: 2 },
    warnings: [],
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'migration-review-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  await signInWithEmailAndPassword(auth, 'mr-owner@example.test', PASSWORD);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('migration review codes', () => {
  it('lists what the load flagged', async () => {
    const result = await call<MigrationReviewResult>('migration-review', {});
    expect(result).toMatchObject({ open: 4, reviewed: 0, percent: 0, reviewedAt: null });
    expect(result.items.map((item) => item.id).sort()).toEqual(['c-referrer', 'm-reload', 'm-untitled']);
  });

  it('clears a code when the person puts the record right elsewhere, and not on a re-load', async () => {
    // A person renames the untitled matter (as the matter page does) and names the referrer.
    await db.doc(`${M}/m-untitled`).update({
      title: 'Estate of Fictional Finch',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'mr-owner',
    });
    await db.doc(`${C}/c-referrer`).update({
      orgName: 'Fictional Referral Partners',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'mr-owner',
    });
    // The migration loads the other matter again with a new title: still its write, still open.
    await db.doc(`${M}/m-reload`).update({
      title: 'Untitled matter (imported again)',
      migration: migration('workflows/w/cards/M-2025-0002', new Date()),
    });

    const matter = await poll(
      () => data(`${M}/m-untitled`),
      (doc) => (doc['reviewed'] as string[] | undefined)?.includes('title_missing') === true,
    );
    expect(matter['needsReview']).toEqual(['client_placeholder']);
    expect(matter['reviewed']).toEqual(['title_missing']);
    const referrer = await poll(
      () => data(`${C}/c-referrer`),
      (doc) => doc['needsReview'] === undefined,
    );
    expect(referrer['reviewed']).toEqual(['referrer_unnamed']);
    expect((await data(`${M}/m-reload`))['needsReview']).toEqual(['title_missing']);
  });

  it('marks the rest reviewed, and the import counts as reviewed', async () => {
    const result = await call<ResolveMigrationReviewResult>('migration-resolveReview', {
      requestId: randomUUID(),
      items: [
        { path: `${M}/m-untitled`, code: 'client_placeholder' },
        { path: `${M}/m-reload`, code: 'title_missing' },
      ],
    });
    expect(result).toMatchObject({ resolved: 2, open: 0, reviewed: 4, percent: 100 });
    expect(result.reviewedAt).not.toBeNull();
    expect(await data(`orgs/${ORG}/migrations/run-it`)).toMatchObject({ reviewedBy: 'mr-owner' });
    const audited = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'migration.reviewed').get();
    expect(audited.size).toBe(1);
  });
});
