import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

import { ROLES, type Role } from '@materia/domain';
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
    const role = writerFor(spec);
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
    // Non-privileged reads still work until the claim is revoked.
    await assertSucceeds(getDoc(doc(suspended, MATTER)));
  });

  it('a paralegal cannot mark a matter privileged; a lawyer can', async () => {
    const paralegal = doc(db(env, 'paralegal'), MATTER);
    await assertFails(updateDoc(paralegal, stamped({ privileged: true }, uidFor('paralegal'))));
    const lawyer = doc(db(env, 'lawyer'), MATTER);
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: true }, uidFor('lawyer'))));
    await assertSucceeds(updateDoc(lawyer, stamped({ privileged: false }, uidFor('lawyer'))));
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
    await assertSucceeds(
      getDocs(
        query(collectionGroup(firestore, 'tasks'), where('orgId', '==', ORG), where('matterId', '==', 'matter-1')),
      ),
    );
    await assertSucceeds(getDocs(query(collectionGroup(firestore, 'deadlines'), where('orgId', '==', ORG))));
    await assertSucceeds(getDocs(query(collectionGroup(firestore, 'timeEntries'), where('orgId', '==', ORG))));
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

// Last in this file, before another suite reloads the rules (which resets the emulator's report).
describe('rules coverage', () => {
  it('evaluates at least 90% of the rule expressions', async () => {
    const coverage = await writeRulesCoverage();
    expect(coverage.missed).toEqual([]);
    expect(coverage.coveragePct).toBeGreaterThanOrEqual(90);
  }, 60_000);
});
