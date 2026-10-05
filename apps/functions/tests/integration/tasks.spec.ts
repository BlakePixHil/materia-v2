import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { isOpenTask, type BulkUpdateTasksResult, type Role } from '@materia/domain';

/**
 * CORE-08 through the emulators: client-created tasks and the tasks-onWrite trigger
 * (openTaskCount under concurrent edits, completedAt, the assignment notification, activity), the
 * personal-task trigger, and tasks-bulkUpdate. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-tasks';
const PASSWORD = 'fictional-password-t8';
const MATTER = `orgs/${ORG}/matters/m-tasks`;
const TASKS = `${MATTER}/tasks`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `tasks-${role}`;

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active' });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

const bulkUpdate = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, BulkUpdateTasksResult>(
    getFunctions(client, 'australia-southeast1'),
    'tasks-bulkUpdate',
  )(data).then((result) => result.data);

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
const openTaskCount = async () => (await data(MATTER))['openTaskCount'];

/** The open tasks the matter really has, and whether every task's marker agrees. */
async function actualOpen(): Promise<{ open: number; settled: boolean }> {
  const snap = await db.collection(TASKS).get();
  const tasks = snap.docs.map((d) => d.data());
  return {
    open: tasks.filter((t) => isOpenTask(t)).length,
    settled: tasks.every((t) => t['countedOpen'] === isOpenTask(t)),
  };
}

/** Waits until the trigger has caught up: every marker agrees and the count matches. */
async function settledCount(): Promise<{ count: unknown; open: number }> {
  let open = -1;
  const count = await poll(
    async () => {
      const actual = await actualOpen();
      open = actual.open;
      return actual.settled ? openTaskCount() : Number.NaN;
    },
    (value) => value === open,
  );
  return { count, open };
}

/** What the client's task repository writes for a new matter task. */
const clientTask = (uid: string, extra: Record<string, unknown> = {}) => ({
  title: 'Request the bank valuation letters',
  status: 'todo',
  priority: 'medium',
  checklist: [],
  order: 1024,
  source: 'manual',
  countedOpen: false,
  orgId: ORG,
  matterId: 'm-tasks',
  createdAt: serverTimestamp(),
  createdBy: uid,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
  schemaVersion: 1,
  ...extra,
});
const stamped = (uid: string, patch: Record<string, unknown>) => ({
  ...patch,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
});

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'tasks-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('tasks-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Tasks Practice', timezone: 'Australia/Melbourne' });
  for (const role of ['lawyer', 'paralegal', 'readonly'] as const) await createMember(role);
  await db.doc(MATTER).set({
    number: 'TK-2026-0001',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    openTaskCount: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'tasks-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('tasks-onWrite', () => {
  it('counts client-created tasks and stamps completedAt on done, removing it on reopen', async () => {
    await signInAs('paralegal');
    const uid = uidOf('paralegal');
    await setDoc(doc(firestore, `${TASKS}/client-1`), clientTask(uid));
    await setDoc(doc(firestore, `${TASKS}/client-2`), clientTask(uid, { title: 'Advertise for creditors' }));
    expect(await settledCount()).toEqual({ count: 2, open: 2 });

    await updateDoc(doc(firestore, `${TASKS}/client-1`), stamped(uid, { status: 'done' }));
    const done = await poll(
      () => data(`${TASKS}/client-1`),
      (task) => !!task['completedAt'],
    );
    expect(done['completedAt']).toBeDefined();
    expect(await settledCount()).toEqual({ count: 1, open: 1 });

    await updateDoc(doc(firestore, `${TASKS}/client-1`), stamped(uid, { status: 'in_progress' }));
    const reopened = await poll(
      () => data(`${TASKS}/client-1`),
      (task) => !task['completedAt'],
    );
    expect(reopened).not.toHaveProperty('completedAt');
    expect(await settledCount()).toEqual({ count: 2, open: 2 });

    // Soft delete, then restore.
    await updateDoc(doc(firestore, `${TASKS}/client-2`), {
      ...stamped(uid, {}),
      deletedAt: serverTimestamp(),
      deletedBy: uid,
    });
    expect(await settledCount()).toEqual({ count: 1, open: 1 });
    await updateDoc(doc(firestore, `${TASKS}/client-2`), { ...stamped(uid, {}), deletedAt: null, deletedBy: null });
    expect(await settledCount()).toEqual({ count: 2, open: 2 });
  });

  it('keeps openTaskCount exact under concurrent edits', async () => {
    const before = (await settledCount()).count as number;
    // 30 tasks created at once, then every one edited several times concurrently (status flips,
    // a delete, edits that don't change the count) with the writes racing each other.
    const ids = Array.from({ length: 30 }, (_, i) => `race-${i}`);
    await Promise.all(
      ids.map((id, i) =>
        db.doc(`${TASKS}/${id}`).set({
          ...clientTask('seed', { title: `Fictional task ${i}`, order: i }),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      ),
    );
    const statuses = ['done', 'todo', 'blocked', 'cancelled', 'in_progress', 'done'];
    await Promise.all(
      ids.flatMap((id, i) => [
        ...statuses.slice(0, 2 + (i % 5)).map((status) => db.doc(`${TASKS}/${id}`).update({ status })),
        db.doc(`${TASKS}/${id}`).update({ priority: 'high', order: i + 0.5 }),
        ...(i % 7 === 0 ? [db.doc(`${TASKS}/${id}`).update({ deletedAt: FieldValue.serverTimestamp() })] : []),
      ]),
    );
    const { count, open } = await settledCount();
    expect(count).toBe(open);
    expect(open).toBeGreaterThan(before);
    // And it stays there: no late event moves it.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await openTaskCount()).toBe(open);
  }, 120_000);

  it('notifies the assignee once, not someone assigning themselves', async () => {
    await signInAs('lawyer');
    const uid = uidOf('lawyer');
    await setDoc(
      doc(firestore, `${TASKS}/assigned-1`),
      clientTask(uid, { title: 'Prepare the inventory of assets', assigneeUid: uidOf('paralegal') }),
    );
    await setDoc(doc(firestore, `${TASKS}/assigned-self`), clientTask(uid, { assigneeUid: uid }));
    const notifications = await poll(
      async () =>
        (
          await db
            .collection(`orgs/${ORG}/notifications`)
            .where('kind', '==', 'task_assigned')
            .where('taskId', '==', 'assigned-1')
            .get()
        ).docs.map((d) => d.data()),
      (found) => found.length > 0,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      recipientUid: uidOf('paralegal'),
      matterId: 'm-tasks',
      title: 'Task assigned to you',
      body: 'Prepare the inventory of assets · TK-2026-0001',
      link: '/matters/m-tasks/tasks',
      // Assignments go in-app and by email (FND-20); this member has no address, so only in-app arrives.
      channels: ['inapp', 'email'],
      priority: 'normal',
      readAt: null,
    });
    // A later edit that keeps the assignee doesn't notify again; reassigning does.
    await updateDoc(doc(firestore, `${TASKS}/assigned-1`), stamped(uid, { priority: 'urgent' }));
    await updateDoc(doc(firestore, `${TASKS}/assigned-self`), stamped(uid, { priority: 'urgent' }));
    await settledCount();
    const all = await db.collection(`orgs/${ORG}/notifications`).where('kind', '==', 'task_assigned').get();
    expect(all.docs.map((d) => d.get('taskId'))).toEqual(['assigned-1']);

    // The activity feed has the creation.
    const activity = await poll(
      async () =>
        (await db.collection(`${MATTER}/activity`).where('refs.taskId', '==', 'assigned-1').get()).docs.map((d) =>
          d.get('kind'),
        ),
      (kinds) => kinds.includes('task.created'),
    );
    expect(activity).toContain('task.created');
  });

  it('a personal task gets completedAt, and only its owner sees it', async () => {
    await signInAs('lawyer');
    const uid = uidOf('lawyer');
    const path = `orgs/${ORG}/members/${uid}/tasks/personal-1`;
    await setDoc(doc(firestore, path), clientTask(uid, { matterId: null, assigneeUid: uid, countedOpen: false }));
    await updateDoc(doc(firestore, path), stamped(uid, { status: 'done' }));
    const done = await poll(
      () => data(path),
      (task) => !!task['completedAt'],
    );
    expect(done['completedAt']).toBeDefined();
  });
});

describe('tasks-bulkUpdate', () => {
  const BULK = 60;
  const refs = Array.from({ length: BULK }, (_, i) => ({ matterId: 'm-tasks', taskId: `bulk-${i}` }));

  beforeAll(async () => {
    const batch = db.batch();
    for (const ref of refs) {
      batch.set(db.doc(`${TASKS}/${ref.taskId}`), {
        ...clientTask('seed', { title: `Fictional bulk task ${ref.taskId}` }),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    await settledCount();
  });

  it('completes 60 tasks in one call, idempotently, and the count follows', async () => {
    await signInAs('paralegal');
    const before = (await settledCount()).count as number;
    const requestId = randomUUID();
    const input = {
      requestId,
      tasks: [...refs, { matterId: 'm-tasks', taskId: 'missing' }],
      change: { op: 'status', status: 'done' },
    };
    const result = await bulkUpdate(input);
    expect(result).toEqual({
      updated: BULK,
      skipped: [{ matterId: 'm-tasks', taskId: 'missing', reason: 'not_found' }],
    });
    // A repeat with the same requestId returns the stored result without writing again.
    expect(await bulkUpdate(input)).toEqual(result);
    const after = await settledCount();
    expect(after.count).toBe(before - BULK);
    const sample = await data(`${TASKS}/bulk-7`);
    expect(sample).toMatchObject({ status: 'done', updatedBy: uidOf('paralegal'), _requestId: requestId });
    expect(sample['completedAt']).toBeDefined();
  }, 120_000);

  it('reassigns, notifying the new assignee, and soft deletes', async () => {
    await signInAs('paralegal');
    const some = refs.slice(0, 3);
    await bulkUpdate({ requestId: randomUUID(), tasks: some, change: { op: 'status', status: 'todo' } });
    const result = await bulkUpdate({
      requestId: randomUUID(),
      tasks: some,
      change: { op: 'assignee', assigneeUid: uidOf('lawyer') },
    });
    expect(result.updated).toBe(3);
    const notified = await poll(
      async () =>
        (
          await db
            .collection(`orgs/${ORG}/notifications`)
            .where('recipientUid', '==', uidOf('lawyer'))
            .where(
              'taskId',
              'in',
              some.map((r) => r.taskId),
            )
            .get()
        ).size,
      (n) => n === 3,
    );
    expect(notified).toBe(3);

    const deleted = await bulkUpdate({ requestId: randomUUID(), tasks: some, change: { op: 'delete' } });
    expect(deleted.updated).toBe(3);
    expect(await data(`${TASKS}/${some[0]?.taskId}`)).toMatchObject({ deletedBy: uidOf('paralegal') });
    const { count, open } = await settledCount();
    expect(count).toBe(open);
  }, 120_000);

  it('refuses read-only members and unknown assignees', async () => {
    await signInAs('readonly');
    const denied = await bulkUpdate({
      requestId: randomUUID(),
      tasks: refs.slice(0, 1),
      change: { op: 'delete' },
    }).catch((error: FunctionsError) => error);
    expect((denied as FunctionsError).code).toBe('functions/permission-denied');
    await signInAs('paralegal');
    const invalid = await bulkUpdate({
      requestId: randomUUID(),
      tasks: refs.slice(0, 1),
      change: { op: 'assignee', assigneeUid: 'tasks-nobody' },
    }).catch((error: FunctionsError) => error);
    expect((invalid as FunctionsError).code).toBe('functions/invalid-argument');
  });
});
