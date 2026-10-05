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

import { NOTE_CALLABLES, type Role, type SaveNoteResult } from '@materia/domain';

/**
 * CORE-13 through the emulators: notes-create and notes-update (mentions, revisions, conflicts,
 * privileged notes) with real claims, the mention notifications they send, client pinning and
 * deleting under the rules, and the matter's activity feed that activity-onAudit builds from the
 * audit entries of a scripted sequence (notes, a status change, a manual deadline). Everything is
 * fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-notes';
const PASSWORD = 'fictional-password-n13';
const MATTER_ID = 'm-notes';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const PRIVILEGED_ID = 'm-notes-priv';

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `notes-${role}`;
const NAMES: Record<Role, string> = {
  owner: 'Priya Fictional',
  admin: 'Alex Fictional',
  lawyer: 'Jordan Fictional',
  paralegal: 'Dana Fictional',
  readonly: 'Sam Fictional',
};

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', displayName: NAMES[role] });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )(data).then((result) => result.data);
}
const createNote = (data: Record<string, unknown>, requestId = randomUUID()) =>
  call<SaveNoteResult>(NOTE_CALLABLES.create, { requestId, matterId: MATTER_ID, ...data });
const updateNote = (data: Record<string, unknown>, requestId = randomUUID()) =>
  call<SaveNoteResult>(NOTE_CALLABLES.update, { requestId, matterId: MATTER_ID, ...data });

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;

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
const mentionsOf = async (noteId: string) =>
  (await db.collection(`orgs/${ORG}/notifications`).where('kind', '==', 'mention').where('noteId', '==', noteId).get())
    .docs;
const stamped = (uid: string, patch: Record<string, unknown>) => ({
  ...patch,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
});

/** The matter's feed as [kind, summary, actorUid], sorted. */
async function feed(): Promise<string[]> {
  const snap = await db.collection(`${MATTER}/activity`).get();
  return snap.docs.map((d) => [d.get('kind'), d.get('summary'), d.get('actorUid')].join(' | ')).sort();
}

const matterDoc = (number: string, privileged: boolean) => ({
  number,
  title: 'Estate of Fictional Linden',
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: uidOf('lawyer'),
  teamUids: [],
  clientContactIds: ['c-notes'],
  privileged,
  openTaskCount: 0,
  deletedAt: null,
  conflictCheck: { status: 'clear' },
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
});

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'notes-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('notes-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Notes Practice', timezone: 'Australia/Melbourne' });
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);
  await db.doc(MATTER).set(matterDoc('NT-2026-0001', false));
  await db.doc(`orgs/${ORG}/matters/${PRIVILEGED_ID}`).set(matterDoc('NT-2026-0002', true));

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'notes-integration-client');
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

describe('notes and the activity feed', () => {
  it('runs a scripted sequence and the feed and mentions follow', async () => {
    // 1. The lawyer writes a note mentioning two members, someone who isn't one, and a matter.
    await signInAs('lawyer');
    const lawyer = uidOf('lawyer');
    const body = `Called the executor. @[${uidOf('paralegal')}] please file it; @[${uidOf('owner')}] FYI. @[notes-nobody] #[${PRIVILEGED_ID}]`;
    const createRequest = randomUUID();
    const created = await createNote({ bodyMd: body }, createRequest);
    expect(created).toMatchObject({ notified: [uidOf('paralegal'), uidOf('owner')], unreachable: [] });
    const noteId = created.noteId;
    const notePath = `${MATTER}/notes/${noteId}`;
    expect(await data(notePath)).toMatchObject({
      bodyMd: body,
      mentions: { uids: [uidOf('paralegal'), uidOf('owner')], matterIds: [PRIVILEGED_ID] },
      privileged: false,
      createdBy: lawyer,
    });
    // A retry of the same request returns the stored result and sends nothing more.
    expect(await createNote({ bodyMd: body }, createRequest)).toEqual(created);

    // 2. The lawyer edits it: the paralegal and owner stay mentioned, the readonly member is new.
    const update = { noteId, bodyMd: `${body} Also @[${uidOf('readonly')}].`, expectedUpdatedAt: created.updatedAt };
    const updateRequest = randomUUID();
    const edited = await updateNote(update, updateRequest);
    expect(edited).toMatchObject({ notified: [uidOf('readonly')], unreachable: [] });
    expect(await updateNote(update, updateRequest)).toEqual(edited);

    // Mention notifications: one per newly mentioned member, never the author, no note text.
    const mentions = await mentionsOf(noteId);
    expect(mentions.map((d) => d.get('recipientUid')).sort()).toEqual(
      [uidOf('owner'), uidOf('paralegal'), uidOf('readonly')].sort(),
    );
    for (const mention of mentions) {
      expect(mention.id).toBe(`mention-${noteId}-${mention.get('recipientUid')}`);
      expect(mention.data()).toMatchObject({
        title: 'Jordan Fictional mentioned you on NT-2026-0001',
        link: `/matters/${MATTER_ID}/notes#note-${noteId}`,
        matterId: MATTER_ID,
      });
      expect(JSON.stringify(mention.data())).not.toContain('executor');
    }

    // 3. A stale save is a conflict; the first version is kept as a revision.
    const conflict = await failure(updateNote({ noteId, bodyMd: 'Stale edit', expectedUpdatedAt: created.updatedAt }));
    expect(conflict.code).toBe('functions/failed-precondition');
    expect(detailsOf(conflict)).toMatchObject({
      reason: 'note_conflict',
      updatedAt: edited.updatedAt,
      updatedBy: lawyer,
    });
    const revisions = await db.collection(`${notePath}/revisions`).get();
    expect(revisions.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({ bodyMd: body, privileged: false, editedBy: lawyer }),
    ]);

    // 4. A privileged note: the paralegal can't be told, and can't mark one privileged.
    const privileged = await createNote({ bodyMd: `Advice on prospects. @[${uidOf('paralegal')}]`, privileged: true });
    expect(privileged).toMatchObject({ notified: [], unreachable: [uidOf('paralegal')] });
    expect(await mentionsOf(privileged.noteId)).toHaveLength(0);

    // 5. The paralegal pins the first note directly, can't rewrite it, then deletes it.
    await signInAs('paralegal');
    const paralegal = uidOf('paralegal');
    const ref = doc(firestore, notePath);
    await updateDoc(ref, stamped(paralegal, { pinned: true }));
    await expect(updateDoc(ref, stamped(paralegal, { bodyMd: 'Rewritten' }))).rejects.toThrow();
    expect(detailsOf(await failure(createNote({ bodyMd: 'Mine', privileged: true })))).toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'privileged_requires_lawyer',
    });

    // 6. The paralegal adds a manual deadline; the lawyer puts the matter on hold.
    await setDoc(doc(firestore, `${MATTER}/deadlines/manual-notes`), {
      orgId: ORG,
      matterId: MATTER_ID,
      title: 'Respond to the caveat',
      dueDate: '2026-11-02',
      kind: 'contractual',
      critical: false,
      status: 'upcoming',
      assigneeUid: paralegal,
      reminders: [],
      createdAt: serverTimestamp(),
      createdBy: paralegal,
      updatedAt: serverTimestamp(),
      updatedBy: paralegal,
      schemaVersion: 1,
    });
    // The pin's audit entry is written before the delete's, so the two stay distinct.
    await poll(feed, (lines) => lines.some((line) => line.startsWith('note.pinned')));
    await updateDoc(ref, { ...stamped(paralegal, {}), deletedAt: serverTimestamp(), deletedBy: paralegal });
    await signInAs('lawyer');
    await call('matters-changeStatus', { requestId: randomUUID(), matterId: MATTER_ID, to: 'on_hold' });

    // The feed, from the audit entries: one line per change, actor-less summaries, no note text.
    const expected = [
      `deadline.created | Added deadline “Respond to the caveat” due 2 Nov 2026 | ${paralegal}`,
      `matter.status_changed | Changed the status from Open to On hold | ${lawyer}`,
      `note.created | Added a note | ${lawyer}`,
      `note.created | Added a note | ${lawyer}`,
      `note.deleted | Deleted a note | ${paralegal}`,
      `note.edited | Edited a note | ${lawyer}`,
      `note.pinned | Pinned a note | ${paralegal}`,
    ];
    expect(await poll(feed, (lines) => lines.length >= expected.length)).toEqual(expected);
    // Nothing late or doubled (the callables' writes and the trigger's own writes add no lines).
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await feed()).toEqual(expected);
    const lines = await db.collection(`${MATTER}/activity`).get();
    for (const line of lines.docs) {
      expect(line.id).toMatch(/^audit-/);
      expect(line.get('refs')).toHaveProperty('auditId');
      expect(JSON.stringify(line.data())).not.toMatch(/executor|prospects/);
    }
    expect(lines.docs.find((d) => d.get('kind') === 'note.pinned')?.get('refs')).toMatchObject({ noteId });
    expect((await data(MATTER))['lastActivityAt']).toBeDefined();
  }, 120_000);
});
