import { createHash } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { onOrgWriteDefinition, recordWrite } from '../../src/audit/on-write';
import { runTrigger, type TriggerDeps } from '../../src/core/trigger';

/**
 * FND-18 acceptance tests, end to end through the emulators: Admin SDK writes fire the deployed
 * `audit-onOrgWrite` and `audit-onMatterWrite` triggers, and members read through `audit-query`.
 * All data is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-audit';
const PASSWORD = 'fictional-password-1';
const MATTER = `orgs/${ORG}/matters/m-audit`;
const PRIVILEGED = `orgs/${ORG}/matters/m-privileged`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const meta = (uid: string) => ({
  createdAt: FieldValue.serverTimestamp(),
  createdBy: uid,
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: uid,
  schemaVersion: 1,
});
const touch = (uid: string) => ({ updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });

async function entriesFor(path: string): Promise<FirebaseFirestore.DocumentData[]> {
  const snapshot = await db.collection(`orgs/${ORG}/audit`).where('entity.path', '==', path).get();
  return snapshot.docs
    .map((d) => d.data())
    .sort((a, b) => (a['at'] as Timestamp).toMillis() - (b['at'] as Timestamp).toMillis());
}

/** Polls until `path` has `count` audit entries, then waits a little longer to catch extras. */
async function waitForEntries(path: string, count: number): Promise<FirebaseFirestore.DocumentData[]> {
  const deadline = Date.now() + 20_000;
  let entries = await entriesFor(path);
  while (entries.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    entries = await entriesFor(path);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return entriesFor(path);
}

async function createMember(who: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: `audit-${who}`, email: `audit-${who}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(`audit-${who}`, { orgId: ORG, role: who });
  await db.doc(`orgs/${ORG}/members/audit-${who}`).set({ role: who, status: 'active' });
}

const query = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, { entries: Record<string, unknown>[]; nextCursor: string | null }>(
    getFunctions(client, 'australia-southeast1'),
    'audit-query',
  )(data);

async function signInAs(who: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `audit-${who}@example.test`, PASSWORD);
}

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'audit-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('audit-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Audit Practice', retentionYears: 7 });
  for (const role of ['owner', 'paralegal', 'readonly'] as const) await createMember(role);
  await db
    .doc(MATTER)
    .set({ ...meta('audit-owner'), title: 'Estate of Example Person', status: 'open', privileged: false });
  await db
    .doc(PRIVILEGED)
    .set({ ...meta('audit-owner'), title: 'Privileged matter', status: 'open', privileged: true });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'audit-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('audit triggers through the emulators', () => {
  // Five writes, each waiting for its trigger and a 1.5 s settle that also keeps the entries'
  // timestamps apart (the order assertion needs that); under a busy emulator that needs more than
  // the suite's default 30 s.
  it('records create, update, soft delete, restore and delete of a contact (org collection)', async () => {
    const path = `orgs/${ORG}/contacts/c-1`;
    const ref = db.doc(path);
    await ref.set({ ...meta('audit-paralegal'), kind: 'person', givenNames: 'Alex', notes: 'Prefers phone calls' });
    await waitForEntries(path, 1);
    await ref.update({ ...touch('audit-owner'), kind: 'organisation' });
    await waitForEntries(path, 2);
    await ref.update({ ...touch('audit-owner'), deletedAt: FieldValue.serverTimestamp(), deletedBy: 'audit-owner' });
    await waitForEntries(path, 3);
    await ref.update({ ...touch('audit-paralegal'), deletedAt: FieldValue.delete(), deletedBy: FieldValue.delete() });
    await waitForEntries(path, 4);
    await ref.delete();
    const entries = await waitForEntries(path, 5);

    expect(entries.map((e) => [e['action'], e['actor']])).toEqual([
      ['create', { uid: 'audit-paralegal' }],
      ['update', { uid: 'audit-owner' }],
      ['soft_delete', { uid: 'audit-owner' }],
      ['restore', { uid: 'audit-paralegal' }],
      ['delete', { uid: 'audit-paralegal' }],
    ]);
    const [created, updated] = entries;
    expect(created?.['after']).toMatchObject({
      kind: 'person',
      notes: { len: 19, sha256: sha('Prefers phone calls') },
    });
    expect(updated).toMatchObject({
      changedFields: ['kind'],
      before: { kind: 'person' },
      after: { kind: 'organisation' },
      source: 'client',
    });
    expect(updated?.['entity']).toEqual({ path, collection: 'contacts', id: 'c-1' });
    // Retention: seven years from the event time.
    const years =
      ((created?.['expireAt'] as Timestamp).toMillis() - (created?.['at'] as Timestamp).toMillis()) /
      (365.25 * 86_400_000);
    expect(Math.round(years)).toBe(7);
  }, 60_000);

  it('records matter updates, but not denormalised-only changes', async () => {
    await db.doc(MATTER).update({ ...touch('audit-owner'), status: 'active' });
    await db.doc(MATTER).update({ ...touch('system'), nextDeadline: '2026-11-04', openTaskCount: 3 });
    const entries = await waitForEntries(MATTER, 2);
    expect(entries.map((e) => [e['action'], e['changedFields']])).toEqual([
      ['create', ['privileged', 'status', 'title']],
      ['update', ['status']],
    ]);
    expect(entries[1]?.['entity']).toMatchObject({ matterId: 'm-audit' });
  });

  it('redacts bodyMd on notes and narrative on time entries (matter subcollections)', async () => {
    const note = `${MATTER}/notes/n-1`;
    const bodyMd = 'Spoke with the executor about the sale of the family home.';
    await db.doc(note).set({ ...meta('audit-paralegal'), bodyMd, pinned: false });
    const time = `${MATTER}/timeEntries/t-1`;
    const narrative = 'Telephone attendance on executor regarding valuation.';
    await db.doc(time).set({ ...meta('audit-paralegal'), narrative, units: 2 });
    const [noteEntry] = await waitForEntries(note, 1);
    const [timeEntry] = await waitForEntries(time, 1);
    expect(noteEntry?.['after']).toEqual({ bodyMd: { len: bodyMd.length, sha256: sha(bodyMd) }, pinned: false });
    expect(timeEntry?.['after']).toEqual({ narrative: { len: narrative.length, sha256: sha(narrative) }, units: 2 });
    expect(JSON.stringify([noteEntry, timeEntry])).not.toContain('executor');
    expect(noteEntry?.['entity']).toEqual({ path: note, collection: 'notes', id: 'n-1', matterId: 'm-audit' });
  });

  it('records task changes but skips order-only reorders', async () => {
    const task = `${MATTER}/tasks/task-1`;
    await db.doc(task).set({ ...meta('audit-paralegal'), title: 'Lodge the inventory', order: 1 });
    // Wait between writes: entries are ordered by event time, and back-to-back writes can share it.
    await waitForEntries(task, 1);
    await db.doc(task).update({ ...touch('audit-paralegal'), order: 2 });
    expect(await waitForEntries(task, 1)).toHaveLength(1);
    await db
      .doc(task)
      .update({ ...touch('audit-paralegal'), deletedAt: FieldValue.serverTimestamp(), deletedBy: 'audit-paralegal' });
    const entries = await waitForEntries(task, 2);
    expect(entries.map((e) => e['action'])).toEqual(['create', 'soft_delete']);
  });

  it('never audits excluded collections', async () => {
    await db.doc(`orgs/${ORG}/metrics/day-2026-10-04`).set({ values: { matters: 1 } });
    await db.doc(`${MATTER}/activity/a-1`).set({ kind: 'note' });
    expect(await waitForEntries(`orgs/${ORG}/metrics/day-2026-10-04`, 0)).toEqual([]);
    expect(await entriesFor(`${MATTER}/activity/a-1`)).toEqual([]);
  });

  it('writes one entry when the same event is delivered twice', async () => {
    const path = `orgs/${ORG}/contacts/c-dup`;
    const after = await (async () => {
      await db.doc(path).set({ ...meta('audit-owner'), kind: 'person' });
      return db.doc(path).get();
    })();
    await waitForEntries(path, 1);
    const event = {
      id: 'redelivered-event-1',
      params: { orgId: ORG, collection: 'contacts', docId: 'c-dup' },
      change: { before: undefined, after },
    };
    const deps: TriggerDeps = {
      db: () => db,
      clock: { now: () => new Date() },
      ports: () => ({}) as never,
      sink: () => undefined,
    };
    expect(await runTrigger(onOrgWriteDefinition, event, deps)).toBe('ran');
    expect(await runTrigger(onOrgWriteDefinition, event, deps)).toBe('duplicate');
    // Past the guard as well: the entry id is the event id, so a second write is refused.
    const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    const ctx = {
      eventId: event.id,
      time: new Date(),
      params: event.params,
      log: quiet,
      clock: deps.clock,
      db,
      ports: {},
    };
    expect(await recordWrite(event.change, ctx as never)).toBe('duplicate');
    expect((await db.doc(`orgs/${ORG}/audit/redelivered-event-1`).get()).exists).toBe(true);
    expect((await entriesFor(path)).length).toBe(2);
  });
});

describe('audit-query through the emulators', () => {
  it('lets owners query the org with values, paginated newest first', async () => {
    await signInAs('owner');
    const path = `orgs/${ORG}/contacts/c-1`;
    const first = await query({ entityPath: path, limit: 2 });
    expect(first.data.entries.map((e) => e['action'])).toEqual(['delete', 'restore']);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    const second = await query({ entityPath: path, limit: 2, cursor: first.data.nextCursor });
    expect(second.data.entries.map((e) => e['action'])).toEqual(['soft_delete', 'update']);
    const third = await query({ entityPath: path, limit: 2, cursor: second.data.nextCursor });
    expect(third.data.entries.map((e) => e['action'])).toEqual(['create']);
    expect(third.data.nextCursor).toBeNull();
    expect(second.data.entries[1]).toMatchObject({ before: { kind: 'person' }, after: { kind: 'organisation' } });
    const byActor = await query({ actorUid: 'audit-paralegal', matterId: 'm-audit' });
    expect(byActor.data.entries.length).toBeGreaterThanOrEqual(4);
    expect(byActor.data.entries.every((e) => (e['actor'] as { uid: string }).uid === 'audit-paralegal')).toBe(true);
  });

  it('gives members their matter history without values', async () => {
    await signInAs('paralegal');
    const result = await query({ matterId: 'm-audit' });
    expect(result.data.entries.length).toBeGreaterThanOrEqual(5);
    expect(result.data.entries.every((e) => (e['entity'] as { matterId: string }).matterId === 'm-audit')).toBe(true);
    for (const entry of result.data.entries) {
      expect(entry).not.toHaveProperty('before');
      expect(entry).not.toHaveProperty('after');
    }
  });

  it('refuses org-wide and privileged queries to members', async () => {
    await signInAs('paralegal');
    expect((await failure(query({}))).code).toBe('functions/permission-denied');
    expect((await failure(query({ entityPath: `orgs/${ORG}/contacts/c-1` }))).code).toBe('functions/permission-denied');
    expect((await failure(query({ matterId: 'm-missing' }))).code).toBe('functions/not-found');
    await signInAs('readonly');
    expect((await failure(query({ matterId: 'm-privileged' }))).code).toBe('functions/permission-denied');
    await signInAs('owner');
    expect((await failure(query({ entityPath: 'orgs/org-other/contacts/c-1' }))).code).toBe(
      'functions/invalid-argument',
    );
    expect((await failure(query({ cursor: 'not-a-cursor' }))).code).toBe('functions/invalid-argument');
  });
});
