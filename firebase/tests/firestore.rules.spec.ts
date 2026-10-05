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

import { ManualDeadlineCreateInput, MatterTaskCreateInput, PERMISSIONS, ROLES, type Role } from '@materia/domain';
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

  it('a computed deadline is reassigned or acknowledged by clients, nothing else', async () => {
    await reseed('deadlines');
    const lawyer = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), DEADLINE);
    // Overrides, dates, status and provenance go through the deadlines-* callables (CORE-10).
    await assertFails(updateDoc(ref, stamped({ override: { reason: 'x' } }, lawyer)));
    await assertFails(updateDoc(ref, stamped({ dueDate: '2027-02-01' }, lawyer)));
    await assertFails(updateDoc(ref, stamped({ status: 'done' }, lawyer)));
    await assertFails(updateDoc(ref, stamped({ title: 'Renamed' }, lawyer)));
    await assertFails(updateDoc(ref, stamped({ assigneeUid: '' }, lawyer)));
    await assertFails(updateDoc(ref, { ...stamped({}, lawyer), deletedAt: serverTimestamp(), deletedBy: lawyer }));
    await assertFails(updateDoc(ref, stamped({ ackBy: uidFor('paralegal'), ackAt: serverTimestamp() }, lawyer)));
    await assertSucceeds(updateDoc(ref, stamped({ ackBy: lawyer, ackAt: serverTimestamp() }, lawyer)));
    await assertSucceeds(updateDoc(ref, stamped({ assigneeUid: uidFor('paralegal') }, lawyer)));
    // A closed computed deadline is frozen.
    await seedAdmin(env, (f) => setDoc(doc(f, DEADLINE), { ...seedData(specFor('deadlines')), status: 'done' }));
    await assertFails(updateDoc(ref, stamped({ assigneeUid: lawyer }, lawyer)));
    await reseed('deadlines');
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

describe('org settings (CORE-21)', () => {
  const ORG_DOC = `orgs/${ORG}`;
  const MEMBER = `orgs/${ORG}/members/member-target`;

  it('practice details and billing change only through orgs-updateSettings, even for owners', async () => {
    await seed(specFor('orgs'));
    const ref = doc(db(env, 'owner'), ORG_DOC);
    const owner = uidFor('owner');
    await assertFails(updateDoc(ref, stamped({ name: 'Renamed Fictional Legal' }, owner)));
    await assertFails(updateDoc(ref, stamped({ timezone: 'Australia/Perth' }, owner)));
    await assertFails(updateDoc(ref, stamped({ jurisdictions: ['NSW'] }, owner)));
    await assertFails(updateDoc(ref, stamped({ retentionYears: 1 }, owner)));
    await assertFails(updateDoc(ref, stamped({ 'billing.gstRegistered': false }, owner)));
    // Matter numbering (CORE-21a) stays client-direct for owners and admins.
    await assertSucceeds(
      updateDoc(doc(db(env, 'admin'), ORG_DOC), stamped({ matterNumberFormat: 'F-{YY}-{seq:3}' }, uidFor('admin'))),
    );
    await assertFails(
      updateDoc(doc(db(env, 'lawyer'), ORG_DOC), stamped({ matterNumberFormat: 'F-{seq}' }, uidFor('lawyer'))),
    );
  });

  it('owners and admins set a member’s rate, budgets and supervisor; others can’t', async () => {
    await seed(specFor('members'));
    const patch = {
      defaultRateCents: 52000,
      rates: [{ effectiveFrom: '2026-10-05', rateCents: 52000 }],
      budgets: { '2026': 25000000 },
      supervisorUid: uidFor('owner'),
    };
    await assertSucceeds(updateDoc(doc(db(env, 'admin'), MEMBER), stamped(patch, uidFor('admin'))));
    await assertFails(updateDoc(doc(db(env, 'lawyer'), MEMBER), stamped(patch, uidFor('lawyer'))));
    await assertFails(
      updateDoc(doc(db(env, 'paralegal'), MEMBER), stamped({ defaultRateCents: 1 }, uidFor('paralegal'))),
    );
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
          // The referral (CORE-18), edited on the matter header.
          referrerContactId: 'contact-2',
          referralSource: 'website',
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

describe('recent matters (CORE-14)', () => {
  const recentOf = (uid: string) => `users/${uid}/recent`;
  const DAY = 86_400_000;
  const expiring = (days = 90) => Timestamp.fromMillis(Date.now() + days * DAY);
  /** A recent matter as the matter screen writes it. */
  const entry = (uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    orgId: ORG,
    matterId: 'matter-1',
    expireAt: expiring(),
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });

  it.each(EVERYONE)('record, list, record again and forget a matter I opened, as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, `${recentOf(uid)}/${ORG}_matter-1`);
    const write = setDoc(ref, entry(uid));
    // Every member opens matters in their org; the outsider's claim names another org, and a
    // suspended member is out of the org.
    if (!isMember(who)) {
      await assertFails(write);
      return;
    }
    await assertSucceeds(write);
    await assertSucceeds(getDoc(ref));
    // Today's query: the latest in my current org.
    await assertSucceeds(
      getDocs(
        query(collection(firestore, recentOf(uid)), where('orgId', '==', ORG), orderBy('updatedAt', 'desc'), limit(8)),
      ),
    );
    // Opening it again writes the whole entry (an update now that it exists).
    await assertSucceeds(setDoc(ref, entry(uid)));
    await assertSucceeds(deleteDoc(ref));
  });

  it.each(ROLES)("someone else's recent matters are off limits, as %s", async (role) => {
    const other = role === 'lawyer' ? uidFor('owner') : uidFor('lawyer');
    const path = `${recentOf(other)}/${ORG}_matter-1`;
    await seedAdmin(env, (f) => setDoc(doc(f, path), { ...seedData(specFor('recent')), createdBy: other }));
    const firestore = db(env, role);
    await assertFails(getDoc(doc(firestore, path)));
    await assertFails(getDocs(collection(firestore, recentOf(other))));
    await assertFails(setDoc(doc(firestore, path), entry(uidFor(role))));
    await assertFails(updateDoc(doc(firestore, path), stamped({ expireAt: expiring() }, uidFor(role))));
    await assertFails(deleteDoc(doc(firestore, path)));
  });

  it('refuses an invalid entry', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const ref = doc(firestore, `${recentOf(uid)}/${ORG}_matter-1`);
    for (const bad of [
      { orgId: OTHER_ORG },
      { matterId: 'matter-2' },
      { matterId: '' },
      { expireAt: expiring(30) },
      { expireAt: expiring(120) },
      { expireAt: '2027-01-01' },
      { createdBy: 'someone-else' },
      { updatedBy: 'someone-else' },
      { updatedAt: Timestamp.fromMillis(0) },
      { schemaVersion: 2 },
      { title: 'Estate of Margaret Fictional' },
    ]) {
      await assertFails(setDoc(ref, entry(uid, bad)));
    }
    const incomplete = entry(uid);
    delete incomplete['expireAt'];
    await assertFails(setDoc(ref, incomplete));
    // The id names the org and the matter.
    await assertFails(setDoc(doc(firestore, `${recentOf(uid)}/matter-1`), entry(uid)));
    await assertFails(setDoc(doc(firestore, `${recentOf(uid)}/${OTHER_ORG}_matter-1`), entry(uid)));
  });

  it('a partial update keeps the entry valid', async () => {
    const uid = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), `${recentOf(uid)}/${ORG}_matter-1`);
    await seed(specFor('recent'));
    // The seeded entry expires sooner than 89 days from now: a write must move it on.
    await assertFails(updateDoc(ref, stamped({ matterId: 'matter-1' }, uid)));
    await assertFails(updateDoc(ref, stamped({ matterId: 'matter-2', expireAt: expiring() }, uid)));
    await assertSucceeds(updateDoc(ref, stamped({ expireAt: expiring() }, uid)));
  });
});

describe('⌘K search and recents (CORE-15)', () => {
  const recentOf = (uid: string) => `users/${uid}/recent`;
  const expiring = () => Timestamp.fromMillis(Date.now() + 90 * 86_400_000);
  const entry = (uid: string, ref: Record<string, unknown>): Record<string, unknown> => ({
    orgId: ORG,
    ...ref,
    expireAt: expiring(),
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
  });

  it('records contacts, tasks and documents I opened, by kind, matter and id', async () => {
    const uid = uidFor('readonly');
    const firestore = db(env, 'readonly');
    const at = (id: string) => doc(firestore, `${recentOf(uid)}/${id}`);
    await assertSucceeds(setDoc(at(`${ORG}_contact_c-1`), entry(uid, { kind: 'contact', entityId: 'c-1' })));
    await assertSucceeds(
      setDoc(at(`${ORG}_task_matter-1_t-1`), entry(uid, { kind: 'task', matterId: 'matter-1', entityId: 't-1' })),
    );
    await assertSucceeds(setDoc(at(`${ORG}_task_t-2`), entry(uid, { kind: 'task', entityId: 't-2' })));
    await assertSucceeds(
      setDoc(
        at(`${ORG}_document_matter-1_doc-1`),
        entry(uid, { kind: 'document', matterId: 'matter-1', entityId: 'doc-1' }),
      ),
    );
    await assertSucceeds(setDoc(at(`${ORG}_matter-1`), entry(uid, { kind: 'matter', matterId: 'matter-1' })));
    // The palette lists the latest of every kind; Today lists matters only.
    await assertSucceeds(
      getDocs(
        query(collection(firestore, recentOf(uid)), where('orgId', '==', ORG), orderBy('updatedAt', 'desc'), limit(10)),
      ),
    );
    await assertSucceeds(
      getDocs(
        query(
          collection(firestore, recentOf(uid)),
          where('orgId', '==', ORG),
          where('kind', '==', 'matter'),
          orderBy('updatedAt', 'desc'),
          limit(8),
        ),
      ),
    );
  });

  it('refuses an entry whose id, kind or ids disagree', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const at = (id: string) => doc(firestore, `${recentOf(uid)}/${id}`);
    for (const [id, ref] of [
      [`${ORG}_contact_c-1`, { kind: 'contact', entityId: 'c-2' }],
      [`${ORG}_contact_matter-1_c-1`, { kind: 'contact', matterId: 'matter-1', entityId: 'c-1' }],
      [`${ORG}_contact_c-1`, { kind: 'person', entityId: 'c-1' }],
      [`${ORG}_contact_`, { kind: 'contact', entityId: '' }],
      [`${ORG}_document_doc-1`, { kind: 'document', entityId: 'doc-1' }],
      [`${ORG}_task_t-1`, { kind: 'task', matterId: 'matter-1', entityId: 't-1' }],
      [`${ORG}_matter-1`, { kind: 'matter', matterId: 'matter-1', entityId: 'x' }],
      [`${ORG}_task_t-1`, { kind: 'task', entityId: 't-1', matterId: 7 }],
    ] as const) {
      await assertFails(setDoc(at(id), entry(uid, ref)));
    }
  });

  it('searches matters, contacts and my tasks as every role (non-privileged only without privileged.view)', async () => {
    for (const role of ROLES) {
      const firestore = db(env, role);
      const privileged = allows(role, 'privileged.view');
      await assertSucceeds(
        getDocs(
          query(
            collection(firestore, `orgs/${ORG}/matters`),
            where('deletedAt', '==', null),
            ...(privileged ? [] : [where('privileged', '==', false)]),
            where('search', 'array-contains', 'estate'),
            orderBy('lastActivityAt', 'desc'),
            limit(20),
          ),
        ),
      );
      await assertSucceeds(
        getDocs(
          query(
            collection(firestore, `orgs/${ORG}/contacts`),
            where('search', 'array-contains', 'doyle'),
            orderBy('updatedAt', 'desc'),
            limit(20),
          ),
        ),
      );
      await assertSucceeds(
        getDocs(
          query(
            collectionGroup(firestore, 'tasks'),
            where('orgId', '==', ORG),
            where('assigneeUid', '==', uidFor(role)),
            where('search', 'array-contains', 'probate'),
            orderBy('updatedAt', 'desc'),
            limit(20),
          ),
        ),
      );
    }
  });

  it('every matter task through the group needs privileged.view, and a query proving it is a matter task', async () => {
    const everyMatterTask = (firestore: Firestore) =>
      getDocs(
        query(
          collectionGroup(firestore, 'tasks'),
          where('orgId', '==', ORG),
          where('search', 'array-contains', 'probate'),
          where('matterId', '!=', null),
          limit(20),
        ),
      );
    for (const role of ROLES) {
      await (allows(role, 'privileged.view') ? assertSucceeds : assertFails)(everyMatterTask(db(env, role)));
    }
    // Without the matterId filter it could include someone's personal task.
    await assertFails(getDocs(query(collectionGroup(db(env, 'owner'), 'tasks'), where('orgId', '==', ORG), limit(20))));
  });

  it('documents through the group need privileged.view; other roles search the open matter’s, non-privileged', async () => {
    const group = (firestore: Firestore, orgId = ORG) =>
      getDocs(
        query(
          collectionGroup(firestore, 'documents'),
          where('orgId', '==', orgId),
          where('search', 'array-contains', 'will'),
          orderBy('updatedAt', 'desc'),
          limit(20),
        ),
      );
    for (const role of ROLES) {
      const firestore = db(env, role);
      const privileged = allows(role, 'privileged.view');
      await (privileged ? assertSucceeds : assertFails)(group(firestore));
      await assertSucceeds(
        getDocs(
          query(
            collection(firestore, `${MATTER}/documents`),
            ...(privileged ? [] : [where('privileged', '==', false)]),
            where('search', 'array-contains', 'will'),
            orderBy('updatedAt', 'desc'),
            limit(20),
          ),
        ),
      );
    }
    await assertFails(group(db(env, 'owner', OTHER_ORG)));
    await assertFails(group(db(env, 'owner'), OTHER_ORG));
    await assertFails(group(db(env, 'lawyer', ORG, SUSPENDED_UID)));
  });
});

describe('notifications (FND-20)', () => {
  const devicesOf = (uid: string) => `users/${uid}/devices`;
  /** A device as the web app registers it. */
  const device = (uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    token: 'fake-fcm-token-rules',
    platform: 'web',
    lastSeenAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });
  const INBOX = `orgs/${ORG}/notifications`;

  it.each(EVERYONE)('register, refresh, list and remove my own device, as %s', async (who) => {
    // Devices belong to the account, not the org: anyone signed in manages their own.
    const { firestore, uid } = firestoreOf(who);
    const ref = doc(firestore, `${devicesOf(uid)}/device-mine`);
    await assertSucceeds(setDoc(ref, device(uid)));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(collection(firestore, devicesOf(uid))));
    await assertSucceeds(updateDoc(ref, stamped({ lastSeenAt: serverTimestamp(), token: 'fake-fcm-token-2' }, uid)));
    await assertSucceeds(deleteDoc(ref));
  });

  it.each(ROLES)("someone else's devices are off limits, as %s", async (role) => {
    const other = role === 'lawyer' ? uidFor('owner') : uidFor('lawyer');
    const path = `${devicesOf(other)}/device-theirs`;
    await seedAdmin(env, (f) => setDoc(doc(f, path), { ...seedData(specFor('devices')), createdBy: other }));
    const firestore = db(env, role);
    await assertFails(getDoc(doc(firestore, path)));
    await assertFails(getDocs(collection(firestore, devicesOf(other))));
    await assertFails(setDoc(doc(firestore, `${devicesOf(other)}/device-planted`), device(uidFor(role))));
    await assertFails(updateDoc(doc(firestore, path), stamped({ token: 'stolen' }, uidFor(role))));
    await assertFails(deleteDoc(doc(firestore, path)));
  });

  it('refuses an invalid device', async () => {
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), `${devicesOf(uid)}/device-bad`);
    for (const bad of [
      { token: '' },
      { token: 'x'.repeat(4097) },
      { token: 42 },
      { platform: 'fax' },
      { lastSeenAt: '2026-10-05' },
      { createdBy: 'someone-else' },
      { updatedBy: 'someone-else' },
      { createdAt: Timestamp.fromMillis(0) },
      { schemaVersion: 2 },
      { ownerEmail: 'someone@example.com' },
    ]) {
      await assertFails(setDoc(ref, device(uid, bad)));
    }
    const incomplete = device(uid);
    delete incomplete['platform'];
    await assertFails(setDoc(ref, incomplete));
  });

  it('a recipient marks a notification read with the server time, or unread; nothing else', async () => {
    const uid = uidFor('lawyer');
    const path = `${INBOX}/notification-read`;
    await seedAdmin(env, (f) => setDoc(doc(f, path), { ...seedData(specFor('notifications')), recipientUid: uid }));
    const ref = doc(db(env, 'lawyer'), path);
    await assertSucceeds(updateDoc(ref, stamped({ readAt: serverTimestamp() }, uid)));
    await assertSucceeds(updateDoc(ref, stamped({ readAt: null }, uid)));
    await assertFails(updateDoc(ref, stamped({ readAt: Timestamp.fromMillis(0) }, uid)));
    await assertFails(updateDoc(ref, stamped({ readAt: 'yesterday' }, uid)));
    for (const field of ['channels', 'deliveries', 'priority', 'recipientUid', 'body', 'deliverAfter']) {
      await assertFails(updateDoc(ref, stamped({ readAt: serverTimestamp(), [field]: null }, uid)));
    }
  });

  it.each(EVERYONE)('lists only my unread in-app notifications, as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    // The nav badge's query: mine, in-app, unread, newest first.
    const unread = (recipient: string) =>
      getDocs(
        query(
          collection(firestore, INBOX),
          where('recipientUid', '==', recipient),
          where('channels', 'array-contains', 'inapp'),
          where('readAt', '==', null),
          where('summaryId', '==', null),
          orderBy('createdAt', 'desc'),
          limit(100),
        ),
      );
    await (isMember(who) ? assertSucceeds(unread(uid)) : assertFails(unread(uid)));
    await assertFails(unread(uid === uidFor('lawyer') ? uidFor('owner') : uidFor('lawyer')));
    await assertFails(getDocs(query(collection(firestore, INBOX), limit(10))));
  });

  it('notification preferences are the owner’s, and never turn off email for deadline escalations', async () => {
    const uid = uidFor('paralegal');
    await seedAdmin(env, (f) => setDoc(doc(f, `users/${uid}`), seedData(specFor('users'))));
    const ref = doc(db(env, 'paralegal'), `users/${uid}`);
    const prefs = (notifications: unknown) => ({
      prefs: { theme: 'system', density: 'comfortable', shortcuts: true, notifications },
    });
    const valid = {
      email: true,
      push: true,
      digestHour: 6,
      quietHours: { start: '20:00', end: '06:30' },
      kinds: { mention: { email: false }, deadline_escalation: { push: false } },
      taskReminderDays: 2,
    };
    await assertSucceeds(updateDoc(ref, stamped(prefs(valid), uid)));
    // Switching email off is allowed: critical notifications still email (enforced by notify()).
    await assertSucceeds(updateDoc(ref, stamped(prefs({ ...valid, email: false }), uid)));
    await assertSucceeds(
      updateDoc(ref, stamped(prefs({ ...valid, kinds: { deadline_escalation: { email: true } } }), uid)),
    );
    for (const bad of [
      { ...valid, kinds: { deadline_escalation: { email: false } } },
      { ...valid, digestHour: 24 },
      { ...valid, digestHour: '7' },
      { ...valid, taskReminderDays: 15 },
      { ...valid, taskReminderDays: -1 },
      { ...valid, taskReminderDays: 1.5 },
      { ...valid, email: 'yes' },
      { ...valid, push: 1 },
      { ...valid, kinds: 'all' },
      'off',
    ]) {
      await assertFails(updateDoc(ref, stamped(prefs(bad), uid)));
    }
    // Someone else's preferences are not mine to change.
    const other = doc(db(env, 'paralegal'), `users/${uidFor('lawyer')}`);
    await assertFails(updateDoc(other, stamped(prefs(valid), uid)));
    // The server-owned undeliverable flag isn't the owner's either.
    await assertFails(updateDoc(ref, stamped({ emailDeliverability: null }, uid)));
  });

  it.each(EVERYONE)('digest records are server-only, as %s', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    await assertFails(getDoc(doc(firestore, `orgs/${ORG}/digests/digest-${uid}-2026-10-06`)));
    await assertFails(getDocs(collection(firestore, `orgs/${ORG}/digests`)));
    await assertFails(setDoc(doc(firestore, `orgs/${ORG}/digests/digest-${uid}-2026-10-07`), { uid }));
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
    const unmarked = newTask(uid) as Record<string, unknown>;
    delete unmarked['countedOpen'];
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
    const withoutStatus = newTask(uid) as Record<string, unknown>;
    delete withoutStatus['status'];
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

describe('deadlines (CORE-10)', () => {
  const PRIVILEGED_MATTER = `orgs/${ORG}/matters/matter-deadlines-privileged`;
  const DELETED_MATTER = `orgs/${ORG}/matters/matter-deadlines-deleted`;
  const MANUAL = `${MATTER}/deadlines/manual-1`;
  const PARALEGAL = uidFor('paralegal');

  /** A valid client create of a manual deadline, stamped for `uid`. */
  const newDeadline = (uid: string, matterId = 'matter-1', extra: Record<string, unknown> = {}) => ({
    orgId: ORG,
    matterId,
    title: 'Settlement under the fictional contract of sale',
    dueDate: '2026-11-20',
    dueTime: '16:00',
    kind: 'contractual',
    critical: false,
    status: 'upcoming',
    assigneeUid: uid,
    reminders: [{ offsetDays: 7 }],
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });
  const seedManual = (extra: Record<string, unknown> = {}) =>
    seedAdmin(env, (f) =>
      setDoc(doc(f, MANUAL), {
        ...newDeadline(PARALEGAL),
        createdAt: Timestamp.fromMillis(1),
        updatedAt: Timestamp.fromMillis(1),
        ...extra,
      }),
    );

  beforeAll(async () => {
    await seedAdmin(env, async (f) => {
      const matter = seedData(specFor('matters'));
      await setDoc(doc(f, PRIVILEGED_MATTER), { ...matter, privileged: true });
      await setDoc(doc(f, DELETED_MATTER), { ...matter, deletedAt: Timestamp.fromMillis(1), deletedBy: 'x' });
    });
  });

  it('the create whitelist matches ManualDeadlineCreateInput in libs/domain', () => {
    const rules = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
    const listed = /function manualDeadlineCreateFields\(\) \{\s*return \[([^\]]*)\]/.exec(rules)?.[1] ?? '';
    const fields = [...listed.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(fields.sort()).toEqual(Object.keys(ManualDeadlineCreateInput.shape).sort());
  });

  it.each(ROLES)('creating a manual deadline as %s follows task.edit', async (role) => {
    const uid = uidFor(role);
    const create = setDoc(doc(db(env, role), `${MATTER}/deadlines/new-${role}`), newDeadline(uid));
    await (allows(role, 'task.edit') ? assertSucceeds(create) : assertFails(create));
  });

  it('a create needs the path’s org and matter, a manual kind, upcoming and valid values', async () => {
    const firestore = db(env, 'paralegal');
    const attempt = (id: string, extra: Record<string, unknown>, matterId = 'matter-1') =>
      assertFails(setDoc(doc(firestore, `${MATTER}/deadlines/${id}`), newDeadline(PARALEGAL, matterId, extra)));
    await attempt('bad-org', { orgId: OTHER_ORG });
    await attempt('bad-matter', {}, 'matter-2');
    await attempt('statutory', { kind: 'statutory' });
    await attempt('done', { status: 'done' });
    await attempt('computed', { computed: { ruleId: 'x' } });
    await attempt('override', { override: { dueDate: '2026-11-21' } });
    await attempt('past', { pastOnCreation: true });
    await attempt('blank', { title: '  ' });
    await attempt('long', { title: 'x'.repeat(301) });
    await attempt('date', { dueDate: '20/11/2026' });
    await attempt('time', { dueTime: '4pm' });
    await attempt('critical', { critical: 'yes' });
    await attempt('assignee', { assigneeUid: '' });
    await attempt('reminders', { reminders: Array.from({ length: 11 }, () => ({ offsetDays: 1 })) });
    await attempt('creator', { createdBy: 'someone-else' });
    await attempt('version', { schemaVersion: 2 });
    const noTime = newDeadline(PARALEGAL) as Record<string, unknown>;
    delete noTime['dueTime'];
    await assertSucceeds(setDoc(doc(firestore, `${MATTER}/deadlines/no-time`), noTime));
    const noKind = newDeadline(PARALEGAL) as Record<string, unknown>;
    delete noKind['kind'];
    await assertFails(setDoc(doc(firestore, `${MATTER}/deadlines/no-kind`), noKind));
    for (const kind of ['internal', 'court']) {
      await assertSucceeds(
        setDoc(doc(firestore, `${MATTER}/deadlines/k-${kind}`), newDeadline(PARALEGAL, 'matter-1', { kind })),
      );
    }
  });

  it('privileged and deleted matters', async () => {
    const paralegal = db(env, 'paralegal');
    await assertFails(
      setDoc(doc(paralegal, `${PRIVILEGED_MATTER}/deadlines/p`), newDeadline(PARALEGAL, 'matter-deadlines-privileged')),
    );
    await assertSucceeds(
      setDoc(
        doc(db(env, 'lawyer'), `${PRIVILEGED_MATTER}/deadlines/l`),
        newDeadline(uidFor('lawyer'), 'matter-deadlines-privileged'),
      ),
    );
    await assertFails(
      setDoc(
        doc(db(env, 'lawyer'), `${DELETED_MATTER}/deadlines/d`),
        newDeadline(uidFor('lawyer'), 'matter-deadlines-deleted'),
      ),
    );
  });

  it('a manual deadline’s whitelisted fields are edited while upcoming, with valid values', async () => {
    await seedManual();
    const ref = doc(db(env, 'paralegal'), MANUAL);
    await assertSucceeds(
      updateDoc(
        ref,
        stamped(
          {
            title: 'Settlement (moved by agreement)',
            dueDate: '2026-11-27',
            dueTime: '12:00',
            kind: 'internal',
            critical: true,
            assigneeUid: uidFor('lawyer'),
            reminders: [{ offsetDays: 1 }, { offsetDays: 7 }],
          },
          PARALEGAL,
        ),
      ),
    );
    await assertSucceeds(updateDoc(ref, { ...stamped({}, PARALEGAL), dueTime: deleteField() }));
    await assertSucceeds(updateDoc(ref, stamped({ ackBy: PARALEGAL, ackAt: serverTimestamp() }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ kind: 'statutory' }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ dueDate: 'soon' }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ title: '' }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ status: 'done' }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ computed: { ruleId: 'x' } }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ pastOnCreation: true }, PARALEGAL)));
    await assertFails(updateDoc(ref, stamped({ ackBy: uidFor('lawyer'), ackAt: serverTimestamp() }, PARALEGAL)));
    await assertFails(updateDoc(doc(db(env, 'readonly'), MANUAL), stamped({ title: 'x' }, uidFor('readonly'))));
    // Closed: frozen, but it can still be soft deleted.
    await seedManual({ status: 'done' });
    await assertFails(updateDoc(ref, stamped({ title: 'Too late' }, PARALEGAL)));
    await assertSucceeds(
      updateDoc(ref, { ...stamped({}, PARALEGAL), deletedAt: serverTimestamp(), deletedBy: PARALEGAL }),
    );
    await assertFails(deleteDoc(ref));
  });

  it('events are read-only for clients', async () => {
    const lawyer = db(env, 'lawyer');
    await assertSucceeds(getDoc(doc(lawyer, `${MATTER}/events/doc-1`)));
    await assertFails(
      setDoc(doc(lawyer, `${MATTER}/events/new`), {
        kind: 'date_of_death',
        date: '2026-07-14',
        meta: {},
        createdAt: serverTimestamp(),
        createdBy: uidFor('lawyer'),
        updatedAt: serverTimestamp(),
        updatedBy: uidFor('lawyer'),
        schemaVersion: 1,
      }),
    );
    await assertFails(
      updateDoc(doc(lawyer, `${MATTER}/events/doc-1`), stamped({ date: '2026-07-15' }, uidFor('lawyer'))),
    );
  });

  it('proposals are read by members, across matters too, and never written by clients', async () => {
    const paralegal = db(env, 'paralegal');
    await assertSucceeds(getDoc(doc(paralegal, `${MATTER}/deadlineChanges/change-1`)));
    await assertSucceeds(
      getDocs(
        query(
          collectionGroup(paralegal, 'deadlineChanges'),
          where('orgId', '==', ORG),
          where('assigneeUid', '==', uidFor('lawyer')),
          where('status', '==', 'pending'),
        ),
      ),
    );
    await assertFails(
      getDocs(query(collectionGroup(db(env, 'owner', OTHER_ORG), 'deadlineChanges'), where('orgId', '==', ORG))),
    );
    await assertFails(
      updateDoc(
        doc(db(env, 'lawyer'), `${MATTER}/deadlineChanges/change-1`),
        stamped({ status: 'accepted' }, uidFor('lawyer')),
      ),
    );
  });

  it('the Deadlines screen and review queue queries', async () => {
    const group = collectionGroup(db(env, 'lawyer'), 'deadlines');
    await assertSucceeds(
      getDocs(
        query(group, where('orgId', '==', ORG), where('status', '==', 'upcoming'), orderBy('dueDate'), limit(100)),
      ),
    );
    await assertSucceeds(
      getDocs(
        query(group, where('orgId', '==', ORG), where('status', '==', 'upcoming'), where('pastOnCreation', '==', true)),
      ),
    );
  });
});

describe('documents (CORE-12)', () => {
  const DOCUMENT = `${MATTER}/documents/doc-1`;
  const PRIVILEGED_MATTER = `orgs/${ORG}/matters/matter-doc-privileged`;
  const reseed = () => seed(specFor('documents'));

  beforeAll(async () => {
    await seedAdmin(env, async (f) => {
      await setDoc(doc(f, PRIVILEGED_MATTER), { ...seedData(specFor('matters')), privileged: true });
      await setDoc(doc(f, `${PRIVILEGED_MATTER}/documents/doc-p`), {
        ...seedData(specFor('documents')),
        matterId: 'matter-doc-privileged',
        privileged: false,
      });
      await setDoc(doc(f, `${MATTER}/documents/doc-privileged`), {
        ...seedData(specFor('documents')),
        privileged: true,
      });
      await setDoc(doc(f, `${MATTER}/documents/doc-removed`), {
        ...seedData(specFor('documents')),
        deletedAt: Timestamp.fromMillis(Date.UTC(2026, 9, 2)),
        deletedBy: uidFor('lawyer'),
      });
    });
  });

  it('privileged documents, and every document of a privileged matter, are hidden from readonly and paralegals', async () => {
    for (const role of ROLES) {
      const firestore = db(env, role);
      const sees = allows(role, 'privileged.view');
      await (sees ? assertSucceeds : assertFails)(getDoc(doc(firestore, `${MATTER}/documents/doc-privileged`)));
      await (sees ? assertSucceeds : assertFails)(getDoc(doc(firestore, `${PRIVILEGED_MATTER}/documents/doc-p`)));
    }
  });

  it('readonly lists only non-privileged documents, newest first', async () => {
    const documents = collection(db(env, 'readonly'), `${MATTER}/documents`);
    await assertSucceeds(getDocs(query(documents, where('privileged', '==', false), orderBy('createdAt', 'desc'))));
    await assertFails(getDocs(query(documents, orderBy('createdAt', 'desc'))));
    await assertSucceeds(
      getDocs(query(collection(db(env, 'lawyer'), `${MATTER}/documents`), orderBy('createdAt', 'desc'))),
    );
  });

  it('a soft-deleted document stays readable, so citations resolve', async () => {
    await assertSucceeds(getDoc(doc(db(env, 'readonly'), `${MATTER}/documents/doc-removed`)));
  });

  it('clients edit name, category, tags and notes within the limits', async () => {
    await reseed();
    const paralegal = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), DOCUMENT);
    await assertSucceeds(
      updateDoc(
        ref,
        stamped(
          {
            name: 'Will (signed, fictional)',
            category: 'codicil',
            tags: ['original', 'signed'],
            notes: 'From the safe',
          },
          paralegal,
        ),
      ),
    );
    await assertFails(updateDoc(ref, stamped({ name: ' ' }, paralegal)));
    await assertFails(updateDoc(ref, stamped({ name: 'x'.repeat(256) }, paralegal)));
    await assertFails(updateDoc(ref, stamped({ category: 'spreadsheet' }, paralegal)));
    await assertFails(updateDoc(ref, stamped({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, paralegal)));
    await assertFails(updateDoc(ref, stamped({ tags: 'not-a-list' }, paralegal)));
    await assertFails(updateDoc(ref, stamped({ notes: 'x'.repeat(5001) }, paralegal)));
    // readonly edits nothing.
    await assertFails(updateDoc(doc(db(env, 'readonly'), DOCUMENT), stamped({ name: 'Renamed' }, uidFor('readonly'))));
  });

  it('only the server writes scan, version, hash, upload and duplicate fields', async () => {
    await reseed();
    const lawyer = uidFor('lawyer');
    const ref = doc(db(env, 'owner'), DOCUMENT);
    for (const change of [
      { scan: { status: 'infected' } },
      { version: 2 },
      { versions: [] },
      { versionSeq: 9 },
      { sha256: 'b'.repeat(64) },
      { storagePath: `${MATTER}/documents/doc-1/v9` },
      { sizeBytes: 1 },
      { mime: 'image/png' },
      { upload: { uploadId: 'u-1', status: 'scanning' } },
      { duplicateOf: 'doc-2' },
      { pageCount: 1 },
      { encrypted: true },
      { renditions: { previewPdf: 'x' } },
      { ingest: { status: 'done' } },
      { source: 'email' },
    ]) {
      await assertFails(updateDoc(ref, stamped(change, uidFor('owner'))));
    }
    await assertSucceeds(updateDoc(doc(db(env, 'lawyer'), DOCUMENT), stamped({ name: 'Renamed' }, lawyer)));
  });

  it('document.delete roles soft delete and restore; a paralegal cannot', async () => {
    await reseed();
    const remove = (uid: string) => ({
      deletedAt: serverTimestamp(),
      deletedBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    });
    await assertFails(updateDoc(doc(db(env, 'paralegal'), DOCUMENT), remove(uidFor('paralegal'))));
    await assertSucceeds(updateDoc(doc(db(env, 'lawyer'), DOCUMENT), remove(uidFor('lawyer'))));
    await assertSucceeds(
      updateDoc(doc(db(env, 'lawyer'), DOCUMENT), stamped({ deletedAt: null, deletedBy: null }, uidFor('lawyer'))),
    );
    await reseed();
  });

  it('nobody reads or writes the hash index', async () => {
    const path = `${MATTER}/documentHashes/${'a'.repeat(64)}`;
    await assertFails(getDoc(doc(db(env, 'owner'), path)));
    await assertFails(setDoc(doc(db(env, 'owner'), `${MATTER}/documentHashes/${'c'.repeat(64)}`), { documentId: 'x' }));
  });
});

describe('checklist templates (CORE-08d)', () => {
  const PATH = `orgs/${ORG}/checklistTemplates`;
  const TEMPLATE = `${PATH}/checklist-1`;

  /** A valid client create, stamped for `uid`. */
  const newTemplate = (uid: string, extra: Record<string, unknown> = {}) => ({
    name: 'Probate kick-off',
    items: ['Order the death certificate', 'Locate the original will'],
    priority: 'high',
    dueInDays: 7,
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });

  it.each(EVERYONE)('creating a template as %s follows task.edit', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const create = setDoc(doc(firestore, `${PATH}/new-${who}`), newTemplate(uid));
    await (allows(who, 'task.edit') ? assertSucceeds(create) : assertFails(create));
  });

  it('members list the org’s templates; other orgs can’t', async () => {
    const list = (firestore: Firestore) => getDocs(query(collection(firestore, PATH), orderBy('name'), limit(100)));
    await assertSucceeds(list(db(env, 'readonly')));
    await assertSucceeds(list(db(env, 'paralegal')));
    await assertFails(list(db(env, 'owner', OTHER_ORG)));
    await assertFails(list(db(env, 'lawyer', ORG, SUSPENDED_UID)));
  });

  it('a create needs valid values, the caller’s stamps and no server fields', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const attempt = (id: string, extra: Record<string, unknown>) =>
      assertFails(setDoc(doc(firestore, `${PATH}/${id}`), newTemplate(uid, extra)));
    await attempt('blank', { name: '   ' });
    await attempt('long-name', { name: 'n'.repeat(101) });
    await attempt('no-items', { items: [] });
    await attempt('too-many', { items: Array.from({ length: 31 }, (_, i) => `Item ${i}`) });
    await attempt('empty-item', { items: ['Order the death certificate', ''] });
    await attempt('long-item', { items: ['i'.repeat(201)] });
    await attempt('two-lines', { items: ['Order the\ndeath certificate'] });
    await attempt('not-text', { items: [42] });
    await attempt('items-text', { items: 'Order the death certificate' });
    await attempt('priority', { priority: 'p1' });
    await attempt('days-negative', { dueInDays: -1 });
    await attempt('days-long', { dueInDays: 366 });
    await attempt('days-fraction', { dueInDays: 1.5 });
    await attempt('extra', { matterId: 'matter-1' });
    await attempt('deleted', { deletedAt: serverTimestamp(), deletedBy: uid });
    await attempt('creator', { createdBy: 'someone-else' });
    await attempt('created-at', { createdAt: Timestamp.fromMillis(0) });
    await attempt('updater', { updatedBy: 'someone-else' });
    await attempt('version', { schemaVersion: 2 });
    const withoutItems = newTemplate(uid) as Record<string, unknown>;
    delete withoutItems['items'];
    await assertFails(setDoc(doc(firestore, `${PATH}/no-items-field`), withoutItems));
    // The minimum: a name and one item, no priority or due offset; and the most: 30 items of 200.
    const minimal = newTemplate(uid, { items: ['File the inventory'] }) as Record<string, unknown>;
    delete minimal['priority'];
    delete minimal['dueInDays'];
    await assertSucceeds(setDoc(doc(firestore, `${PATH}/minimal`), minimal));
    await assertSucceeds(
      setDoc(
        doc(firestore, `${PATH}/largest`),
        newTemplate(uid, {
          name: 'n'.repeat(100),
          items: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(200, 'x')),
          dueInDays: 365,
        }),
      ),
    );
  });

  it('updates the whitelisted fields with valid values only', async () => {
    await seed(specFor('checklistTemplates'));
    const uid = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), TEMPLATE);
    await assertSucceeds(
      updateDoc(
        ref,
        stamped({ name: 'Grant application', items: ['Swear the affidavit'], priority: 'urgent', dueInDays: 0 }, uid),
      ),
    );
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), priority: deleteField(), dueInDays: deleteField() }));
    await assertFails(updateDoc(ref, stamped({ name: '' }, uid)));
    await assertFails(updateDoc(ref, stamped({ items: [] }, uid)));
    await assertFails(updateDoc(ref, stamped({ items: ['x'.repeat(201)] }, uid)));
    await assertFails(updateDoc(ref, stamped({ dueInDays: 400 }, uid)));
    await assertFails(updateDoc(ref, stamped({ priority: 'top' }, uid)));
    await assertFails(updateDoc(ref, stamped({ matterId: 'matter-1' }, uid)));
    await assertFails(
      updateDoc(doc(db(env, 'readonly'), TEMPLATE), stamped({ name: 'Read-only rename' }, uidFor('readonly'))),
    );
  });

  it('soft delete and restore by task.edit roles, never a hard delete', async () => {
    await seed(specFor('checklistTemplates'));
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), TEMPLATE);
    await assertFails(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: 'someone-else' }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: uid }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: null, deletedBy: null }));
    await assertFails(deleteDoc(ref));
    await assertFails(
      updateDoc(doc(db(env, 'readonly'), TEMPLATE), {
        ...stamped({}, uidFor('readonly')),
        deletedAt: serverTimestamp(),
        deletedBy: uidFor('readonly'),
      }),
    );
    await assertFails(
      updateDoc(doc(db(env, 'owner', OTHER_ORG), TEMPLATE), {
        ...stamped({}, uidFor('owner', OTHER_ORG)),
        deletedAt: serverTimestamp(),
        deletedBy: uidFor('owner', OTHER_ORG),
      }),
    );
  });
});

describe('task group templates (CORE-08f)', () => {
  const PATH = `orgs/${ORG}/taskGroupTemplates`;
  const TEMPLATE = `${PATH}/group-1`;
  const TASKS = [
    { title: 'Locate the original will', checklist: ['Ask the family', 'Search the will bank'], priority: 'high' },
    { title: 'Write to the bank', checklist: [], dueInDays: 7 },
  ];

  /** A valid client create, stamped for `uid`. */
  const newTemplate = (uid: string, extra: Record<string, unknown> = {}) => ({
    name: 'Checklist A',
    tasks: TASKS,
    createdAt: serverTimestamp(),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    schemaVersion: 1,
    ...extra,
  });

  it.each(EVERYONE)('creating a template as %s follows task.edit', async (who) => {
    const { firestore, uid } = firestoreOf(who);
    const create = setDoc(doc(firestore, `${PATH}/new-${who}`), newTemplate(uid));
    await (allows(who, 'task.edit') ? assertSucceeds(create) : assertFails(create));
  });

  it('members list the org’s templates; other orgs can’t', async () => {
    const list = (firestore: Firestore) => getDocs(query(collection(firestore, PATH), orderBy('name'), limit(100)));
    await assertSucceeds(list(db(env, 'readonly')));
    await assertSucceeds(list(db(env, 'paralegal')));
    await assertFails(list(db(env, 'owner', OTHER_ORG)));
    await assertFails(list(db(env, 'lawyer', ORG, SUSPENDED_UID)));
  });

  it('a create needs a name, 1 to 50 tasks, the caller’s stamps and no server fields', async () => {
    const uid = uidFor('paralegal');
    const firestore = db(env, 'paralegal');
    const attempt = (id: string, extra: Record<string, unknown>) =>
      assertFails(setDoc(doc(firestore, `${PATH}/${id}`), newTemplate(uid, extra)));
    await attempt('blank', { name: '   ' });
    await attempt('long-name', { name: 'n'.repeat(121) });
    await attempt('name-number', { name: 42 });
    await attempt('no-tasks', { tasks: [] });
    await attempt('too-many', { tasks: Array.from({ length: 51 }, (_, i) => ({ title: `Task ${i}`, checklist: [] })) });
    await attempt('tasks-text', { tasks: 'Write to the bank' });
    await attempt('extra', { matterId: 'matter-1' });
    await attempt('deleted', { deletedAt: serverTimestamp(), deletedBy: uid });
    await attempt('creator', { createdBy: 'someone-else' });
    await attempt('created-at', { createdAt: Timestamp.fromMillis(0) });
    await attempt('updater', { updatedBy: 'someone-else' });
    await attempt('version', { schemaVersion: 2 });
    const withoutTasks = newTemplate(uid) as Record<string, unknown>;
    delete withoutTasks['tasks'];
    await assertFails(setDoc(doc(firestore, `${PATH}/no-tasks-field`), withoutTasks));
    await assertSucceeds(
      setDoc(
        doc(firestore, `${PATH}/largest`),
        newTemplate(uid, {
          name: 'n'.repeat(120),
          tasks: Array.from({ length: 50 }, (_, i) => ({ title: `Task ${i}`, checklist: [] })),
        }),
      ),
    );
  });

  it('updates the whitelisted fields with valid values only', async () => {
    await seed(specFor('taskGroupTemplates'));
    const uid = uidFor('lawyer');
    const ref = doc(db(env, 'lawyer'), TEMPLATE);
    await assertSucceeds(
      updateDoc(ref, stamped({ name: 'Checklist B', tasks: [{ title: 'Pay the fee', checklist: [] }] }, uid)),
    );
    await assertFails(updateDoc(ref, stamped({ name: '' }, uid)));
    await assertFails(updateDoc(ref, stamped({ tasks: [] }, uid)));
    await assertFails(updateDoc(ref, stamped({ matterId: 'matter-1' }, uid)));
    await assertFails(
      updateDoc(doc(db(env, 'readonly'), TEMPLATE), stamped({ name: 'Read-only rename' }, uidFor('readonly'))),
    );
  });

  it('soft delete and restore by task.edit roles, never a hard delete', async () => {
    await seed(specFor('taskGroupTemplates'));
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), TEMPLATE);
    await assertFails(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: 'someone-else' }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: uid }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: null, deletedBy: null }));
    await assertFails(deleteDoc(ref));
    await assertFails(
      updateDoc(doc(db(env, 'owner', OTHER_ORG), TEMPLATE), {
        ...stamped({}, uidFor('owner', OTHER_ORG)),
        deletedAt: serverTimestamp(),
        deletedBy: uidFor('owner', OTHER_ORG),
      }),
    );
  });
});

describe('notes (CORE-13)', () => {
  const NOTE = `${MATTER}/notes/note-13`;
  const PRIVILEGED_NOTE = `${MATTER}/notes/note-13-privileged`;
  const revision = (privileged: boolean) => ({ ...seedData(specFor('revisions')), privileged });
  const reseed = () =>
    seedAdmin(env, async (f) => {
      await setDoc(doc(f, NOTE), { ...seedData(specFor('notes')), privileged: false, pinned: false, deletedAt: null });
    });

  beforeAll(async () => {
    await reseed();
    await seedAdmin(env, async (f) => {
      await setDoc(doc(f, PRIVILEGED_NOTE), { ...seedData(specFor('notes')), privileged: true });
      await setDoc(doc(f, `${NOTE}/revisions/r-plain`), revision(false));
      // An earlier version that was privileged, of a note that no longer is.
      await setDoc(doc(f, `${NOTE}/revisions/r-privileged`), revision(true));
      await setDoc(doc(f, `${PRIVILEGED_NOTE}/revisions/r-1`), revision(false));
    });
  });

  it.each(ROLES)('pinning and unpinning follow note.write, as %s', async (role) => {
    await reseed();
    const ref = doc(db(env, role), NOTE);
    const pin = updateDoc(ref, stamped({ pinned: true }, uidFor(role)));
    await (allows(role, 'note.write') ? assertSucceeds(pin) : assertFails(pin));
  });

  it.each(ROLES)('nobody edits the text, mentions, flag or edit stamp directly, as %s', async (role) => {
    await reseed();
    const ref = doc(db(env, role), NOTE);
    const uid = uidFor(role);
    for (const change of [
      { bodyMd: 'Rewritten by a client' },
      { bodyMd: 'Rewritten', pinned: true },
      { mentions: { uids: [uidFor('owner')], matterIds: [] } },
      { privileged: true },
      { editedAt: serverTimestamp(), editedBy: uid },
      { source: 'clerk' },
    ]) {
      await assertFails(updateDoc(ref, stamped(change, uid)));
    }
  });

  it('note.write roles soft delete and restore; readonly cannot', async () => {
    await reseed();
    const uid = uidFor('paralegal');
    const ref = doc(db(env, 'paralegal'), NOTE);
    await assertFails(
      updateDoc(doc(db(env, 'readonly'), NOTE), {
        ...stamped({}, uidFor('readonly')),
        deletedAt: serverTimestamp(),
        deletedBy: uidFor('readonly'),
      }),
    );
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: serverTimestamp(), deletedBy: uid }));
    await assertSucceeds(updateDoc(ref, { ...stamped({}, uid), deletedAt: null, deletedBy: null }));
  });

  it('a privileged note: hidden from, and not pinnable by, roles without privileged.view', async () => {
    for (const role of ROLES) {
      const read = getDoc(doc(db(env, role), PRIVILEGED_NOTE));
      await (allows(role, 'privileged.view') ? assertSucceeds(read) : assertFails(read));
    }
    await assertFails(
      updateDoc(doc(db(env, 'paralegal'), PRIVILEGED_NOTE), stamped({ pinned: true }, uidFor('paralegal'))),
    );
    await assertSucceeds(
      updateDoc(doc(db(env, 'lawyer'), PRIVILEGED_NOTE), stamped({ pinned: true }, uidFor('lawyer'))),
    );
  });

  it.each(ROLES)('revisions follow the note and their own flag, as %s', async (role) => {
    const firestore = db(env, role);
    const sees = allows(role, 'privileged.view');
    await assertSucceeds(getDoc(doc(firestore, `${NOTE}/revisions/r-plain`)));
    await (sees ? assertSucceeds : assertFails)(getDoc(doc(firestore, `${NOTE}/revisions/r-privileged`)));
    await (sees ? assertSucceeds : assertFails)(getDoc(doc(firestore, `${PRIVILEGED_NOTE}/revisions/r-1`)));
  });

  it('roles without privileged.view list a note’s history by proving privileged == false', async () => {
    const history = collection(db(env, 'paralegal'), `${NOTE}/revisions`);
    await assertSucceeds(getDocs(query(history, where('privileged', '==', false), orderBy('editedAt', 'desc'))));
    await assertFails(getDocs(query(history, orderBy('editedAt', 'desc'))));
    await assertSucceeds(
      getDocs(query(collection(db(env, 'lawyer'), `${NOTE}/revisions`), orderBy('editedAt', 'desc'))),
    );
    // A privileged note's history stays hidden whatever the query proves.
    await assertFails(
      getDocs(
        query(collection(db(env, 'paralegal'), `${PRIVILEGED_NOTE}/revisions`), where('privileged', '==', false)),
      ),
    );
  });

  it('readonly lists only non-privileged notes, newest first', async () => {
    const notes = collection(db(env, 'readonly'), `${MATTER}/notes`);
    await assertSucceeds(getDocs(query(notes, where('privileged', '==', false), orderBy('createdAt', 'desc'))));
    await assertFails(getDocs(query(notes, orderBy('createdAt', 'desc'))));
  });

  it('clients never write revisions', async () => {
    const ref = doc(db(env, 'owner'), `${NOTE}/revisions/r-plain`);
    await assertFails(updateDoc(ref, stamped({ bodyMd: 'Rewritten history' }, uidFor('owner'))));
    await assertFails(setDoc(doc(db(env, 'owner'), `${NOTE}/revisions/r-new`), revision(false)));
    await assertFails(deleteDoc(ref));
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
