import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

import { MatterTaskCreateInput, PERMISSIONS, ROLES, type Role } from '@materia/domain';
import { ENTITY_FACTORIES } from '@materia/test-utils';

import { changeFor, COLLECTIONS, rolesFor, seedData, specFor, type CollectionSpec } from './support/collections';
import { writeRulesCoverage } from './support/coverage';
import {
  createRulesEnv,
  db,
  MATTER,
  ORG,
  OTHER_ORG,
  seedAdmin,
  seedMembers,
  SUSPENDED_UID,
  uidFor,
} from './support/harness';

const OWNER_UID = uidFor('lawyer');

let env: RulesTestEnvironment;

/** A whitelisted change, stamped with valid meta for `uid`. */
const stamped = (change: Record<string, unknown>, uid: string) => ({
  ...change,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
});

/** Every role in the org, someone from another org, and a suspended lawyer. */
type Who = Role | 'outsider' | 'suspended';
const EVERYONE: Who[] = [...ROLES, 'outsider', 'suspended'];
const firestoreOf = (who: Who): { firestore: Firestore; uid: string } => {
  if (who === 'outsider') return { firestore: db(env, 'owner', OTHER_ORG), uid: uidFor('owner', OTHER_ORG) };
  if (who === 'suspended') return { firestore: db(env, 'lawyer', ORG, SUSPENDED_UID), uid: SUSPENDED_UID };
  return { firestore: db(env, who), uid: uidFor(who) };
};
const isMember = (who: Who): who is Role => who !== 'outsider' && who !== 'suspended';
const allows = (who: Who, action: keyof typeof PERMISSIONS) =>
  isMember(who) && (PERMISSIONS[action] as readonly Role[]).includes(who);

async function seed(spec: CollectionSpec) {
  await seedAdmin(env, (firestore) => setDoc(doc(firestore, spec.docPath), seedData(spec)));
}

/** The role that should be allowed to update (owner specs: the owner, otherwise the most senior). */
const writerFor = (spec: CollectionSpec): Role =>
  spec.update === 'owner' ? 'lawyer' : (rolesFor(spec.update)[0] ?? 'owner');

beforeAll(async () => {
  env = await createRulesEnv();
  await env.clearFirestore();
  await seedMembers(env);
  // Seed every document first: some rules read a parent (Clerk messages read their thread).
  for (const spec of COLLECTIONS) await seed(spec);
});

afterAll(async () => {
  await env.cleanup();
});

describe('every collection has rules and tests', () => {
  const rules = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
  const ruled = new Set(
    [...rules.matchAll(/match \/([A-Za-z]+)\/\{/g)].map((m) => m[1]).filter((name) => name !== 'databases'),
  );
  const tested = new Set(COLLECTIONS.map((spec) => spec.collection.split(' ')[0]));

  it('tests every collection that has a match block', () => {
    expect([...ruled].filter((name) => !tested.has(name)).sort()).toEqual([]);
  });

  it('has a match block for every tested collection', () => {
    expect([...tested].filter((name) => !ruled.has(name)).sort()).toEqual([]);
  });

  it('covers every collection in the domain model', () => {
    const paths = Object.values(ENTITY_FACTORIES).map(
      ([entity]) => (entity as { path: string }).path.split('/').at(-1) ?? '',
    );
    expect(paths.filter((name) => !tested.has(name)).sort()).toEqual([]);
  });
});

describe.each(COLLECTIONS)('$collection', (spec) => {
  const readers = rolesFor(spec.read);
  const writers = rolesFor(spec.update);
  const change = changeFor(spec);

  it.each(ROLES)('read as %s', async (role) => {
    const allowed = spec.read === 'owner' ? role === 'lawyer' : readers.includes(role);
    const read = getDoc(doc(db(env, role), spec.docPath));
    await (allowed ? assertSucceeds(read) : assertFails(read));
  });

  it.each(ROLES)('update a whitelisted field as %s', async (role) => {
    await seed(spec);
    const allowed = spec.update === 'owner' ? role === 'lawyer' : writers.includes(role);
    const update = updateDoc(doc(db(env, role), spec.docPath), stamped(change, uidFor(role)));
    await (allowed ? assertSucceeds(update) : assertFails(update));
  });

  it('denies another org', async () => {
    const other = db(env, 'owner', OTHER_ORG);
    if (spec.read === 'signed-in') {
      await assertSucceeds(getDoc(doc(other, spec.docPath)));
    } else {
      await assertFails(getDoc(doc(other, spec.docPath)));
    }
    await assertFails(updateDoc(doc(other, spec.docPath), stamped(change, uidFor('owner', OTHER_ORG))));
  });

  it('denies unauthenticated users', async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, spec.docPath)));
    await assertFails(updateDoc(doc(anon, spec.docPath), change));
  });

  it('denies a forbidden field change', async () => {
    await seed(spec);
    const role = writerFor(spec);
    const ref = doc(db(env, role), spec.docPath);
    await assertFails(updateDoc(ref, stamped({ ...change, createdBy: 'someone-else' }, uidFor(role))));
    await assertFails(updateDoc(ref, stamped({ schemaVersion: 99 }, uidFor(role))));
  });

  it('denies a missing or invalid updatedBy and a client-chosen updatedAt', async () => {
    await seed(spec);
    const role = writerFor(spec);
    const ref = doc(db(env, role), spec.docPath);
    await assertFails(updateDoc(ref, { ...change, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { ...change, updatedAt: serverTimestamp(), updatedBy: 'someone-else' }));
    await assertFails(updateDoc(ref, { ...change, updatedAt: Timestamp.fromMillis(0), updatedBy: uidFor(role) }));
  });

  it('denies client creates and hard deletes', async () => {
    // Saved views: their owner creates and deletes them (tested below); anyone else is still refused.
    const role = spec.ownerCreatesAndDeletes ? 'owner' : writerFor(spec);
    const firestore = db(env, role);
    await assertFails(setDoc(doc(firestore, `${spec.docPath}-new`), seedData(spec)));
    await assertFails(deleteDoc(doc(firestore, spec.docPath)));
  });
});

describe('privileged material', () => {
  const PRIVILEGED = `orgs/${ORG}/matters/matter-privileged`;

  beforeAll(async () => {
    await seedAdmin(env, async (firestore) => {
      await setDoc(doc(firestore, PRIVILEGED), {
        ...seedData(specFor('matters')),
        privileged: true,
      });
      await setDoc(doc(firestore, `${MATTER}/notes/privileged-note`), {
        ...seedData(specFor('notes')),
        privileged: true,
      });
    });
  });

  it.each(ROLES)('reading a privileged matter as %s follows privileged.view', async (role) => {
    const read = getDoc(doc(db(env, role), PRIVILEGED));
    await (['owner', 'admin', 'lawyer'].includes(role) ? assertSucceeds(read) : assertFails(read));
  });

  it('a suspended member is denied privileged reads at once, despite a valid claim', async () => {
    const suspended = db(env, 'lawyer', ORG, SUSPENDED_UID);
    await assertFails(getDoc(doc(suspended, PRIVILEGED)));
    await assertFails(getDoc(doc(suspended, `${MATTER}/notes/privileged-note`)));
  });

  it('a paralegal cannot mark a document privileged; a lawyer can', async () => {
    const DOCUMENT = `${MATTER}/documents/doc-1`;
    await seed(specFor('documents'));
    const paralegal = doc(db(env, 'paralegal'), DOCUMENT);
    await assertFails(updateDoc(paralegal, stamped({ privileged: true }, uidFor('paralegal'))));
    const lawyer = doc(db(env, 'lawyer'), DOCUMENT);
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: true }, uidFor('lawyer'))));
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: false }, uidFor('lawyer'))));
  });

  it('a lawyer can toggle a matter’s privileged flag; a paralegal cannot (CORE-06)', async () => {
    await seed(specFor('matters'));
    for (const role of ROLES) {
      const update = updateDoc(doc(db(env, role), MATTER), stamped({ privileged: true }, uidFor(role)));
      await (allows(role, 'matter.edit') && allows(role, 'privileged.view')
        ? assertSucceeds(update)
        : assertFails(update));
      await seed(specFor('matters'));
    }
    const lawyer = doc(db(env, 'lawyer'), MATTER);
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: true }, uidFor('lawyer'))));
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: false }, uidFor('lawyer'))));
    // The paralegal can still edit the matter, just not the flag.
    const paralegal = doc(db(env, 'paralegal'), MATTER);
    await assertFails(updateDoc(paralegal, stamped({ privileged: true }, uidFor('paralegal'))));
    await assertSucceeds(
      updateDoc(paralegal, stamped({ title: 'Estate of Fictional Whitfield' }, uidFor('paralegal'))),
    );
    await seed(specFor('matters'));
  });

  it('readonly can query non-privileged matters only', async () => {
    const readonly = db(env, 'readonly');
    await assertSucceeds(getDocs(query(collection(readonly, `orgs/${ORG}/matters`), where('privileged', '==', false))));
    await assertFails(getDocs(collection(readonly, `orgs/${ORG}/matters`)));
    // Regression: a filter on another field must not let privileged matters through.
    await assertFails(
      getDocs(query(collection(readonly, `orgs/${ORG}/matters`), where('title', '==', 'Estate of Margaret Whitfield'))),
    );
    await assertFails(
      getDocs(query(collection(db(env, 'paralegal'), `orgs/${ORG}/matters`), where('privileged', '==', true))),
    );
  });
});

describe('field-level rules', () => {
  const DEADLINE = `${MATTER}/deadlines/doc-1`;
  const TIME = `${MATTER}/timeEntries/entry-1`;
  const reseed = (name: string) => seed(specFor(name));

  it('overriding a deadline needs deadline.override', async () => {
    await reseed('deadlines');
    await assertFails(
      updateDoc(doc(db(env, 'paralegal'), DEADLINE), stamped({ override: { reason: 'x' } }, uidFor('paralegal'))),
    );
    await assertSucceeds(
      updateDoc(doc(db(env, 'lawyer'), DEADLINE), stamped({ override: { reason: 'x' } }, uidFor('lawyer'))),
    );
  });

  it('a paralegal edits only their own time entries and cannot reassign them', async () => {
    await seedAdmin(env, (f) =>
      setDoc(doc(f, TIME), {
        ...seedData(specFor('timeEntries')),
        uid: 'someone-else',
      }),
    );
    await assertFails(updateDoc(doc(db(env, 'paralegal'), TIME), stamped({ narrative: 'x' }, uidFor('paralegal'))));
    await reseed('timeEntries');
    await assertFails(
      updateDoc(doc(db(env, 'paralegal'), TIME), stamped({ uid: 'someone-else' }, uidFor('paralegal'))),
    );
  });

  it('billed time entries are immutable (invariant 5)', async () => {
    await seedAdmin(env, (f) => setDoc(doc(f, TIME), { ...seedData(specFor('timeEntries')), status: 'billed' }));
    await assertFails(updateDoc(doc(db(env, 'owner'), TIME), stamped({ narrative: 'x' }, uidFor('owner'))));
  });

  it('clerk suggestions: only proposed → dismissed', async () => {
    const ref = doc(db(env, 'lawyer'), `${MATTER}/suggestions/suggestion-1`);
    await reseed('suggestions');
    await assertFails(updateDoc(ref, stamped({ status: 'accepted' }, uidFor('lawyer'))));
    await assertSucceeds(updateDoc(ref, stamped({ status: 'dismissed' }, uidFor('lawyer'))));
    // Once dismissed, no further client transition.
    await assertFails(updateDoc(ref, stamped({ status: 'proposed' }, uidFor('lawyer'))));
  });

  it('issued invoices are read-only for clients', async () => {
    await seedAdmin(env, (f) =>
      setDoc(doc(f, `orgs/${ORG}/invoices/invoice-1`), {
        ...seedData(specFor('invoices')),
        status: 'issued',
      }),
    );
    await assertFails(
      updateDoc(
        doc(db(env, 'owner'), `orgs/${ORG}/invoices/invoice-1`),
        stamped({ dueDate: '2026-05-01' }, uidFor('owner')),
      ),
    );
  });

  it('a shared Clerk thread is readable by other members but only its owner edits it', async () => {
    const THREAD = `orgs/${ORG}/clerkThreads/thread-shared`;
    await seedAdmin(env, async (f) => {
      await setDoc(doc(f, THREAD), {
        ...seedData(specFor('clerkThreads')),
        shared: true,
      });
      await setDoc(doc(f, `${THREAD}/messages/m1`), seedData(specFor('messages')));
    });
    await assertSucceeds(getDoc(doc(db(env, 'paralegal'), THREAD)));
    await assertSucceeds(getDoc(doc(db(env, 'paralegal'), `${THREAD}/messages/m1`)));
    await assertFails(
      updateDoc(doc(db(env, 'paralegal'), THREAD), stamped({ title: 'Mine now' }, uidFor('paralegal'))),
    );
    await assertFails(getDoc(doc(db(env, 'readonly'), THREAD)));
  });

  it('notifications and personal tasks belong to one member', async () => {
    await assertFails(getDoc(doc(db(env, 'admin'), `orgs/${ORG}/notifications/notification-1`)));
    await assertFails(getDoc(doc(db(env, 'owner'), `orgs/${ORG}/members/${OWNER_UID}/tasks/task-1`)));
  });
});

describe('membership (FND-17)', () => {
  const REMOVED_UID = 'removed-a';
  const reads = (firestore: Firestore) => [
    getDoc(doc(firestore, `orgs/${ORG}`)),
    getDoc(doc(firestore, MATTER)),
    getDoc(doc(firestore, `orgs/${ORG}/members/${uidFor('owner')}`)),
    getDoc(doc(firestore, `orgs/${ORG}/contacts/doc-1`)),
    getDocs(query(collectionGroup(firestore, 'deadlines'), where('orgId', '==', ORG))),
  ];

  beforeAll(async () => {
    await seedAdmin(env, (f) =>
      setDoc(doc(f, `orgs/${ORG}/members/${REMOVED_UID}`), { role: 'admin', status: 'removed' }),
    );
  });

  it('a removed member loses access on their next request, though their token still names the org', async () => {
    for (const read of reads(db(env, 'admin', ORG, REMOVED_UID))) await assertFails(read);
    await assertFails(
      updateDoc(
        doc(db(env, 'admin', ORG, REMOVED_UID), `orgs/${ORG}/members/member-target`),
        stamped({ title: 'x' }, REMOVED_UID),
      ),
    );
  });

  it('a suspended member loses access too', async () => {
    for (const read of reads(db(env, 'lawyer', ORG, SUSPENDED_UID))) await assertFails(read);
  });

  it('a claim without a member document gets nothing', async () => {
    for (const read of reads(db(env, 'owner', ORG, 'never-a-member'))) await assertFails(read);
  });

  it('role and status change only through callables, even for owners', async () => {
    await seed(specFor('members'));
    const ref = doc(db(env, 'owner'), `orgs/${ORG}/members/member-target`);
    await assertFails(updateDoc(ref, stamped({ role: 'owner' }, uidFor('owner'))));
    await assertFails(updateDoc(ref, stamped({ status: 'removed' }, uidFor('owner'))));
    await assertFails(updateDoc(ref, stamped({ email: 'other@example.test' }, uidFor('owner'))));
    await assertSucceeds(updateDoc(ref, stamped({ title: 'Associate' }, uidFor('owner'))));
  });

  it('nobody promotes themselves', async () => {
    const ref = doc(db(env, 'admin'), `orgs/${ORG}/members/${uidFor('admin')}`);
    await assertFails(updateDoc(ref, stamped({ role: 'owner' }, uidFor('admin'))));
  });

  it('invites: managers read them and change only the role; the token hash and status are server-owned', async () => {
    await seed(specFor('invites'));
    const ref = doc(db(env, 'admin'), `orgs/${ORG}/invites/invite-1`);
    await assertSucceeds(getDoc(ref));
    await assertFails(getDoc(doc(db(env, 'lawyer'), `orgs/${ORG}/invites/invite-1`)));
    await assertFails(updateDoc(ref, stamped({ status: 'accepted' }, uidFor('admin'))));
    await assertFails(updateDoc(ref, stamped({ tokenHash: 'a'.repeat(64) }, uidFor('admin'))));
    await assertFails(updateDoc(ref, stamped({ expiresAt: Timestamp.fromMillis(Date.now() + 1e10) }, uidFor('admin'))));
    await assertSucceeds(updateDoc(ref, stamped({ role: 'lawyer' }, uidFor('admin'))));
  });

  it('the active org and memberships on users/{uid} are server-owned', async () => {
    await seed(specFor('users'));
    const ref = doc(db(env, 'lawyer'), `users/${uidFor('lawyer')}`);
    await assertFails(updateDoc(ref, stamped({ activeOrgId: OTHER_ORG }, uidFor('lawyer'))));
    await assertFails(
      updateDoc(ref, stamped({ memberships: { [OTHER_ORG]: { role: 'owner', name: 'X' } } }, uidFor('lawyer'))),
    );
    await assertFails(updateDoc(ref, stamped({ claimsVersion: 99 }, uidFor('lawyer'))));
    await assertSucceeds(updateDoc(ref, stamped({ displayName: 'Jordan P' }, uidFor('lawyer'))));
  });
});

describe('soft delete', () => {
  const softDelete = (uid: string) => ({
    deletedAt: serverTimestamp(),
    deletedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });

  it('matters: matter.delete roles soft delete; a paralegal cannot', async () => {
    await seed(specFor('matters'));
    await assertFails(updateDoc(doc(db(env, 'paralegal'), MATTER), softDelete(uidFor('paralegal'))));
    await assertSucceeds(updateDoc(doc(db(env, 'lawyer'), MATTER), softDelete(uidFor('lawyer'))));
    await seed(specFor('matters'));
  });

  it('tasks: soft delete must be stamped by the caller', async () => {
    const TASK = `${MATTER}/tasks/doc-1`;
    await seed(specFor('tasks'));
    const ref = doc(db(env, 'paralegal'), TASK);
    await assertFails(updateDoc(ref, { ...softDelete(uidFor('paralegal')), deletedBy: 'someone-else' }));
    await assertSucceeds(updateDoc(ref, softDelete(uidFor('paralegal'))));
  });
});

describe('collection groups', () => {
  beforeAll(async () => {
    await seedAdmin(env, async (f) => {
      const task = seedData(specFor('tasks'));
      await setDoc(doc(f, `orgs/${OTHER_ORG}/matters/m-b/tasks/t-b`), { ...task, orgId: OTHER_ORG, matterId: 'm-b' });
      await setDoc(doc(f, `orgs/${ORG}/members/${uidFor('admin')}/tasks/personal-admin`), {
        ...seedData(specFor('tasks (personal)')),
        assigneeUid: uidFor('admin'),
      });
    });
  });

  it('a member queries their org across matters', async () => {
    const firestore = db(env, 'paralegal');
    await assertSucceeds(getDocs(query(collectionGroup(firestore, 'deadlines'), where('orgId', '==', ORG))));
    await assertSucceeds(getDocs(query(collectionGroup(firestore, 'timeEntries'), where('orgId', '==', ORG))));
  });

  // CORE-08 (ADR-026): tasks follow matter access, which a group query can't check per matter.
  it('every matter’s tasks through the group need privileged.view; my own are always mine', async () => {
    const byMatter = (firestore: Firestore) =>
      getDocs(
        query(collectionGroup(firestore, 'tasks'), where('orgId', '==', ORG), where('matterId', '==', 'matter-1')),
      );
    await assertSucceeds(byMatter(db(env, 'lawyer')));
    await assertFails(byMatter(db(env, 'paralegal')));
    await assertFails(byMatter(db(env, 'readonly')));
    for (const role of ['paralegal', 'readonly'] as const) {
      await assertSucceeds(
        getDocs(
          query(
            collectionGroup(db(env, role), 'tasks'),
            where('orgId', '==', ORG),
            where('assigneeUid', '==', uidFor(role)),
          ),
        ),
      );
    }
  });

  it('"my tasks" includes my personal tasks', async () => {
    const firestore = db(env, 'lawyer');
    await assertSucceeds(
      getDocs(
        query(collectionGroup(firestore, 'tasks'), where('orgId', '==', ORG), where('assigneeUid', '==', OWNER_UID)),
      ),
    );
  });

  it('denies querying another org, or every task without an org filter', async () => {
    const firestore = db(env, 'owner');
    await assertFails(getDocs(query(collectionGroup(firestore, 'tasks'), where('orgId', '==', OTHER_ORG))));
    await assertFails(getDocs(query(collectionGroup(firestore, 'deadlines'), where('orgId', '==', OTHER_ORG))));
    await assertFails(getDocs(collectionGroup(firestore, 'timeEntries')));
  });

  it("denies reading another member's personal task through the group", async () => {
    const firestore = db(env, 'lawyer');
    await assertFails(
      getDocs(
        query(
          collectionGroup(firestore, 'tasks'),
          where('orgId', '==', ORG),
          where('assigneeUid', '==', uidFor('admin')),
        ),
      ),
    );
  });
});

describe('batched writes', () => {
  it('a batch of 10 task updates succeeds', async () => {
    const task = specFor('tasks');
    await seedAdmin(env, async (f) => {
      for (let i = 0; i < 10; i++) await setDoc(doc(f, `${MATTER}/tasks/batch-${i}`), seedData(task));
    });
    const firestore: Firestore = db(env, 'paralegal');
    const batch = writeBatch(firestore);
    for (let i = 0; i < 10; i++) {
      batch.update(doc(firestore, `${MATTER}/tasks/batch-${i}`), stamped({ order: i }, uidFor('paralegal')));
    }
    await assertSucceeds(batch.commit());
  });
});

describe('contacts (CORE-01)', () => {
  const CONTACT = `orgs/${ORG}/contacts/contact-1`;
  const TOMBSTONE = `orgs/${ORG}/contacts/contact-tombstone`;

  const inOrg = isMember;
  const canEdit = (who: Who) => allows(who, 'contact.edit');
  const canDelete = (who: Who) => allows(who, 'contact.delete');
  const softDeleteBy = (uid: string) => ({
    deletedAt: serverTimestamp(),
    deletedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });

  const reseed = () =>
    seedAdmin(env, async (f) => {
      await setDoc(doc(f, CONTACT), seedData(specFor('contacts')));
      await setDoc(doc(f, TOMBSTONE), {
        ...seedData(specFor('contacts')),
        mergedInto: 'contact-1',
        deletedAt: Timestamp.now(),
        deletedBy: uidFor('admin'),
      });
    });

  beforeEach(reseed);

  it.each(EVERYONE)('read as %s', async (who) => {
    const read = getDoc(doc(firestoreOf(who).firestore, CONTACT));
    await (inOrg(who) ? assertSucceeds(read) : assertFails(read));
  });

  it.each(EVERYONE)('whitelisted update as %s follows contact.edit', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const update = updateDoc(
      doc(firestore, CONTACT),
      stamped({ preferredName: 'Peggy', tags: ['client'], isReferrer: true }, uid),
    );
    await (canEdit(who) ? assertSucceeds(update) : assertFails(update));
  });

  it.each(EVERYONE)('server-owned fields are refused as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, CONTACT);
    await assertFails(updateDoc(ref, stamped({ search: ['zz'] }, uid)));
    await assertFails(updateDoc(ref, stamped({ dedupeKey: 'person:x|' }, uid)));
    await assertFails(updateDoc(ref, stamped({ sortName: 'aaa' }, uid)));
    await assertFails(updateDoc(ref, stamped({ mergedInto: 'contact-2' }, uid)));
    await assertFails(updateDoc(ref, stamped({ givenNames: 'Peg', sortName: 'peg' }, uid)));
  });

  it.each(EVERYONE)('soft delete as %s follows contact.delete', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const remove = updateDoc(doc(firestore, CONTACT), softDeleteBy(uid));
    await (canDelete(who) ? assertSucceeds(remove) : assertFails(remove));
  });

  it.each(EVERYONE)('create is refused as %s (contacts-create only)', async (who) => {
    const { firestore } = firestoreOf(who);
    await assertFails(setDoc(doc(firestore, `orgs/${ORG}/contacts/contact-new`), seedData(specFor('contacts'))));
  });

  it.each(EVERYONE)('a merge tombstone is not editable or restorable as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, TOMBSTONE);
    await assertFails(updateDoc(ref, stamped({ preferredName: 'Back again' }, uid)));
    await assertFails(
      updateDoc(ref, { deletedAt: null, deletedBy: null, updatedAt: serverTimestamp(), updatedBy: uid }),
    );
    // Still readable in the org (old links resolve to it and follow mergedInto).
    const read = getDoc(ref);
    await (inOrg(who) ? assertSucceeds(read) : assertFails(read));
  });

  describe('parties collection group', () => {
    beforeAll(async () => {
      await seedAdmin(env, async (f) => {
        const party = seedData(specFor('parties'));
        await setDoc(doc(f, `${MATTER}/parties/p-contact-1`), { ...party, contactId: 'contact-1' });
        await setDoc(doc(f, `orgs/${OTHER_ORG}/matters/m-b/parties/p-b`), {
          ...party,
          orgId: OTHER_ORG,
          matterId: 'm-b',
          contactId: 'contact-1',
        });
      });
    });

    const byContact = (firestore: Firestore, orgId: string) =>
      getDocs(
        query(
          collectionGroup(firestore, 'parties'),
          where('orgId', '==', orgId),
          where('contactId', '==', 'contact-1'),
        ),
      );

    it.each(EVERYONE)('"the matters this contact is on" as %s', async (who) => {
      const { firestore } = firestoreOf(who);
      await (inOrg(who) ? assertSucceeds(byContact(firestore, ORG)) : assertFails(byContact(firestore, ORG)));
    });

    it('denies another org’s parties, and a query without the org filter', async () => {
      const firestore = db(env, 'owner');
      await assertFails(byContact(firestore, OTHER_ORG));
      await assertFails(getDocs(query(collectionGroup(firestore, 'parties'), where('contactId', '==', 'contact-1'))));
    });
  });
});

describe('matters (CORE-03)', () => {
  const DELETED = `orgs/${ORG}/matters/matter-deleted`;
  const deleteBy = (uid: string) => ({
    deletedAt: serverTimestamp(),
    deletedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });

  beforeEach(() =>
    seedAdmin(env, async (f) => {
      await setDoc(doc(f, MATTER), {
        ...seedData(specFor('matters')),
        deletedAt: null,
        lastActivityAt: Timestamp.now(),
      });
      await setDoc(doc(f, DELETED), {
        ...seedData(specFor('matters')),
        deletedAt: Timestamp.now(),
        deletedBy: uidFor('lawyer'),
      });
    }),
  );

  it.each(EVERYONE)('read as %s', async (who) => {
    const read = getDoc(doc(firestoreOf(who).firestore, MATTER));
    await (isMember(who) ? assertSucceeds(read) : assertFails(read));
  });

  it.each(EVERYONE)('whitelisted update as %s follows matter.edit', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const update = updateDoc(
      doc(firestore, MATTER),
      stamped(
        {
          title: 'Estate of Fictional Whitfield',
          labels: ['urgent'],
          priority: 'high',
          responsibleUid: uidFor('lawyer'),
          teamUids: [uidFor('paralegal')],
          externalRef: 'LEG-0042',
          estate: { grossValueCents: 100, grantDate: '2026-05-01', grantNo: 'S PRB 2026 0042' },
          facts: { willDate: '2019-03-14', courtFileNo: 'S ECI 2026 01234' },
          deceased: {
            contactId: 'contact-2',
            dateOfDeath: '2026-01-02',
            domicile: 'VIC',
            lastAddress: 'Geelong VIC',
          },
        },
        uid,
      ),
    );
    await (allows(who, 'matter.edit') ? assertSucceeds(update) : assertFails(update));
  });

  it.each(EVERYONE)('status, number and server-owned fields are refused as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, MATTER);
    for (const change of [
      { status: 'closed' },
      { number: 'M-2026-9999' },
      { conflictCheck: { status: 'potential' } },
      { conflictCheck: { status: 'clear', checkedBy: uid } },
      { conflictAlert: { checkId: 'check-1', contactId: 'contact-1', at: serverTimestamp(), adverse: false } },
      { closedAt: serverTimestamp() },
      { search: ['zz'] },
      { lastActivityAt: serverTimestamp() },
      { type: 'will' },
      { clientContactIds: ['contact-2'] },
      // The stage moves through matters-changeStage (CORE-06).
      { stageId: 'grant_issued' },
      { title: 'Allowed', stageId: 'grant_issued' },
      { title: 'Allowed', status: 'archived' },
    ]) {
      await assertFails(updateDoc(ref, stamped(change, uid)));
    }
  });

  it.each(EVERYONE)('soft delete as %s follows matter.delete', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const remove = updateDoc(doc(firestore, MATTER), deleteBy(uid));
    await (allows(who, 'matter.delete') ? assertSucceeds(remove) : assertFails(remove));
  });

  it.each(EVERYONE)('a deleted matter is frozen; only matters-restore restores it (as %s)', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, DELETED);
    await assertFails(
      updateDoc(ref, { deletedAt: null, deletedBy: null, updatedAt: serverTimestamp(), updatedBy: uid }),
    );
    await assertFails(updateDoc(ref, stamped({ title: 'Edited while deleted' }, uid)));
    await assertFails(updateDoc(ref, deleteBy(uid)));
  });

  it('a soft delete must be stamped by the caller and change nothing else', async () => {
    const ref = doc(db(env, 'lawyer'), MATTER);
    await assertFails(updateDoc(ref, { ...deleteBy(uidFor('lawyer')), deletedBy: 'someone-else' }));
    await assertFails(updateDoc(ref, { ...deleteBy(uidFor('lawyer')), deletedAt: Timestamp.fromMillis(0) }));
    await assertFails(updateDoc(ref, { ...deleteBy(uidFor('lawyer')), title: 'And a rename' }));
  });

  it('the list query (live, by status, newest activity first) is allowed; readonly must exclude privileged', async () => {
    const list = (firestore: Firestore, ...filters: ReturnType<typeof where>[]) =>
      getDocs(
        query(
          collection(firestore, `orgs/${ORG}/matters`),
          where('deletedAt', '==', null),
          where('status', 'in', ['open', 'on_hold']),
          ...filters,
          orderBy('lastActivityAt', 'desc'),
          limit(50),
        ),
      );
    await assertSucceeds(list(db(env, 'lawyer')));
    await assertSucceeds(list(db(env, 'readonly'), where('privileged', '==', false)));
    await assertFails(list(db(env, 'readonly')));
    await assertFails(list(db(env, 'owner', OTHER_ORG)));
  });

  it('clients record key facts and the deceased directly (CORE-06)', async () => {
    const paralegal = doc(db(env, 'paralegal'), MATTER);
    const uid = uidFor('paralegal');
    await assertSucceeds(updateDoc(paralegal, stamped({ facts: { willDate: '2019-03-14' } }, uid)));
    await assertSucceeds(updateDoc(paralegal, stamped({ facts: { courtFileNo: 'S ECI 2026 01234' } }, uid)));
    await assertSucceeds(
      updateDoc(
        paralegal,
        stamped(
          {
            deceased: {
              contactId: 'contact-2',
              dateOfDeath: '2026-01-02',
              domicile: 'VIC',
              lastAddress: 'Geelong VIC',
            },
          },
          uid,
        ),
      ),
    );
    await assertSucceeds(updateDoc(paralegal, stamped({ estate: { grantDate: '2026-05-01' } }, uid)));
    const readonly = doc(db(env, 'readonly'), MATTER);
    await assertFails(updateDoc(readonly, stamped({ facts: { willDate: '2019-03-14' } }, uidFor('readonly'))));
  });

  it.each(EVERYONE)('stageId and clientContactIds are refused as %s (CORE-06)', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, MATTER);
    await assertFails(updateDoc(ref, stamped({ stageId: 'grant_application' }, uid)));
    await assertFails(updateDoc(ref, stamped({ clientContactIds: ['contact-1', 'contact-2'] }, uid)));
  });

  describe('parties (CORE-06)', () => {
    const PARTY = `${MATTER}/parties/client-contact-1`;
    beforeEach(() =>
      seedAdmin(env, (f) =>
        setDoc(doc(f, PARTY), { ...seedData(specFor('parties')), contactId: 'contact-1', role: 'client' }),
      ),
    );

    it.each(ROLES)('share and notes follow matter.edit, as %s', async (role) => {
      const update = updateDoc(
        doc(db(env, role), PARTY),
        stamped({ share: 'One half', notes: 'Prefers email' }, uidFor(role)),
      );
      await (allows(role, 'matter.edit') ? assertSucceeds(update) : assertFails(update));
    });

    it.each(ROLES)('role, contact and soft delete go through the callables, as %s', async (role) => {
      const ref = doc(db(env, role), PARTY);
      const uid = uidFor(role);
      await assertFails(updateDoc(ref, stamped({ role: 'beneficiary' }, uid)));
      await assertFails(updateDoc(ref, stamped({ contactId: 'contact-2' }, uid)));
      await assertFails(updateDoc(ref, stamped({ addedFrom: 'clerk' }, uid)));
      await assertFails(
        updateDoc(ref, { deletedAt: serverTimestamp(), deletedBy: uid, updatedAt: serverTimestamp(), updatedBy: uid }),
      );
    });
  });

  it.each(ROLES)('counters and number reservations are server-only, as %s', async (role) => {
    const firestore = db(env, role);
    await assertFails(getDoc(doc(firestore, `orgs/${ORG}/counters/matter-2026`)));
    await assertFails(getDoc(doc(firestore, `orgs/${ORG}/matterNumbers/M-2026-0042`)));
    await assertFails(setDoc(doc(firestore, `orgs/${ORG}/counters/matter-2027`), { next: 1 }));
    await assertFails(
      setDoc(doc(firestore, `orgs/${ORG}/matterNumbers/M-2027-0001`), { number: 'M-2027-0001', matterId: 'x' }),
    );
  });
});

describe('conflict checks (CORE-02)', () => {
  const CHECK = `orgs/${ORG}/conflictChecks/check-1`;
  const NOTE = `orgs/${ORG}/notifications/conflict-alert-1`;

  beforeAll(() =>
    seedAdmin(env, async (f) => {
      await setDoc(doc(f, CHECK), seedData(specFor('conflictChecks')));
      await setDoc(doc(f, NOTE), {
        ...seedData(specFor('notifications')),
        kind: 'conflict_alert',
        matterId: 'matter-1',
        checkId: 'check-1',
        contactId: 'contact-1',
        recipientUid: uidFor('lawyer'),
        priority: 'high',
      });
    }),
  );

  it.each(EVERYONE)('a check is read by conflict.run roles only, as %s', async (who) => {
    const read = getDoc(doc(firestoreOf(who).firestore, CHECK));
    await (allows(who, 'conflict.run') ? assertSucceeds(read) : assertFails(read));
  });

  it.each(EVERYONE)('a check is never written by a client, as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    await assertFails(
      setDoc(doc(firestore, `orgs/${ORG}/conflictChecks/check-new`), seedData(specFor('conflictChecks'))),
    );
    await assertFails(updateDoc(doc(firestore, CHECK), stamped({ hits: [] }, uid)));
    await assertFails(updateDoc(doc(firestore, CHECK), stamped({ adverseRolesChecked: true }, uid)));
    await assertFails(deleteDoc(doc(firestore, CHECK)));
  });

  it('lists checks for conflict.run roles; readonly and other orgs are refused', async () => {
    const list = (firestore: Firestore) =>
      getDocs(query(collection(firestore, `orgs/${ORG}/conflictChecks`), limit(10)));
    await assertSucceeds(list(db(env, 'paralegal')));
    await assertSucceeds(list(db(env, 'owner')));
    await assertFails(list(db(env, 'readonly')));
    await assertFails(list(db(env, 'owner', OTHER_ORG)));
  });

  it.each(EVERYONE)(
    'a conflict alert notification is read and marked read by its recipient only, as %s',
    async (who) => {
      const { firestore, uid } = firestoreOf(who);
      const mine = who === 'lawyer';
      const read = getDoc(doc(firestore, NOTE));
      await (mine ? assertSucceeds(read) : assertFails(read));
      const markRead = updateDoc(doc(firestore, NOTE), stamped({ readAt: serverTimestamp() }, uid));
      await (mine ? assertSucceeds(markRead) : assertFails(markRead));
      await assertFails(updateDoc(doc(firestore, NOTE), stamped({ priority: 'normal' }, uid)));
    },
  );
});

describe('matter templates (CORE-07)', () => {
  const TEMPLATE = `orgs/${ORG}/templates/template-1`;
  const VERSION = `${TEMPLATE}/versions/1`;

  beforeAll(() =>
    seedAdmin(env, async (f) => {
      await setDoc(doc(f, TEMPLATE), seedData(specFor('templates')));
      await setDoc(doc(f, VERSION), seedData(specFor('versions (templates)')));
    }),
  );

  it.each(EVERYONE)('a template and its versions are read by members only, as %s', async (who) => {
    const { firestore } = firestoreOf(who);
    for (const path of [TEMPLATE, VERSION]) {
      const read = getDoc(doc(firestore, path));
      await (isMember(who) ? assertSucceeds(read) : assertFails(read));
    }
  });

  it('lists templates and versions for members; other orgs are refused', async () => {
    const list = (firestore: Firestore, path: string) => getDocs(query(collection(firestore, path), limit(10)));
    await assertSucceeds(list(db(env, 'readonly'), `orgs/${ORG}/templates`));
    await assertSucceeds(list(db(env, 'paralegal'), `${TEMPLATE}/versions`));
    await assertFails(list(db(env, 'owner', OTHER_ORG), `orgs/${ORG}/templates`));
    await assertFails(list(db(env, 'owner', OTHER_ORG), `${TEMPLATE}/versions`));
  });

  it.each(EVERYONE)('templates are never written by a client, even an owner, as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    await assertFails(setDoc(doc(firestore, `orgs/${ORG}/templates/template-new`), seedData(specFor('templates'))));
    await assertFails(updateDoc(doc(firestore, TEMPLATE), stamped({ name: 'Renamed' }, uid)));
    await assertFails(updateDoc(doc(firestore, TEMPLATE), stamped({ published: true, version: 9 }, uid)));
    await assertFails(deleteDoc(doc(firestore, TEMPLATE)));
    await assertFails(setDoc(doc(firestore, `${TEMPLATE}/versions/2`), seedData(specFor('versions (templates)'))));
    await assertFails(updateDoc(doc(firestore, VERSION), stamped({ name: 'Rewritten' }, uid)));
    await assertFails(deleteDoc(doc(firestore, VERSION)));
  });
});

describe('saved views (CORE-03)', () => {
  const viewsOf = (uid: string) => `users/${uid}/views`;
  /** A new view as the client writes it. */
  const newView = (uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    orgId: ORG,
    list: 'matters',
    name: 'My urgent probates',
    filters: { status: ['open'], type: ['probate'], responsible: 'me' },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });

  it.each(EVERYONE)('create, read, rename and delete my own view as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, `${viewsOf(uid)}/mine`);
    const create = setDoc(ref, newView(uid));
    // Every member (readonly included) saves views in their org; the outsider's claim names another
    // org, and a suspended member is out of the org.
    if (!isMember(who)) {
      await assertFails(create);
      return;
    }
    await assertSucceeds(create);
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(collection(firestore, viewsOf(uid))));
    await assertSucceeds(updateDoc(ref, stamped({ name: 'Renamed', groupBy: 'status' }, uid)));
    await assertSucceeds(deleteDoc(ref));
  });

  it.each(ROLES)("someone else's views are off limits, as %s", async (role) => {
    const other = role === 'lawyer' ? uidFor('owner') : uidFor('lawyer');
    await seedAdmin(env, (f) =>
      setDoc(doc(f, `${viewsOf(other)}/theirs`), { ...seedData(specFor('views')), createdBy: other }),
    );
    const firestore = db(env, role);
    const ref = doc(firestore, `${viewsOf(other)}/theirs`);
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(firestore, viewsOf(other))));
    await assertFails(updateDoc(ref, stamped({ name: 'Mine now' }, uidFor(role))));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(doc(firestore, `${viewsOf(other)}/planted`), newView(uidFor(role))));
  });

  it('refuses an invalid view', async () => {
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), `${viewsOf(uid)}/bad`);
    for (const bad of [
      { orgId: OTHER_ORG },
      { list: 'contacts' },
      { name: '' },
      { name: 'x'.repeat(61) },
      { name: 42 },
      { filters: 'open' },
      { sort: 'newest' },
      { groupBy: 'colour' },
      { createdBy: 'someone-else' },
      { updatedBy: 'someone-else' },
      { createdAt: Timestamp.fromMillis(0) },
      { schemaVersion: 2 },
      { shared: true },
    ]) {
      await assertFails(setDoc(ref, newView(uid, bad)));
    }
    const incomplete = newView(uid);
    delete incomplete['groupBy'];
    await assertFails(setDoc(ref, incomplete));
  });

  it('an update keeps the view valid, in my org, with only whitelisted fields', async () => {
    const uid = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), `${viewsOf(uid)}/view-1`);
    await seed(specFor('views'));
    await assertFails(updateDoc(ref, stamped({ orgId: OTHER_ORG }, uid)));
    await assertFails(updateDoc(ref, stamped({ name: '' }, uid)));
    await assertFails(updateDoc(ref, stamped({ createdBy: 'someone-else' }, uid)));
    await assertFails(updateDoc(ref, { name: 'No meta' }));
    await assertSucceeds(updateDoc(ref, stamped({ filters: { label: 'urgent' } }, uid)));
  });
});

describe('intake drafts (CORE-05)', () => {
  const draftsOf = (uid: string) => `users/${uid}/drafts`;
  const DAY = 86_400_000;
  const expiring = (days = 30) => Timestamp.fromMillis(Date.now() + days * DAY);
  /** A draft save as the client writes it (fictional form state). */
  const newDraft = (uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    orgId: ORG,
    kind: 'intake',
    step: 'clients',
    stateJson: JSON.stringify({
      type: { type: 'probate', jurisdiction: 'VIC' },
      clients: { clientContactIds: ['c-1'] },
    }),
    expireAt: expiring(),
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });

  it.each(EVERYONE)('create, read, resave and delete my own draft as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, `${draftsOf(uid)}/intake-mine`);
    const create = setDoc(ref, newDraft(uid));
    // Every member can draft a matter in their org; the outsider's claim names another org, and a
    // suspended member is out of the org.
    if (!isMember(who)) {
      await assertFails(create);
      return;
    }
    await assertSucceeds(create);
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(collection(firestore, draftsOf(uid))));
    await assertSucceeds(
      updateDoc(ref, stamped({ step: 'fees', stateJson: '{"fees":{}}', expireAt: expiring() }, uid)),
    );
    await assertSucceeds(deleteDoc(ref));
  });

  it.each(ROLES)("someone else's drafts are off limits, as %s", async (role) => {
    const other = role === 'lawyer' ? uidFor('owner') : uidFor('lawyer');
    await seedAdmin(env, (f) =>
      setDoc(doc(f, `${draftsOf(other)}/intake-theirs`), { ...seedData(specFor('drafts')), createdBy: other }),
    );
    const firestore = db(env, role);
    const ref = doc(firestore, `${draftsOf(other)}/intake-theirs`);
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(firestore, draftsOf(other))));
    await assertFails(updateDoc(ref, stamped({ step: 'review', expireAt: expiring() }, uidFor(role))));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(doc(firestore, `${draftsOf(other)}/intake-planted`), newDraft(uidFor(role))));
  });

  it('limits the form state to 100,000 characters', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const padded = (size: number) => JSON.stringify({ notes: 'x'.repeat(size - 12) });
    expect(padded(100_000)).toHaveLength(100_000);
    await assertSucceeds(
      setDoc(doc(firestore, `${draftsOf(uid)}/intake-big`), newDraft(uid, { stateJson: padded(100_000) })),
    );
    await assertFails(
      updateDoc(
        doc(firestore, `${draftsOf(uid)}/intake-big`),
        stamped({ stateJson: padded(100_001), expireAt: expiring() }, uid),
      ),
    );
    await assertFails(
      setDoc(doc(firestore, `${draftsOf(uid)}/intake-huge`), newDraft(uid, { stateJson: padded(100_001) })),
    );
  });

  it('refuses an invalid draft', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const ref = doc(firestore, `${draftsOf(uid)}/intake-bad`);
    for (const bad of [
      { orgId: OTHER_ORG },
      { kind: 'contact' },
      { step: 'payment' },
      { stateJson: { type: 'probate' } },
      { expireAt: expiring(90) },
      { expireAt: expiring(1) },
      { expireAt: '2026-11-01' },
      { createdBy: 'someone-else' },
      { updatedBy: 'someone-else' },
      { createdAt: Timestamp.fromMillis(0) },
      { schemaVersion: 2 },
      { sharedWith: ['someone-else'] },
    ]) {
      await assertFails(setDoc(ref, newDraft(uid, bad)));
    }
    const incomplete = newDraft(uid);
    delete incomplete['expireAt'];
    await assertFails(setDoc(ref, incomplete));
    // Only `intake-{id}` documents.
    await assertFails(setDoc(doc(firestore, `${draftsOf(uid)}/other-1`), newDraft(uid)));
    await assertFails(setDoc(doc(firestore, `${draftsOf(uid)}/intake-`), newDraft(uid)));
  });

  it('a resave keeps the draft valid, with a fresh expiry and only whitelisted fields', async () => {
    const uid = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), `${draftsOf(uid)}/intake-draft-1`);
    await seed(specFor('drafts'));
    // The seeded draft's expiry is long past: a save must move it on.
    await assertFails(updateDoc(ref, stamped({ step: 'review' }, uid)));
    await assertFails(updateDoc(ref, stamped({ orgId: OTHER_ORG, expireAt: expiring() }, uid)));
    await assertFails(updateDoc(ref, stamped({ createdBy: 'someone-else', expireAt: expiring() }, uid)));
    await assertFails(updateDoc(ref, { step: 'review', expireAt: expiring() }));
    await assertSucceeds(updateDoc(ref, stamped({ step: 'review', expireAt: expiring() }, uid)));
  });
});

describe('tasks (CORE-08)', () => {
  const PRIVILEGED_MATTER = `orgs/${ORG}/matters/matter-tasks-privileged`;
  const DELETED_MATTER = `orgs/${ORG}/matters/matter-tasks-deleted`;
  const TASK = `${MATTER}/tasks/doc-1`;
  const LAWYER = uidFor('lawyer');
  const personalPath = (owner: string, id: string) => `orgs/${ORG}/members/${owner}/tasks/${id}`;

  /** A valid client create of a matter task, stamped for `uid`. */
  const newTask = (uid: string, matterId = 'matter-1', extra: Record<string, unknown> = {}) => ({
    title: 'Request bank valuation letters',
    status: 'todo',
    priority: 'high',
    dueDate: '2026-10-20',
    assigneeUid: uid,
    checklist: [{ id: 'c1', text: 'Fictional Bank', done: false }],
    order: 1024,
    source: 'manual',
    countedOpen: false,
    orgId: ORG,
    matterId,
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });
  const newPersonal = (uid: string, extra: Record<string, unknown> = {}) =>
    newTask(uid, 'unused', { matterId: null, ...extra });

  beforeAll(async () => {
    await seedAdmin(env, async (f) => {
      const matter = seedData(specFor('matters'));
      await setDoc(doc(f, PRIVILEGED_MATTER), { ...matter, privileged: true });
      await setDoc(doc(f, `${PRIVILEGED_MATTER}/tasks/t-1`), {
        ...seedData(specFor('tasks')),
        matterId: 'matter-tasks-privileged',
      });
      await setDoc(doc(f, DELETED_MATTER), { ...matter, deletedAt: Timestamp.fromMillis(1), deletedBy: 'x' });
      await setDoc(doc(f, `${DELETED_MATTER}/tasks/t-1`), {
        ...seedData(specFor('tasks')),
        matterId: 'matter-tasks-deleted',
      });
    });
  });

  it('the create whitelist matches MatterTaskCreateInput in libs/domain', () => {
    const rules = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
    const listed = /function taskCreateFields\(\) \{\s*return \[([^\]]*)\]/.exec(rules)?.[1] ?? '';
    const fields = [...listed.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(fields.sort()).toEqual(Object.keys(MatterTaskCreateInput.shape).sort());
  });

  it.each(ROLES)('creating a matter task as %s follows task.edit', async (role) => {
    const uid = uidFor(role);
    const create = setDoc(doc(db(env, role), `${MATTER}/tasks/new-${role}`), newTask(uid));
    await (allows(role, 'task.edit') ? assertSucceeds(create) : assertFails(create));
  });

  it('a create needs the path’s org and matter, a manual source and valid values', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const attempt = (id: string, extra: Record<string, unknown>) =>
      assertFails(setDoc(doc(firestore, `${MATTER}/tasks/${id}`), newTask(uid, 'matter-1', extra)));
    await attempt('bad-org', { orgId: OTHER_ORG });
    await attempt('bad-matter', { matterId: 'matter-2' });
    await attempt('template', { source: 'template' });
    await attempt('completed', { completedAt: serverTimestamp() });
    await attempt('counted', { countedOpen: true });
    const { countedOpen: _counted, ...unmarked } = newTask(uid);
    await assertFails(setDoc(doc(firestore, `${MATTER}/tasks/unmarked`), unmarked));
    await attempt('tpl-key', { templateTaskKey: 'obtain_death_certificate' });
    await attempt('blank', { title: '   ' });
    await attempt('long', { title: 'x'.repeat(501) });
    await attempt('status', { status: 'waiting' });
    await attempt('priority', { priority: 'p1' });
    await attempt('date', { dueDate: '20/10/2026' });
    await attempt('order', { order: '1' });
    await attempt('checklist', { checklist: 'none' });
    await attempt('group', { group: 'g'.repeat(121) });
    await attempt('assignee', { assigneeUid: '' });
    await attempt('creator', { createdBy: 'someone-else' });
    await attempt('created-at', { createdAt: Timestamp.fromMillis(0) });
    await attempt('version', { schemaVersion: 2 });
    const { status: _status, ...withoutStatus } = newTask(uid);
    await assertFails(setDoc(doc(firestore, `${MATTER}/tasks/no-status`), withoutStatus));
    // The minimum: no due date, assignee, description or group.
    const minimal = newTask(uid, 'matter-1', { order: 2 });
    delete (minimal as Record<string, unknown>)['dueDate'];
    delete (minimal as Record<string, unknown>)['assigneeUid'];
    await assertSucceeds(setDoc(doc(firestore, `${MATTER}/tasks/minimal`), minimal));
    await assertSucceeds(
      setDoc(
        doc(firestore, `${MATTER}/tasks/full`),
        newTask(uid, 'matter-1', { descriptionMd: 'Fictional notes', deadlineId: 'dl-1', group: 'Grant' }),
      ),
    );
  });

  it('privileged matters: tasks follow privileged.view', async () => {
    for (const role of ROLES) {
      const read = getDoc(doc(db(env, role), `${PRIVILEGED_MATTER}/tasks/t-1`));
      await (allows(role, 'privileged.view') ? assertSucceeds(read) : assertFails(read));
    }
    const paralegal = db(env, 'paralegal');
    await assertFails(getDocs(collection(paralegal, `${PRIVILEGED_MATTER}/tasks`)));
    await assertFails(
      setDoc(
        doc(paralegal, `${PRIVILEGED_MATTER}/tasks/p-new`),
        newTask(uidFor('paralegal'), 'matter-tasks-privileged'),
      ),
    );
    await assertFails(
      updateDoc(doc(paralegal, `${PRIVILEGED_MATTER}/tasks/t-1`), stamped({ status: 'done' }, uidFor('paralegal'))),
    );
    const lawyer = db(env, 'lawyer');
    await assertSucceeds(getDocs(collection(lawyer, `${PRIVILEGED_MATTER}/tasks`)));
    await assertSucceeds(
      setDoc(doc(lawyer, `${PRIVILEGED_MATTER}/tasks/l-new`), newTask(LAWYER, 'matter-tasks-privileged')),
    );
  });

  it('a deleted matter’s tasks are frozen', async () => {
    const lawyer = db(env, 'lawyer');
    await assertFails(setDoc(doc(lawyer, `${DELETED_MATTER}/tasks/new`), newTask(LAWYER, 'matter-tasks-deleted')));
    await assertFails(updateDoc(doc(lawyer, `${DELETED_MATTER}/tasks/t-1`), stamped({ status: 'done' }, LAWYER)));
  });

  it('updates the whitelisted fields with valid values only', async () => {
    await seed(specFor('tasks'));
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), TASK);
    await assertSucceeds(
      updateDoc(
        ref,
        stamped(
          {
            title: 'Renamed',
            status: 'in_progress',
            priority: 'urgent',
            assigneeUid: uidFor('lawyer'),
            dueDate: '2026-11-02',
            checklist: [{ id: 'c1', text: 'Fictional item', done: true }],
            order: 1536.5,
            group: 'Estate administration',
          },
          uid,
        ),
      ),
    );
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), dueDate: deleteField(), assigneeUid: deleteField() }));
    await assertFails(updateDoc(ref, stamped({ status: 'waiting' }, uid)));
    await assertFails(updateDoc(ref, stamped({ title: '' }, uid)));
    await assertFails(updateDoc(ref, stamped({ dueDate: 'tomorrow' }, uid)));
    await assertFails(updateDoc(ref, stamped({ descriptionMd: 'Not editable here' }, uid)));
    await assertFails(updateDoc(ref, stamped({ deadlineId: 'dl-2' }, uid)));
    await assertFails(updateDoc(ref, stamped({ source: 'clerk' }, uid)));
    await assertFails(updateDoc(ref, stamped({ completedAt: serverTimestamp() }, uid)));
    await assertFails(updateDoc(ref, stamped({ countedOpen: false }, uid)));
    await assertFails(updateDoc(ref, stamped({ matterId: 'matter-2' }, uid)));
  });

  it('soft delete and restore, never a hard delete', async () => {
    await seed(specFor('tasks'));
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), TASK);
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: uid }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: null, deletedBy: null }));
    await assertFails(deleteDoc(ref));
    await assertFails(
      updateDoc(doc(db(env, 'readonly'), TASK), {
        ...stamped({}, uidFor('readonly')),
        deletedAt: serverTimestamp(),
        deletedBy: uidFor('readonly'),
      }),
    );
  });

  describe('personal tasks', () => {
    it('their owner creates them, assigned to themselves, with matterId null', async () => {
      const firestore = db(env, 'lawyer');
      await assertSucceeds(setDoc(doc(firestore, personalPath(LAWYER, 'p-new')), newPersonal(LAWYER)));
      await assertFails(
        setDoc(
          doc(firestore, personalPath(LAWYER, 'p-other')),
          newPersonal(LAWYER, { assigneeUid: uidFor('paralegal') }),
        ),
      );
      await assertFails(
        setDoc(doc(firestore, personalPath(LAWYER, 'p-matter')), newPersonal(LAWYER, { matterId: 'matter-1' })),
      );
      await assertFails(
        setDoc(doc(firestore, personalPath(LAWYER, 'p-tpl')), newPersonal(LAWYER, { countedOpen: true })),
      );
    });

    it('nobody else creates, reads, edits or lists them, owners and admins included', async () => {
      for (const role of ['owner', 'admin', 'paralegal'] as const) {
        const firestore = db(env, role);
        await assertFails(setDoc(doc(firestore, personalPath(LAWYER, `p-by-${role}`)), newPersonal(LAWYER)));
        await assertFails(getDoc(doc(firestore, personalPath(LAWYER, 'p-new'))));
        await assertFails(getDocs(collection(firestore, `orgs/${ORG}/members/${LAWYER}/tasks`)));
        await assertFails(
          updateDoc(doc(firestore, personalPath(LAWYER, 'p-new')), stamped({ status: 'done' }, uidFor(role))),
        );
        await assertFails(
          getDocs(query(collectionGroup(firestore, 'tasks'), where('orgId', '==', ORG), where('matterId', '==', null))),
        );
        await assertFails(
          getDocs(
            query(collectionGroup(firestore, 'tasks'), where('orgId', '==', ORG), where('assigneeUid', '==', LAWYER)),
          ),
        );
      }
    });

    it('their owner edits them but can’t hand them to someone else', async () => {
      const firestore = db(env, 'lawyer');
      const ref = doc(firestore, personalPath(LAWYER, 'p-new'));
      await assertSucceeds(updateDoc(ref, stamped({ status: 'done', order: 3 }, LAWYER)));
      await assertFails(updateDoc(ref, stamped({ assigneeUid: uidFor('paralegal') }, LAWYER)));
      await assertFails(updateDoc(ref, stamped({ priority: 'p1' }, LAWYER)));
      await assertSucceeds(updateDoc(ref, { ...stamped({}, LAWYER), deletedAt: serverTimestamp(), deletedBy: LAWYER }));
      await assertFails(deleteDoc(ref));
    });

    it('"my tasks" lists my matter and personal tasks, open ones by due date', async () => {
      const firestore = db(env, 'lawyer');
      await assertSucceeds(
        getDocs(
          query(
            collectionGroup(firestore, 'tasks'),
            where('orgId', '==', ORG),
            where('assigneeUid', '==', LAWYER),
            where('status', 'in', ['todo', 'in_progress', 'blocked']),
            orderBy('dueDate'),
          ),
        ),
      );
    });
  });
});

// Last in this file, before another suite reloads the rules (which resets the emulator's report).
describe('rules coverage', () => {
  it('evaluates at least 90% of the rule expressions', async () => {
    const coverage = await writeRulesCoverage();
    expect(coverage.missed).toEqual([]);
    expect(coverage.coveragePct).toBeGreaterThanOrEqual(90);
  }, 60_000);
});
