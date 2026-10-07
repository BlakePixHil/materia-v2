import { createHash, randomUUID } from 'node:crypto';

import { unzipSync } from 'fflate';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type CollectionReference, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';
import * as z from 'zod';

import {
  integrationDocId,
  ORG_EXPORT_EXCLUDED,
  ORG_EXPORT_QUEUE,
  ORG_PURGE_STAGES,
  orgDeletionCertificatePath,
  OrgExportManifestSchema,
  TIMER_DOC_ID,
  toPortable,
} from '@materia/domain';
import {
  ENTITY_FACTORIES,
  makeDeletedOrg,
  makeMatter,
  makeMember,
  makeOrg,
  TEST_MATTER_ID,
  TEST_ORG_ID,
  TEST_UID,
} from '@materia/test-utils';

import { drain } from './support/drain';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import { storageFiles } from '../../src/documents/files';
import { collectionOfPath } from '../../src/exports/org-format';
import { orgExportDefinition } from '../../src/exports/org-full';
import { runOrgExport } from '../../src/exports/run-org-full';
import { syncClaims } from '../../src/orgs/claims';
import { requestDeletionDefinition } from '../../src/orgs/deletion';
import { purgeOrg, type PurgeDeps } from '../../src/orgs/purge';
import type { Clock } from '../../src/ports';
import { FakeClock, FakeKms, FakeMail, FakeOAuth, FakeTaskQueue, fakePorts } from '../../src/ports/fakes';

/**
 * SEC-05 through the emulators (Firestore, Storage, Auth and Functions):
 *
 * - A practice holding one record of every org-scoped entity (the shared factories, so a new
 *   entity is exported and deleted here without editing this file) is exported in several zips.
 *   Every line validates against the JSON Schema shipped in the export and holds what was
 *   stored, every file matches its manifest checksum, and every document file matches the hash
 *   its record holds.
 * - The same kind of practice is deleted by the job, step by step. A scan of Firestore (the
 *   practice's tree, every collection group, and every other top-level collection) and of the
 *   bucket then finds nothing of it but the tombstone and the certificate; a member of another
 *   practice keeps that membership.
 * - A legal hold, and an export being written, stop a deletion.
 * - Triggers leave a practice being deleted alone.
 *
 * The callables and the job run in this process. The Functions emulator's background triggers
 * are off while the factories' records are written and the export and deletion run (each record
 * would start a dozen triggers, about a minute of the shard's time on fresh emulators, and they
 * would change records under the export's comparison); the last test turns them on again to
 * check that they skip a practice being deleted. Every person, practice, matter and file is
 * fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = 'demo-materia.appspot.com';
const DAY = 86_400_000;

const OWNER = 'sec05-owner';
const LAWYER = 'sec05-lawyer';
const EXPORTED = 'org-sec05-export';
const DELETED = 'org-sec05-delete';
const OTHER = 'org-sec05-other';
const HELD = 'org-sec05-hold';
const BUSY = 'org-sec05-busy';
const GONE = 'org-sec05-gone';

const WILL_V1 = Buffer.from('%PDF-1.7 fictional will, first draft\n%%EOF\n');
const WILL_V2 = Buffer.from('%PDF-1.7 fictional will, signed\n%%EOF\n');
const TEMPLATE = Buffer.from('PK fictional letterhead template');
const PREVIEW = Buffer.from('%PDF-1.7 fictional preview\n%%EOF\n');
const OLD_EXPORT = Buffer.from('PK fictional earlier export');

/** Top-level collections the emulators' own stand-ins write (sent mail and push, the pinned clock). */
const EMULATOR_ONLY = new Set(['emulatorOutbox', 'emulatorPushOutbox', 'emulatorClock']);

type Data = Record<string, unknown>;
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const text = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString('utf8');
const realClock: Clock = { now: () => new Date() };
const log = createLog({ fn: 'data-rights-integration' }, () => undefined);

let admin: App;
let db: Firestore;
let auth: Auth;
const files = () => storageFiles(BUCKET);
const bucket = () => getAdminStorage(admin).bucket(BUCKET);

let triggersOn = true;
/**
 * Turns the Functions emulator's background triggers off, or on again (through the Emulator Hub,
 * as `@firebase/rules-unit-testing` does). Events while off are dropped, not queued. Turning them
 * on reloads the functions (about 5 s) with fresh workers.
 */
async function triggers(on: boolean): Promise<void> {
  if (triggersOn === on) return;
  const hub = process.env['FIREBASE_EMULATOR_HUB'];
  if (!hub) throw new Error('FIREBASE_EMULATOR_HUB is not set: run this under firebase emulators:exec');
  const response = await fetch(`http://${hub}/functions/${on ? 'enable' : 'disable'}BackgroundTriggers`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`The Emulator Hub answered ${response.status}`);
  triggersOn = on;
}

// ---------- a practice with one record of every kind ----------

/** Path parameters for the factories' records (`{matterId}` is the factory matter, and so on). */
const PARAMS: Record<string, string> = {
  matterId: TEST_MATTER_ID,
  docId: 'doc-test-1',
  noteId: 'note-1',
  threadId: 'thread-1',
  templateId: 'template-1',
  period: '2026-10',
  uid: TEST_UID,
};
/** Records other records hang under keep the ids their children's paths use. */
const OWN_IDS: Record<string, string> = {
  Matter: TEST_MATTER_ID,
  MatterDocument: 'doc-test-1',
  Note: 'note-1',
  ClerkThread: 'thread-1',
  MatterTemplate: 'template-1',
  Metrics: '2026-10',
  Member: TEST_UID,
};
const kebab = (name: string) => name.replace(/[A-Z]/g, (c, i: number) => `${i ? '-' : ''}${c.toLowerCase()}`);

/** A factory value moved into another practice: every `org-test-1` (ids, storage paths) replaced. */
function retarget(value: unknown, orgId: string): unknown {
  if (typeof value === 'string') return value.split(TEST_ORG_ID).join(orgId);
  if (Array.isArray(value)) return value.map((item) => retarget(item, orgId));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, retarget(inner, orgId)]));
  }
  return value;
}

const documentPath = (orgId: string) => `orgs/${orgId}/matters/${TEST_MATTER_ID}/documents/doc-test-1`;
const version = (orgId: string, n: number, bytes: Buffer, fileName: string) => ({
  version: n,
  storagePath: `${documentPath(orgId)}/v${n}`,
  fileName,
  mime: 'application/pdf',
  sizeBytes: bytes.length,
  sha256: sha(bytes),
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  uploadedBy: OWNER,
});

/** One record of every org-scoped entity in libs/domain, by path, with two members and a document in two versions. */
function practiceRecords(orgId: string, name: string): Map<string, Data> {
  const records = new Map<string, Data>();
  for (const [entityName, [entity, make]] of Object.entries(ENTITY_FACTORIES)) {
    const pattern = (entity as unknown as { path: string }).path;
    if (pattern !== 'orgs' && !pattern.startsWith('orgs/{orgId}/')) continue;
    const collection = pattern.replace(/\{(\w+)\}/g, (_, key: string) =>
      key === 'orgId' ? orgId : (PARAMS[key] ?? key),
    );
    const id = pattern === 'orgs' ? orgId : (OWN_IDS[entityName] ?? `${kebab(entityName)}-1`);
    records.set(`${collection}/${id}`, retarget((make as () => Data)(), orgId) as Data);
  }
  records.set(`orgs/${orgId}`, { ...records.get(`orgs/${orgId}`), name, timezone: 'Australia/Melbourne' });
  records.set(`orgs/${orgId}/members/${OWNER}`, {
    ...makeMember({ role: 'owner', displayName: 'Olive Fictional', initials: 'OF' }),
  });
  records.set(`orgs/${orgId}/members/${LAWYER}`, {
    ...makeMember({ role: 'lawyer', displayName: 'Lena Fictional', initials: 'LF' }),
  });
  const document = documentPath(orgId);
  records.set(document, {
    ...records.get(document),
    version: 2,
    versionSeq: 2,
    storagePath: `${document}/v2`,
    sizeBytes: WILL_V2.length,
    sha256: sha(WILL_V2),
    versions: [version(orgId, 1, WILL_V1, 'Will draft.pdf'), version(orgId, 2, WILL_V2, 'Will – signed.pdf')],
  });
  return records;
}

/** The practice's stored files: both versions of the will, its preview, a template and an earlier export. */
const practiceFiles = (orgId: string) =>
  new Map<string, Buffer>([
    [`${documentPath(orgId)}/v1`, WILL_V1],
    [`${documentPath(orgId)}/v2`, WILL_V2],
    [`${documentPath(orgId)}/v2/renditions/preview.pdf`, PREVIEW],
    [`orgs/${orgId}/templates/letterhead.docx`, TEMPLATE],
    [`orgs/${orgId}/exports/earlier-export.zip`, OLD_EXPORT],
  ]);

async function reset(orgId: string): Promise<void> {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  await db.recursiveDelete(db.doc(`deletedOrgs/${orgId}`));
  await files().purge(`orgs/${orgId}/`);
  await files().purge(`deletedOrgs/${orgId}/`);
}

async function write(records: Map<string, Data>): Promise<void> {
  const writer = db.bulkWriter();
  for (const [path, data] of records) void writer.set(db.doc(path), data);
  await writer.close();
}

async function seedPractice(orgId: string, name: string): Promise<Map<string, Data>> {
  await reset(orgId);
  const records = practiceRecords(orgId, name);
  await write(records);
  for (const [path, bytes] of practiceFiles(orgId)) await bucket().file(path).save(bytes);
  return records;
}

/** A practice with an owner and a matter (and whatever else a test adds). */
async function seedSmall(orgId: string, name: string, extra: Record<string, Data> = {}): Promise<void> {
  await reset(orgId);
  await write(
    new Map<string, Data>([
      [`orgs/${orgId}`, { ...makeOrg({ name }) }],
      [`orgs/${orgId}/members/${OWNER}`, { ...makeMember({ role: 'owner', displayName: 'Olive Fictional' }) }],
      [`orgs/${orgId}/matters/matter-1`, retarget(makeMatter(), orgId) as Data],
      ...Object.entries(extra),
    ]),
  );
}

// ---------- calling the callables in this process ----------

function call<T>(
  definition: unknown,
  orgId: string,
  data: Data,
  clock: Clock,
  tasks = new FakeTaskQueue(),
): Promise<T> {
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts({ clock, tasks }),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    definition as CallableDefinition<never, T>,
    {
      data: { requestId: randomUUID(), ...data },
      // Signed in a minute ago: these callables need a recent sign-in.
      auth: { uid: OWNER, token: { orgId, role: 'owner', auth_time: Math.floor(clock.now().getTime() / 1000) - 60 } },
    },
    deps,
  );
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const askToDelete = (orgId: string, name: string, clock: Clock) =>
  call<{ deletionScheduledAt: string }>(requestDeletionDefinition, orgId, { confirmation: name }, clock);

// ---------- finding what is left of a practice ----------

/** Every collection id an org-scoped entity lives in (`tasks`, `documents`, `audit`…). */
const GROUPS = [
  ...new Set(
    Object.values(ENTITY_FACTORIES)
      .map(([entity]) => (entity as unknown as { path: string }).path)
      .filter((path) => path.startsWith('orgs/{orgId}/'))
      .map((path) => path.split('/').at(-1) as string),
  ),
].sort();

/** Documents under a collection, at any depth, whose path or fields name `needle`. */
async function naming(collection: CollectionReference, needle: string, found: string[]): Promise<void> {
  const refs = await collection.listDocuments();
  for (let i = 0; i < refs.length; i += 200) {
    const snapshots = await db.getAll(...refs.slice(i, i + 200));
    for (const snap of snapshots) {
      if (snap.exists && (snap.ref.path.includes(needle) || JSON.stringify(snap.data()).includes(`"${needle}"`))) {
        found.push(snap.ref.path);
      }
    }
  }
  for (const ref of refs) for (const sub of await ref.listCollections()) await naming(sub, needle, found);
}

/** Everything in Firestore and the bucket that still names the practice, but its tombstone and certificate. */
async function traces(orgId: string, certificatePath: string): Promise<string[]> {
  const found: string[] = [];
  if ((await db.doc(`orgs/${orgId}`).get()).exists) found.push(`orgs/${orgId}`);
  // Nothing under the practice, at any depth (a document anywhere below keeps its top collection listed).
  for (const collection of await db.doc(`orgs/${orgId}`).listCollections()) found.push(`${collection.path}/…`);
  // No record of it in another practice's tree.
  for (const group of GROUPS) {
    const snap = await db.collectionGroup(group).where('orgId', '==', orgId).limit(5).get();
    found.push(...snap.docs.map((doc) => doc.ref.path));
  }
  // Nothing outside `orgs` names it (people's own records, profiles, claims mirrors).
  for (const collection of await db.listCollections()) {
    if (collection.id === 'orgs' || EMULATOR_ONLY.has(collection.id)) continue;
    await naming(collection, orgId, found);
  }
  const [objects] = await bucket().getFiles();
  found.push(...objects.map((file) => file.name).filter((name) => name.includes(orgId) && name !== certificatePath));
  return found.filter((path) => path !== `deletedOrgs/${orgId}`);
}

// ---------- setup ----------

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'data-rights-integration-admin');
  db = getAdminFirestore(admin);
  db.settings({ ignoreUndefinedProperties: true });
  auth = getAdminAuth(admin);
  for (const [uid, name] of [
    [OWNER, 'Olive Fictional'],
    [LAWYER, 'Lena Fictional'],
  ] as const) {
    await auth.deleteUser(uid).catch(() => undefined);
    await auth.createUser({ uid, email: `${uid}@example.test`, displayName: name });
    await db.recursiveDelete(db.doc(`users/${uid}`));
  }
});

afterAll(async () => {
  await triggers(true);
  await deleteAdminApp(admin);
});

// ---------- the full export ----------

describe('exports-orgFull and exports-runOrgFull', () => {
  beforeEach(() => triggers(false));

  it('exports every kind of record as stored, valid against its schema, and every file matching its checksum, in parts', async () => {
    const seeded = await seedPractice(EXPORTED, 'Fictional Harbour Legal');

    const tasks = new FakeTaskQueue();
    const { jobId } = await call<{ jobId: string }>(
      orgExportDefinition({ partBytes: 8 * 1024 }),
      EXPORTED,
      { acknowledgePrivileged: true, allVersions: true },
      realClock,
      tasks,
    );
    expect(tasks.queued).toEqual([
      expect.objectContaining({ queue: ORG_EXPORT_QUEUE, payload: { orgId: EXPORTED, jobId } }),
    ]);
    const deps = { db, files: files(), clock: realClock, log, ports: { tasks }, attempt: 0 };
    let outcome = await runOrgExport(deps, { orgId: EXPORTED, jobId });
    for (let i = 0; outcome === 'continued' && i < 10; i++)
      outcome = await runOrgExport(deps, { orgId: EXPORTED, jobId });
    expect(outcome).toBe('succeeded');

    // Each part downloads whole, as the job recorded it.
    const job = (await db.doc(`orgs/${EXPORTED}/jobs/${jobId}`).get()).data() as Data;
    expect(job).toMatchObject({ status: 'succeeded', type: 'org.export' });
    const parts = (job['output'] as { parts: { storagePath: string; sizeBytes: number; sha256: string }[] }).parts;
    expect(parts.length).toBeGreaterThan(1);
    const unzipped = new Map<string, { part: number; bytes: Uint8Array }>();
    for (const [index, part] of parts.entries()) {
      const zip = (await files().read(part.storagePath)) as Buffer;
      expect(zip.length).toBe(part.sizeBytes);
      expect(sha(zip)).toBe(part.sha256);
      for (const [name, bytes] of Object.entries(unzipSync(zip))) {
        expect(unzipped.has(name), name).toBe(false);
        unzipped.set(name, { part: index + 1, bytes });
      }
    }

    // The manifest lists every file in the zips, in its part, with its size and checksum.
    const manifest = OrgExportManifestSchema.parse(JSON.parse(text(unzipped.get('manifest.json')?.bytes)));
    expect(manifest).toMatchObject({ orgId: EXPORTED, orgName: 'Fictional Harbour Legal', allVersions: true });
    expect(manifest.parts).toBe(parts.length);
    expect(unzipped.get('manifest.json')?.part).toBe(parts.length);
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      [...unzipped.keys()].filter((name) => name !== 'manifest.json').sort(),
    );
    for (const entry of manifest.entries) {
      const file = unzipped.get(entry.path);
      expect(file?.part, entry.path).toBe(entry.part);
      expect(file?.bytes.length, entry.path).toBe(entry.bytes);
      expect(sha(file?.bytes ?? new Uint8Array()), entry.path).toBe(entry.sha256);
    }
    expect(text(unzipped.get('README.md')?.bytes)).toContain('privileged and confidential material');

    // Every line validates against its collection's schema, as shipped in the export.
    const exported = new Map<string, Data>();
    const counted: Record<string, number> = {};
    const validators = new Map<string, z.ZodType>();
    for (const entry of manifest.entries.filter((e) => e.kind === 'data')) {
      const collection = entry.collection as string;
      const schemaFile = unzipped.get(`schemas/${collection}.schema.json`);
      expect(schemaFile, collection).toBeDefined();
      if (!validators.has(collection))
        validators.set(collection, z.fromJSONSchema(JSON.parse(text(schemaFile?.bytes)) as never) as z.ZodType);
      const lines = text(unzipped.get(entry.path)?.bytes)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { path: string; id: string; data: Data });
      expect(lines.length, entry.path).toBe(entry.records);
      counted[collection] = (counted[collection] ?? 0) + lines.length;
      for (const line of lines) {
        const checked = validators.get(collection)?.safeParse(line);
        expect(checked?.success, `${collection} ${line.path}: ${checked?.error?.message}`).toBe(true);
        exported.set(line.path ? `orgs/${EXPORTED}/${line.path}` : `orgs/${EXPORTED}`, line.data);
      }
    }
    expect(counted).toEqual(manifest.collections);
    // The schemas do reject a bad line.
    const matters = validators.get('matters');
    const matter = exported.get(`orgs/${EXPORTED}/matters/${TEST_MATTER_ID}`) as Data;
    expect(matters?.safeParse({ path: 'matters/x', id: 'x', data: { ...matter, title: 42 } }).success).toBe(false);

    // Every record seeded is there, as it was written, except the collections the export leaves out.
    const excluded = (path: string) =>
      (ORG_EXPORT_EXCLUDED as readonly string[]).includes(collectionOfPath(EXPORTED, path) ?? 'org');
    for (const path of seeded.keys()) {
      if (excluded(path)) {
        expect(exported.has(path), path).toBe(false);
        continue;
      }
      expect(exported.get(path), path).toEqual(toPortable(seeded.get(path)));
    }
    for (const collection of ORG_EXPORT_EXCLUDED) expect(manifest.collections).not.toHaveProperty(collection);

    // Each version of the document is there, matching the hash its record holds; so is the
    // template. Previews and earlier exports are not.
    const document = exported.get(documentPath(EXPORTED)) as { versions: { version: number; sha256: string }[] };
    for (const [n, bytes] of [
      [1, WILL_V1],
      [2, WILL_V2],
    ] as const) {
      const entry = manifest.entries.find((e) => e.documentId === 'doc-test-1' && e.version === n);
      expect(entry, `v${n}`).toMatchObject({ kind: 'file', matterId: TEST_MATTER_ID, sha256: sha(bytes) });
      expect(document.versions.find((v) => v.version === n)?.sha256).toBe(entry?.sha256);
      expect(Buffer.from(unzipped.get(entry?.path ?? '')?.bytes ?? []).equals(bytes)).toBe(true);
    }
    const template = manifest.entries.find((e) => e.storagePath === `orgs/${EXPORTED}/templates/letterhead.docx`);
    expect(template).toMatchObject({ kind: 'file', sha256: sha(TEMPLATE) });
    const stored = manifest.entries.map((e) => e.storagePath ?? '');
    expect(stored.filter((path) => path.includes('/renditions/') || path.includes('/exports/'))).toEqual([]);
  });
});

// ---------- deleting a practice ----------

describe('orgs-requestDeletion and the orgs-purge job', () => {
  beforeEach(() => triggers(false));

  it('deletes everything of the practice after the grace period; its members keep their other practices', async () => {
    const seeded = await seedPractice(DELETED, 'Fictional Bayside Legal');
    // Lena is also a member of another practice, with her own records of both.
    await seedSmall(OTHER, 'Fictional Other Practice', {
      [`orgs/${OTHER}/members/${LAWYER}`]: { ...makeMember({ role: 'lawyer', displayName: 'Lena Fictional' }) },
    });
    const oauthKms = new FakeKms('fake-kms/oauth-tokens/cryptoKeyVersions/1');
    const connection = `orgs/${DELETED}/integrations/${integrationDocId('microsoft', LAWYER)}`;
    const sealed = await oauthKms.encrypt('fictional-refresh-token', connection);
    await write(
      new Map<string, Data>([
        [connection, { provider: 'microsoft', uid: LAWYER, encryptedRefreshToken: sealed.ciphertext }],
        [`users/${OWNER}`, { email: `${OWNER}@example.test`, displayName: 'Olive Fictional', orgIds: [DELETED] }],
        [
          `users/${LAWYER}`,
          { email: `${LAWYER}@example.test`, displayName: 'Lena Fictional', orgIds: [DELETED, OTHER] },
        ],
        [`users/${LAWYER}/recent/del-matter`, { orgId: DELETED, matterId: TEST_MATTER_ID }],
        [`users/${LAWYER}/recent/other-matter`, { orgId: OTHER, matterId: 'matter-1' }],
        [`users/${LAWYER}/views/del-view`, { orgId: DELETED, name: 'My estates' }],
        [`users/${LAWYER}/drafts/del-draft`, { orgId: DELETED, name: 'Fictional intake' }],
        [`users/${LAWYER}/timer/${TIMER_DOC_ID}`, { orgId: DELETED, matterId: TEST_MATTER_ID, running: true }],
      ]),
    );
    for (const uid of [OWNER, LAWYER]) await syncClaims({ db, auth, now: new Date() }, uid, { activeOrgId: DELETED });
    expect((await auth.getUser(LAWYER)).customClaims?.['orgs']).toEqual({ [DELETED]: 'lawyer', [OTHER]: 'lawyer' });

    // Asked 31 days ago: the grace period is over.
    const asked = new FakeClock(new Date(Date.now() - 31 * DAY));
    const { deletionScheduledAt } = await askToDelete(DELETED, 'Fictional Bayside Legal', asked);
    expect(new Date(deletionScheduledAt).getTime()).toBe(asked.now().getTime() + 30 * DAY);
    // Every active member is told (the factories' member too).
    const told = await db.collection(`orgs/${DELETED}/notifications`).where('kind', '==', 'org_deletion').get();
    expect(told.docs.map((doc) => doc.get('recipientUid')).sort()).toEqual([LAWYER, OWNER, TEST_UID].sort());

    const mail = new FakeMail();
    const oauth = new FakeOAuth();
    const deps: PurgeDeps = {
      db,
      files: files(),
      clock: realClock,
      log,
      ports: fakePorts({ mail, oauth, oauthKms }),
      auth: () => auth,
    };
    const outcomes = [(await purgeOrg(deps, DELETED)).outcome];
    expect(outcomes).toEqual(['marked']);
    // Connections revoked, files, records, members released, checked, and the certificate. (The
    // job waits between some steps; nothing else writes here.)
    for (let step = 0; step < 6; step++) outcomes.push((await purgeOrg(deps, DELETED)).outcome);
    expect(outcomes).toEqual([...ORG_PURGE_STAGES]);

    // The tombstone keeps the practice's id, name, deletion time and certificate.
    const tomb = (await db.doc(`deletedOrgs/${DELETED}`).get()).data() as Data;
    expect(tomb).toMatchObject({
      orgId: DELETED,
      name: 'Fictional Bayside Legal',
      status: 'deleted',
      ownerUids: [OWNER],
      counts: { integrations: 1, files: practiceFiles(DELETED).size, members: 3 },
    });
    expect((tomb['counts'] as Data)['records']).toBeGreaterThanOrEqual(seeded.size);
    expect(tomb).not.toHaveProperty('memberUids');
    const certificatePath = orgDeletionCertificatePath(DELETED, String(tomb['certificateId']));
    const certificate = (await files().read(certificatePath)) as Buffer;
    expect(certificate.subarray(0, 5).toString()).toBe('%PDF-');
    expect(tomb['certificate']).toEqual({ storagePath: certificatePath, sha256: sha(certificate) });
    expect(mail.sent).toEqual([
      expect.objectContaining({
        to: `${OWNER}@example.test`,
        attachments: [expect.objectContaining({ contentType: 'application/pdf' })],
      }),
    ]);
    expect(oauth.calls).toContainEqual({ op: 'revoke', provider: 'microsoft' });

    // Nothing anywhere names the practice any more.
    expect(await traces(DELETED, certificatePath)).toEqual([]);

    // Lena keeps the other practice: its membership, her records of it, and her claims.
    expect((await db.doc(`orgs/${OTHER}/members/${LAWYER}`).get()).get('status')).toBe('active');
    expect((await db.doc(`users/${LAWYER}/recent/other-matter`).get()).exists).toBe(true);
    expect((await db.doc(`users/${LAWYER}`).get()).data()).toMatchObject({ orgIds: [OTHER], activeOrgId: OTHER });
    expect((await auth.getUser(LAWYER)).customClaims?.['orgs']).toEqual({ [OTHER]: 'lawyer' });
    expect((await db.doc(`users/${OWNER}`).get()).data()).toMatchObject({ orgIds: [], activeOrgId: null });
  });
});

describe('what stops a deletion', () => {
  const NAME = 'Fictional Held Legal';
  beforeEach(() => triggers(false));

  const hold = { on: true, reason: 'Fictional dispute over the estate', by: OWNER, at: new Date() };

  it('a legal hold, on a matter or on the practice, stops the deletion being asked for', async () => {
    await seedSmall(HELD, NAME, { [`orgs/${HELD}/matters/held-matter`]: { ...makeMatter(), legalHold: hold } });
    expect(await refusal(askToDelete(HELD, NAME, realClock))).toMatchObject({
      code: 'failed-precondition',
      details: { code: 'LEGAL_HOLD', matterId: 'held-matter' },
    });
    await db.doc(`orgs/${HELD}/matters/held-matter`).update({ legalHold: { on: false } });
    await db.doc(`orgs/${HELD}`).update({ legalHold: hold });
    expect(await refusal(askToDelete(HELD, NAME, realClock))).toMatchObject({
      details: { code: 'LEGAL_HOLD', scope: 'org' },
    });
    expect((await db.doc(`orgs/${HELD}`).get()).get('deletionScheduledAt')).toBeUndefined();
  });

  it('a legal hold placed during the grace period cancels the deletion when it falls due', async () => {
    await seedSmall(HELD, NAME);
    await askToDelete(HELD, NAME, new FakeClock(new Date(Date.now() - 31 * DAY)));
    await db.doc(`orgs/${HELD}/matters/matter-1`).update({ legalHold: hold });

    const deps: PurgeDeps = { db, files: files(), clock: realClock, log, ports: fakePorts(), auth: () => auth };
    expect(await purgeOrg(deps, HELD)).toEqual({ outcome: 'blocked', nextInMs: null });
    expect((await db.doc(`deletedOrgs/${HELD}`).get()).exists).toBe(false);
    expect((await db.doc(`orgs/${HELD}`).get()).get('deletionScheduledAt')).toBeUndefined();
    expect((await db.doc(`orgs/${HELD}/matters/matter-1`).get()).exists).toBe(true);
    const audit = await db.collection(`orgs/${HELD}/audit`).where('action', '==', 'org.deletion_blocked').get();
    expect(audit.size).toBe(1);
    const notice = await db.collection(`orgs/${HELD}/notifications`).where('recipientUid', '==', OWNER).get();
    expect(notice.docs.map((doc) => String(doc.get('title')))).toContainEqual(
      expect.stringContaining('wasn’t deleted'),
    );
  });

  it('an export being written stops the request, and postpones a deletion that is due', async () => {
    const NAME_BUSY = 'Fictional Busy Legal';
    const now = new Date();
    const exporting = {
      type: 'org.export',
      status: 'running',
      target: { kind: 'export', name: 'Fictional Busy Legal export' },
      heartbeatAt: now,
      updatedAt: now,
    };
    await seedSmall(BUSY, NAME_BUSY, { [`orgs/${BUSY}/jobs/export-1`]: exporting });
    expect(await refusal(askToDelete(BUSY, NAME_BUSY, realClock))).toMatchObject({
      code: 'failed-precondition',
      details: { code: 'EXPORT_RUNNING', jobId: 'export-1' },
    });

    // Asked once the export was done; another export is being written when the deletion falls due.
    await db.doc(`orgs/${BUSY}/jobs/export-1`).update({ status: 'succeeded' });
    await askToDelete(BUSY, NAME_BUSY, new FakeClock(new Date(Date.now() - 31 * DAY)));
    await db.doc(`orgs/${BUSY}/jobs/export-2`).set(exporting);
    const deps: PurgeDeps = { db, files: files(), clock: realClock, log, ports: fakePorts(), auth: () => auth };
    expect(await purgeOrg(deps, BUSY)).toEqual({ outcome: 'postponed', nextInMs: 60 * 60_000 });
    expect((await db.doc(`deletedOrgs/${BUSY}`).get()).exists).toBe(false);
    expect((await db.doc(`orgs/${BUSY}`).get()).get('deletionScheduledAt')).toBeDefined();
    expect((await db.doc(`orgs/${BUSY}/matters/matter-1`).get()).exists).toBe(true);
  });
});

describe('triggers in a practice being deleted', () => {
  it('leave it alone: a write landing while the job takes it apart is not audited, counted or copied', async () => {
    await triggers(false);
    await reset(GONE);
    await db
      .doc(`deletedOrgs/${GONE}`)
      .set({ ...makeDeletedOrg({ orgId: GONE, name: 'Fictional Gone Legal', status: 'purging', stage: 'firestore' }) });
    await triggers(true);

    await db.doc(`orgs/${GONE}/matters/late-matter`).set(retarget(makeMatter(), GONE) as Data);
    // Twice: the first marker's audit entry shows the matter's triggers were delivered (and the
    // audit trigger runs for a practice not being deleted); the second, that they have finished.
    await drain();
    await drain();
    expect((await db.doc(`orgs/${GONE}`).listCollections()).map((collection) => collection.id)).toEqual(['matters']);
    expect((await db.collection(`orgs/${GONE}/matters`).listDocuments()).map((doc) => doc.id)).toEqual(['late-matter']);
    await reset(GONE);
  });
});
