import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  contactSearchTokens,
  documentSearchTokens,
  matterSearchTokens,
  parseSearchQuery,
  taskSearchTokens,
} from '@materia/domain';

/**
 * CORE-15 through the emulators: the triggers that keep `search` (matters-denormalise,
 * contacts-onWrite, documents-onWrite, tasks-onWrite and tasks-onPersonalWrite) fill it on create,
 * follow renames, and leave it alone otherwise; and the tokens answer the palette's queries.
 * Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-search';
const MATTER = `orgs/${ORG}/matters/m-search`;

let admin: App;
let db: Firestore;

const meta = () => ({
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
});

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const searchOf = async (path: string) => ((await db.doc(path).get()).get('search') as string[] | undefined) ?? [];
const settledSearch = (path: string, expected: readonly string[]) =>
  poll(
    () => searchOf(path),
    (value) => JSON.stringify(value) === JSON.stringify(expected),
  );

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'search-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Search Practice', timezone: 'Australia/Melbourne' });
  await db.doc(`orgs/${ORG}/contacts/c-client`).set({
    kind: 'person',
    givenNames: 'Zoë',
    familyName: 'Ångström',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    ...meta(),
  });
  await db.doc(MATTER).set({
    number: 'SR-2026-0142',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    clientContactIds: ['c-client'],
    deletedAt: null,
    ...meta(),
  });
});

afterAll(async () => {
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await deleteAdminApp(admin);
});

describe('search tokens (CORE-15)', () => {
  it('matters-denormalise indexes the number in every form, the title and the client', async () => {
    const expected = matterSearchTokens({
      number: 'SR-2026-0142',
      title: 'Estate of Fictional Wren',
      clientNames: ['Zoë Ångström'],
    });
    const search = await settledSearch(MATTER, expected);
    expect(search).toEqual(expected);
    for (const typed of ['142', '2026-0142', 'SR-2026-0142', 'angstrom']) {
      const token = parseSearchQuery(typed).token as string;
      const found = await db.collection(`orgs/${ORG}/matters`).where('search', 'array-contains', token).get();
      expect(
        found.docs.map((d) => d.id),
        typed,
      ).toEqual(['m-search']);
    }
  });

  it('contacts-onWrite indexes names with diacritics stripped', async () => {
    const expected = contactSearchTokens({ givenNames: 'Zoë', familyName: 'Ångström' });
    expect(await settledSearch(`orgs/${ORG}/contacts/c-client`, expected)).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(['zoe', 'angstrom']));
  });

  it('documents-onWrite indexes the name, follows a rename and leaves other edits alone', async () => {
    const path = `${MATTER}/documents/d-grant`;
    await db.doc(path).set({
      orgId: ORG,
      matterId: 'm-search',
      name: 'Grant of probate – Wren.pdf',
      category: 'grant',
      privileged: false,
      tags: [],
      version: 1,
      versions: [],
      scan: { status: 'clean' },
      ingest: { status: 'done' },
      source: 'upload',
      ...meta(),
    });
    expect(await settledSearch(path, documentSearchTokens('Grant of probate – Wren.pdf'))).toEqual(
      documentSearchTokens('Grant of probate – Wren.pdf'),
    );
    await db.doc(path).update({ name: 'Sealed grant – Wren.pdf' });
    expect(await settledSearch(path, documentSearchTokens('Sealed grant – Wren.pdf'))).toContain('sealed');
    const found = await db
      .collectionGroup('documents')
      .where('orgId', '==', ORG)
      .where('search', 'array-contains', 'sealed')
      .get();
    expect(found.docs.map((d) => d.id)).toEqual(['d-grant']);
  });

  it('tasks-onWrite and tasks-onPersonalWrite index the title', async () => {
    const matterTask = `${MATTER}/tasks/t-inventory`;
    await db.doc(matterTask).set({
      orgId: ORG,
      matterId: 'm-search',
      title: 'Lodge the Inventory of Assets',
      status: 'todo',
      priority: 'medium',
      assigneeUid: 'search-lawyer',
      checklist: [],
      order: 1,
      source: 'manual',
      countedOpen: false,
      ...meta(),
    });
    const personal = `orgs/${ORG}/members/search-lawyer/tasks/p-call`;
    await db.doc(personal).set({
      orgId: ORG,
      matterId: null,
      title: 'Call the Registry',
      status: 'todo',
      priority: 'none',
      assigneeUid: 'search-lawyer',
      checklist: [],
      order: 1,
      source: 'manual',
      ...meta(),
    });
    expect(await settledSearch(matterTask, taskSearchTokens('Lodge the Inventory of Assets'))).toContain('inventory');
    expect(await settledSearch(personal, taskSearchTokens('Call the Registry'))).toContain('registry');
    // A status change leaves search alone; a rename replaces it.
    await db.doc(matterTask).update({ status: 'in_progress' });
    await db.doc(matterTask).update({ title: 'Lodge the probate application' });
    expect(await settledSearch(matterTask, taskSearchTokens('Lodge the probate application'))).not.toContain(
      'inventory',
    );
    const mine = await db
      .collectionGroup('tasks')
      .where('orgId', '==', ORG)
      .where('assigneeUid', '==', 'search-lawyer')
      .where('search', 'array-contains', 'lodge')
      .get();
    expect(mine.docs.map((d) => d.id)).toEqual(['t-inventory']);
  });
});
