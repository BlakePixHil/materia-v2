import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import fc from 'fast-check';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes, type FirebaseStorage } from 'firebase/storage';

import { ROLES } from '@materia/domain';

import { COLLECTIONS, seedData, type CollectionSpec } from './support/collections';
import { createRulesEnv, db, MATTER, ORG, OTHER_ORG, seedAdmin, seedMembers, uidFor } from './support/harness';

/**
 * Rules fuzz test (SEC-02). Where the generated per-collection suite (firestore.rules.spec.ts)
 * checks each known collection role by role, this throws random paths, identities and operations
 * at the rules and expects no unexpected allow:
 * - a collection no `match` block names, anywhere in the tree (top level, under an org, a matter,
 *   a user's own document, nested), is denied to everyone, members included;
 * - every org's documents are denied to anyone outside it: a member of another org, a signed-in
 *   user without claims, a claim with no member document behind it, and anonymous users;
 * - files likewise.
 * A failure prints fast-check's seed and the shrunk counterexample: replay it with `{ seed, path }`.
 */

const rulesText = readFileSync(path.resolve(import.meta.dirname, '../firestore.rules'), 'utf8');
const storageRulesText = readFileSync(path.resolve(import.meta.dirname, '../storage.rules'), 'utf8');
/** Every collection id a rule names, plus the tested ones: random names must avoid them all. */
const KNOWN = new Set([
  ...[...rulesText.matchAll(/match \/([A-Za-z]+)\//g)].map((m) => m[1] ?? ''),
  // Collection-group matches too (`match /{path=**}/tasks/{taskId}`).
  ...[...rulesText.matchAll(/\/([A-Za-z]+)\/\{/g)].map((m) => m[1] ?? ''),
  ...[...storageRulesText.matchAll(/\/([A-Za-z]+)\//g)].map((m) => m[1] ?? ''),
  ...COLLECTIONS.map((spec) => spec.collection.split(' ')[0] ?? ''),
  'databases',
]);

const unknownName = fc.stringMatching(/^[a-z][A-Za-z]{2,12}$/).filter((name) => !KNOWN.has(name));
const docId = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/).filter((id) => !/^__.*__$/.test(id));
const OPS = ['get', 'list', 'create', 'update', 'delete'] as const;
type Op = (typeof OPS)[number];

/** People who must never reach org A's data. */
const OUTSIDERS = ['otherOrgOwner', 'noClaims', 'claimWithoutMembership', 'anonymous'] as const;
type Outsider = (typeof OUTSIDERS)[number];
type Who = (typeof ROLES)[number] | Outsider;

let env: RulesTestEnvironment;
const firestores = new Map<Who, { firestore: Firestore; uid: string }>();
const storages = new Map<Who, FirebaseStorage>();

const now = () => Math.floor(Date.now() / 1000);

function identity(who: Who): { firestore: Firestore; storage: FirebaseStorage; uid: string } {
  const found = firestores.get(who);
  const storage = storages.get(who);
  if (!found || !storage) throw new Error(`No context for ${who}`);
  return { ...found, storage };
}

/** Data that looks as much like the caller's own as possible, so only the path decides. */
const plausible = (uid: string) => ({
  orgId: ORG,
  matterId: 'matter-1',
  uid,
  assigneeUid: uid,
  createdBy: uid,
  updatedBy: uid,
  title: 'Fuzz',
  status: 'active',
  privileged: false,
  schemaVersion: 1,
  createdAt: Timestamp.fromDate(new Date('2026-10-01T00:00:00Z')),
  updatedAt: Timestamp.fromDate(new Date('2026-10-01T00:00:00Z')),
});

async function attempt(firestore: Firestore, uid: string, docPath: string, op: Op): Promise<void> {
  const target = doc(firestore, docPath);
  switch (op) {
    case 'get':
      return void (await assertFails(getDoc(target)));
    case 'list':
      return void (await assertFails(getDocs(collection(firestore, docPath.slice(0, docPath.lastIndexOf('/'))))));
    case 'create':
      return void (await assertFails(
        setDoc(doc(firestore, `${docPath}-new`), {
          ...plausible(uid),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      ));
    case 'update':
      return void (await assertFails(
        updateDoc(target, { title: 'Changed', updatedAt: serverTimestamp(), updatedBy: uid }),
      ));
    case 'delete':
      return void (await assertFails(deleteDoc(target)));
  }
}

beforeAll(async () => {
  env = await createRulesEnv();
  await env.clearFirestore();
  await env.clearStorage();
  await seedMembers(env);
  await seedAdmin(env, async (firestore) => {
    // Both orgs exist and the outsider is an active owner of theirs: they fail on tenancy alone.
    await setDoc(doc(firestore, `orgs/${ORG}`), { name: 'Org A', security: { mfaRequired: false } });
    await setDoc(doc(firestore, `orgs/${OTHER_ORG}`), { name: 'Org B', security: { mfaRequired: false } });
    await setDoc(doc(firestore, `orgs/${OTHER_ORG}/members/${uidFor('owner', OTHER_ORG)}`), {
      role: 'owner',
      status: 'active',
    });
    // Org A's documents, carrying org A's id as the server writes them.
    for (const spec of COLLECTIONS) {
      const data = seedData(spec);
      await setDoc(doc(firestore, spec.docPath), 'orgId' in data ? { ...data, orgId: ORG } : data);
    }
  });

  for (const role of ROLES) {
    firestores.set(role, { firestore: db(env, role), uid: uidFor(role) });
    storages.set(
      role,
      env.authenticatedContext(uidFor(role), { orgId: ORG, role, iat: now() }).storage() as unknown as FirebaseStorage,
    );
  }
  const contexts: Record<
    Outsider,
    { uid: string; context: ReturnType<RulesTestEnvironment['unauthenticatedContext']> }
  > = {
    otherOrgOwner: {
      uid: uidFor('owner', OTHER_ORG),
      context: env.authenticatedContext(uidFor('owner', OTHER_ORG), { orgId: OTHER_ORG, role: 'owner', iat: now() }),
    },
    noClaims: { uid: 'stranger', context: env.authenticatedContext('stranger', { iat: now() }) },
    claimWithoutMembership: {
      uid: 'spoof-a',
      context: env.authenticatedContext('spoof-a', { orgId: ORG, role: 'owner', iat: now() }),
    },
    anonymous: { uid: 'anonymous', context: env.unauthenticatedContext() },
  };
  for (const who of OUTSIDERS) {
    const { uid, context } = contexts[who];
    firestores.set(who, { firestore: context.firestore() as unknown as Firestore, uid });
    storages.set(who, context.storage() as unknown as FirebaseStorage);
  }
}, 120_000);

afterAll(async () => {
  await env.cleanup();
});

describe('rules fuzz: unknown collections', () => {
  const parents = [
    '',
    `orgs/${ORG}`,
    MATTER,
    `${MATTER}/documents/doc-1`,
    `orgs/${ORG}/members/${uidFor('lawyer')}`,
    `orgs/${ORG}/clerkThreads/thread-1`,
    // The lawyer's own user document, whose known subcollections they may write.
    `users/${uidFor('lawyer')}`,
  ];

  it('are denied to every member and outsider, at any depth', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Who>(...ROLES, ...OUTSIDERS),
        fc.constantFrom(...parents),
        fc.array(fc.tuple(unknownName, docId), { minLength: 1, maxLength: 2 }),
        fc.constantFrom(...OPS),
        async (who, parent, segments, op) => {
          const { firestore, uid } = identity(who);
          const docPath = [parent, ...segments.flat()].filter(Boolean).join('/');
          await seedAdmin(env, (admin) => setDoc(doc(admin, docPath), plausible(uid)));
          await attempt(firestore, uid, docPath, op);
        },
      ),
      { numRuns: 150 },
    );
  }, 300_000);
});

describe('rules fuzz: another tenant', () => {
  // Org A's and its members' documents (global reference data is readable to anyone signed in).
  const tenantDocs = COLLECTIONS.filter(
    (spec: CollectionSpec) => spec.docPath.startsWith(`orgs/${ORG}`) || spec.docPath.startsWith('users/'),
  );

  it("denies every operation on an org's documents to anyone outside it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...OUTSIDERS),
        fc.constantFrom(...tenantDocs),
        fc.constantFrom(...OPS),
        async (who, spec, op) => {
          const { firestore, uid } = identity(who);
          await attempt(firestore, uid, spec.docPath, op);
        },
      ),
      { numRuns: 150 },
    );
  }, 300_000);
});

describe('rules fuzz: files', () => {
  const PDF = { contentType: 'application/pdf' };
  const bytes = new Uint8Array(16);

  it("denies unknown paths to everyone, and an org's files to anyone outside it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // Anything outside the paths storage.rules names, for any identity.
          fc.record({
            who: fc.constantFrom<Who>(...ROLES, ...OUTSIDERS),
            path: fc.tuple(unknownName, docId, docId).map((parts) => parts.join('/')),
          }),
          // Org A's stored versions and pending uploads, for outsiders.
          fc.record({
            who: fc.constantFrom<Who>(...OUTSIDERS),
            path: fc
              .tuple(fc.constantFrom('documents', 'pending'), docId)
              .map(([kind, id]) => (kind === 'documents' ? `${MATTER}/documents/${id}/v1` : `${MATTER}/pending/${id}`)),
          }),
        ),
        fc.constantFrom('get', 'upload', 'delete'),
        async ({ who, path: objectPath }, op) => {
          await env.withSecurityRulesDisabled(async (admin) => {
            await uploadBytes(ref(admin.storage(), objectPath), bytes, PDF);
          });
          const target = ref(identity(who).storage, objectPath);
          if (op === 'get') await assertFails(getBytes(target));
          else if (op === 'upload') await assertFails(uploadBytes(target, bytes, PDF));
          else await assertFails(deleteObject(target));
        },
      ),
      { numRuns: 60 },
    );
  }, 300_000);
});
