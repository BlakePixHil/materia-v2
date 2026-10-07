import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { FieldPath, FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  addDays,
  CLERK_DISCLOSURE_VERSION,
  today,
  type MatterBriefMode,
  type MatterBriefResult,
  type Role,
} from '@materia/domain';

import { anthropicKeyPath } from '../../src/clerk/keyring';
import { matterBriefDefinition, matterBriefPath } from '../../src/clerk/matter-brief';
import { FakeClerkModel } from '../../src/clerk/providers/fake';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { cachedMemberLookup } from '../../src/core/members';
import { FakeKms, fakePorts } from '../../src/ports/fakes';

/**
 * AI-06c against the Firestore emulator and the fake model: `clerk-matterBrief` reads a matter's
 * deadlines, tasks, feed, documents and suggestions through the Firestore source, has Clerk write
 * the brief, keeps it for everyone, writes the template once the feature is off, and refreshes
 * three times a day. A privileged document on this (non-privileged) matter never reaches the model.
 * The callable runs in this process. Fictional data only.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-clerk-matter-brief';
const MATTER = 'm-brief';
const CANARY = 'Thistlewaite counsel opinion';
const kms = new FakeKms();
const model = new FakeClerkModel();

let admin: App;
let db: Firestore;

const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const uidOf = (role: Role) => `ai06c-${role}`;
const day = () => today('Australia/Melbourne', new Date());
const matterPath = `orgs/${ORG}/matters/${MATTER}`;

function brief(mode: MatterBriefMode, role: Role = 'lawyer') {
  const clock = { now: () => new Date() };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts({ clerkModel: model, clerkKms: kms }),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    matterBriefDefinition as unknown as CallableDefinition<never, MatterBriefResult>,
    {
      data: { requestId: randomUUID(), matterId: MATTER, mode },
      auth: { uid: uidOf(role), token: { orgId: ORG, role } },
    },
    deps,
  );
}

const refsOf = (result: MatterBriefResult) =>
  result.brief.items.flatMap((item) => item.refs.map((ref) => `${ref.kind}:${ref.id}`));

async function setFeature(on: boolean): Promise<void> {
  await db.doc(`orgs/${ORG}`).update(new FieldPath('flags', 'clerk.features.matterBrief'), on);
  clearFlagCaches();
}

beforeAll(async () => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'clerk-matter-brief-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Thistlewaite Legal',
    timezone: 'Australia/Melbourne',
    flags: { 'clerk.enabled': true, 'clerk.features.matterBrief': true },
    settings: { clerk: { ackVersion: CLERK_DISCLOSURE_VERSION } },
  });
  const sealed = await kms.encrypt('sk-ant-fictional-brief-integration-0000', anthropicKeyPath(ORG));
  await db.doc(anthropicKeyPath(ORG)).set({
    provider: 'anthropic',
    uid: null,
    status: 'valid',
    scopes: [],
    encryptedApiKey: sealed.ciphertext,
    kmsKeyVersion: sealed.keyVersion,
    last4: '0000',
  });
  for (const role of ['lawyer', 'readonly'] as const)
    await db
      .doc(`orgs/${ORG}/members/${uidOf(role)}`)
      .set({ role, status: 'active', displayName: `Fictional ${role}` });
  await db.doc(matterPath).set({
    number: 'M-2026-0888',
    title: 'Estate of Fictional Thistlewaite',
    type: 'probate',
    status: 'open',
    privileged: false,
    deletedAt: null,
    ...meta,
  });
  const now = new Date();
  await db.doc(`${matterPath}/deadlines/dl-overdue`).set({
    title: 'Publish the notice of intention to apply',
    dueDate: addDays(day(), -3),
    status: 'upcoming',
    critical: false,
    deletedAt: null,
    ...meta,
  });
  await db.doc(`${matterPath}/deadlines/dl-filing`).set({
    title: 'File the probate application',
    dueDate: addDays(day(), 9),
    status: 'upcoming',
    critical: true,
    deletedAt: null,
    ...meta,
  });
  await db.doc(`${matterPath}/documents/doc-will`).set({
    name: 'Will of Fictional Thistlewaite.pdf',
    category: 'will',
    privileged: false,
    scan: { status: 'clean' },
    deletedAt: null,
    ...meta,
    createdAt: now,
  });
  await db.doc(`${matterPath}/documents/doc-advice`).set({
    name: `${CANARY}.pdf`,
    category: 'other',
    privileged: true,
    scan: { status: 'clean' },
    deletedAt: null,
    ...meta,
    createdAt: now,
  });
});

afterAll(async () => {
  clearFlagCaches();
  await deleteAdminApp(admin);
});

describe('Clerk matter brief (AI-06c)', () => {
  it('has Clerk write the brief from the matter’s facts, keeps it for everyone, and sends no privileged record', async () => {
    const first = await brief('open');
    expect(first).toMatchObject({ outcome: 'rebuilt', brief: { source: 'clerk', privileged: false, pending: false } });
    expect(refsOf(first)).toEqual(expect.arrayContaining(['deadline:dl-overdue', 'deadline:dl-filing']));
    expect(JSON.stringify(first)).not.toContain(CANARY);
    expect(JSON.stringify(model.requests.at(-1))).not.toContain(CANARY);

    const kept = (await db.doc(matterBriefPath(ORG, MATTER)).get()).data();
    expect(kept).toMatchObject({ source: 'clerk', generatedBy: uidOf('lawyer'), privileged: false });
    expect(kept?.['pendingUntil']).toBeUndefined();
    expect((await db.doc(`orgs/${ORG}/counters/clerk-matter-briefs`).get()).data()).toMatchObject({
      day: day(),
      count: 1,
    });

    // Read back through Firestore (Timestamps), the same brief is what a read-only member gets.
    const calls = model.requests.length;
    const shared = await brief('open', 'readonly');
    expect(shared).toMatchObject({ outcome: 'kept', brief: { source: 'clerk' } });
    expect(shared.brief.items).toEqual(first.brief.items);
    expect(model.requests).toHaveLength(calls);
  });

  it('writes the template once the feature is off, without calling Clerk', async () => {
    await setFeature(false);
    try {
      const calls = model.requests.length;
      const off = await brief('open');
      expect(off).toMatchObject({ outcome: 'rebuilt', brief: { source: 'template', reason: 'off' } });
      expect(refsOf(off)).toEqual(expect.arrayContaining(['deadline:dl-overdue', 'deadline:dl-filing']));
      expect(model.requests).toHaveLength(calls);
    } finally {
      await setFeature(true);
    }
  });

  it('refreshes three times a day per matter', async () => {
    for (const left of [2, 1, 0]) expect((await brief('refresh')).brief.refreshesLeft).toBe(left);
    await expect(brief('refresh')).rejects.toMatchObject({ details: { code: 'RATE_LIMITED' } });
    expect((await db.doc(matterBriefPath(ORG, MATTER)).get()).get('refreshes')).toEqual({ day: day(), count: 3 });
  });
});
