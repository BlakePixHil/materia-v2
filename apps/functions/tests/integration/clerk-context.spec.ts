import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { ContextManifestSchema, type Role } from '@materia/domain';

import { createContextBuilder, type ContextScope } from '../../src/clerk/context/build-context';
import { firestoreContextSource } from '../../src/clerk/context/firestore-source';
import {
  allStrings,
  CANARY,
  DOCUMENT_TEXT,
  fixtureOrgs,
  HITS,
  MATTER,
  ORG,
  OTHER_MATTER,
  OTHER_ORG,
  OTHER_ORG_MATTER,
  PRIVILEGED_MATTER,
  USERS,
} from '../../src/clerk/context/fixtures';
import { charEstimateCounter } from '../../src/clerk/context/ports';
import { FakeChunkSearch, FakeDocumentText } from '../../src/clerk/context/testing';
import { firestoreClerkStore } from '../../src/clerk/firestore-store';
import { createClerkGateway } from '../../src/clerk/gateway';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import { createLog } from '../../src/core/log';

/**
 * AI-03 acceptance tests on the Firestore emulator: `buildContext` with its real Firestore reads
 * over a seeded fictional matter whose privileged note, document and chunk carry the canary
 * `PRIV-CANARY-7731`, then the gateway storing the manifest on the message.
 */
const PROJECT_ID = 'demo-materia';
const HELLO_JSON = JSON.stringify({ greeting: 'Hello there.', promptRef: 'hello@1.0.0' });

let admin: App;
let db: Firestore;

const clock = { now: () => new Date('2026-10-04T22:30:00Z') };
const log = createLog({ fn: 'clerk-context-integration' }, () => undefined);

/** Writes the fixture practice (both orgs) to the emulator. */
async function seed() {
  for (const [orgId, org] of Object.entries(fixtureOrgs())) {
    await db.recursiveDelete(db.doc(`orgs/${orgId}`));
    const batch = db.bulkWriter();
    void batch.set(db.doc(`orgs/${orgId}`), {
      name: 'Fictional Context Practice',
      timezone: org.timezone ?? 'Australia/Melbourne',
    });
    for (const [uid, member] of Object.entries(org.members))
      void batch.set(db.doc(`orgs/${orgId}/members/${uid}`), member);
    for (const [id, name] of Object.entries(org.contacts ?? {})) {
      const [givenNames, ...family] = name.split(' ');
      void batch.set(db.doc(`orgs/${orgId}/contacts/${id}`), {
        kind: 'person',
        givenNames,
        familyName: family.join(' '),
      });
    }
    for (const [period, data] of Object.entries(org.metrics ?? {}))
      void batch.set(db.doc(`orgs/${orgId}/metrics/${period}`), data);
    for (const [matterId, matter] of Object.entries(org.matters)) {
      const path = `orgs/${orgId}/matters/${matterId}`;
      void batch.set(db.doc(path), matter.data);
      for (const name of ['parties', 'events', 'deadlines', 'tasks', 'notes', 'documents'] as const)
        for (const [id, data] of Object.entries(matter[name] ?? {}))
          void batch.set(db.doc(`${path}/${name}/${id}`), data);
    }
    await batch.close();
  }
}

function builder() {
  const chunks = new FakeChunkSearch(HITS);
  return {
    chunks,
    ...createContextBuilder({
      source: firestoreContextSource(db),
      chunks,
      documentText: new FakeDocumentText(DOCUMENT_TEXT),
      tokens: charEstimateCounter,
    }),
  };
}

const ctx = (role: Role, uid: string = USERS[role as keyof typeof USERS]) => ({
  orgId: ORG,
  uid,
  role,
  requestId: randomUUID(),
  log,
  clock,
});

const build = (role: Role, over: { scope?: ContextScope; attachments?: string[]; query?: string; uid?: string } = {}) =>
  builder().buildContext({
    ctx: ctx(role, over.uid),
    scope: over.scope ?? { matterId: MATTER },
    feature: 'chat',
    ...(over.attachments ? { attachments: over.attachments } : {}),
    ...(over.query ? { query: over.query } : {}),
  });

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'clerk-context-integration-admin');
  db = getAdminFirestore(admin);
});

beforeEach(seed);

afterAll(async () => {
  await deleteAdminApp(admin);
});

describe('buildContext on Firestore', () => {
  it('gives a lawyer the privileged note, attachment and chunk, and a privileged manifest', async () => {
    const result = await build('lawyer', { attachments: ['d-will', 'd-advice'], query: 'who gets the residue?' });
    expect(allStrings(result).join('\n')).toContain(CANARY);
    expect(result.manifest.privileged).toBe(true);
    expect(result.manifest.documents).toEqual([
      { documentId: 'd-will', version: 2 },
      { documentId: 'd-advice', version: 1 },
    ]);
    expect(ContextManifestSchema.safeParse(result.manifest).success).toBe(true);
  });

  it('never puts privileged text in a paralegal context (every string checked)', async () => {
    const result = await build('paralegal', { attachments: ['d-will'], query: 'who gets the residue?' });
    for (const value of allStrings(result)) expect(value).not.toContain(CANARY);
    expect(result.manifest.privileged).toBe(false);
    expect(result.manifest.records.map((record) => record.id)).toEqual(
      expect.arrayContaining(['n-public', 'n-long', 'n-injection']),
    );
    expect(result.manifest.records.map((record) => record.id)).not.toContain('n-privileged');
    await expect(build('paralegal', { attachments: ['d-advice'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads the matter facts from Firestore: parties by name, deadline traces, top 30 open tasks', async () => {
    const result = await build('lawyer');
    const facts = result.contextBlocks.stable[0];
    const text = facts?.type === 'text' ? facts.text : '';
    expect(text).toContain('"name":"Quinn Ashdown"');
    expect(text).toContain('+ 6 months → 2026-11-02');
    expect(result.manifest.records.filter((record) => record.kind === 'task')).toHaveLength(30);
    expect(result.manifest.records.find((record) => record.kind === 'matter')?.at).toBe('2026-09-01T00:00:00.000Z');
    expect(text).not.toContain('email-token-never-shown');
  });

  it('rejects cross-org and cross-matter ids', async () => {
    await expect(build('lawyer', { scope: { matterId: OTHER_ORG_MATTER } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(build('lawyer', { attachments: ['d-other'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(build('lawyer', { attachments: [`../../${OTHER_MATTER}/documents/d-other`] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    // The other org's matter exists, under its own org only.
    expect((await db.doc(`orgs/${OTHER_ORG}/matters/${OTHER_ORG_MATTER}`).get()).exists).toBe(true);
  });

  it('hides a privileged matter from a paralegal', async () => {
    await expect(build('paralegal', { scope: { matterId: PRIVILEGED_MATTER } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('aborts with ACCESS_REVOKED when the member is suspended after the request', async () => {
    await db.doc(`orgs/${ORG}/members/${USERS.lawyer}`).update({ status: 'suspended' });
    await expect(build('lawyer')).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
  });

  it('leaves out documents still processing and says how many', async () => {
    const result = await build('lawyer', { attachments: ['d-will', 'd-scanning', 'd-ingesting'] });
    expect(result.manifest.processing).toBe(2);
    expect(result.manifest.notices).toContain('2 documents still processing and not included.');
  });
});

describe('ClerkGateway with a built context on Firestore', () => {
  it('stores the manifest on the message, marks it privileged and returns the truncation', async () => {
    const thread = db.collection(`orgs/${ORG}/clerkThreads`).doc();
    const at = new Date();
    await thread.set({
      title: 'Context thread',
      ownerUid: USERS.lawyer,
      matterId: MATTER,
      shared: false,
      createdAt: at,
      createdBy: USERS.lawyer,
      updatedAt: at,
      updatedBy: USERS.lawyer,
      schemaVersion: 1,
    });
    const messageId = thread.collection('messages').doc().id;
    const context = await build('lawyer', { query: 'prospects' });
    const gateway = createClerkGateway({
      model: new FakeClerkModel([{ chunks: [HELLO_JSON] }]),
      store: firestoreClerkStore(db),
      flag: async () => true,
      sleep: async () => undefined,
    });
    const result = await gateway.run({
      ctx: ctx('lawyer'),
      feature: 'hello',
      promptId: 'hello',
      vars: { name: 'the team', promptRef: 'hello@1.0.0' },
      context,
      stream: { threadId: thread.id, messageId },
    });
    expect(result).toMatchObject({ status: 'done', privileged: true, truncated: null });

    const stored = (await thread.collection('messages').doc(messageId).get()).data();
    expect(stored?.['privileged']).toBe(true);
    expect(stored?.['manifest']).toEqual(context.manifest);
    expect(ContextManifestSchema.safeParse(stored?.['manifest']).success).toBe(true);
    for (const value of allStrings(stored?.['manifest'])) expect(value).not.toContain(CANARY);
  });
});
